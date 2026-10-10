CREATE OR REPLACE FUNCTION public.sync_external_event(
  p_event_id uuid,
  p_title text,
  p_description text,
  p_category text,
  p_source_condition_id text,
  p_source_volume_usd numeric,
  p_source_liquidity_usd numeric,
  p_source_updated_at timestamptz,
  p_yes_price numeric,
  p_no_price numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_locked_id uuid;
  v_has_trades boolean;
  v_target_pool numeric(24,2);
  v_yes_weight numeric;
  v_no_weight numeric;
  v_yes_pool numeric(24,2);
  v_no_pool numeric(24,2);
BEGIN
  SELECT id INTO v_locked_id
  FROM public.events
  WHERE id = p_event_id AND source_platform = 'polymarket'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT EXISTS (SELECT 1 FROM public.bets b WHERE b.event_id = v_locked_id)
  INTO v_has_trades;

  v_target_pool := ROUND(GREATEST(COALESCE(p_source_liquidity_usd, 0), 0) / 5, 2);
  v_yes_weight := GREATEST(COALESCE(p_yes_price, 0.5), 0.01);
  v_no_weight := GREATEST(COALESCE(p_no_price, 0.5), 0.01);
  v_yes_pool := ROUND(v_target_pool * (v_yes_weight / (v_yes_weight + v_no_weight)), 2);
  v_no_pool := ROUND(v_target_pool - v_yes_pool, 2);

  UPDATE public.events e
  SET title = p_title,
      description = p_description,
      category = p_category,
      source_condition_id = p_source_condition_id,
      polymarket_source_volume_usd = ROUND(GREATEST(COALESCE(p_source_volume_usd, 0), 0), 2),
      polymarket_source_liquidity_usd = ROUND(GREATEST(COALESCE(p_source_liquidity_usd, 0), 0), 2),
      polymarket_source_updated_at = p_source_updated_at,
      polymarket_synced_at = now(),
      simulated_volume_usd = NULL,
      total_yes_pool = CASE WHEN NOT v_has_trades THEN v_yes_pool ELSE e.total_yes_pool END,
      total_no_pool = CASE WHEN NOT v_has_trades THEN v_no_pool ELSE e.total_no_pool END,
      cpmm_ry = CASE WHEN NOT v_has_trades THEN 500 + v_yes_pool ELSE e.cpmm_ry END,
      cpmm_rn = CASE WHEN NOT v_has_trades THEN 500 + v_no_pool ELSE e.cpmm_rn END
  WHERE e.id = v_locked_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_external_event(uuid,text,text,text,text,numeric,numeric,timestamptz,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_external_event(uuid,text,text,text,text,numeric,numeric,timestamptz,numeric,numeric) TO service_role;
