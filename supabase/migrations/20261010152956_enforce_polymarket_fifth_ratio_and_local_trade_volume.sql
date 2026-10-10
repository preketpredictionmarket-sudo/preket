ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS polymarket_source_liquidity_usd NUMERIC(24,2),
  ADD COLUMN IF NOT EXISTS polymarket_source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS polymarket_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preket_trade_volume_usd NUMERIC(24,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.events.polymarket_source_liquidity_usd IS
  'Latest Polymarket source-market liquidity in USD. Displayed as source liquidity divided by five; separate from Preket local CPMM pool liquidity.';
COMMENT ON COLUMN public.events.preket_trade_volume_usd IS
  'Cumulative notional USD of Preket-local trade records (buy and sell rows), maintained by a bets trigger. Separate from Polymarket source volume.';
COMMENT ON COLUMN public.events.polymarket_source_updated_at IS
  'Source event/market updatedAt timestamp reported by Polymarket, when available.';
COMMENT ON COLUMN public.events.polymarket_synced_at IS
  'Timestamp when this event row was last reconciled with Polymarket source data.';

UPDATE public.events e
SET preket_trade_volume_usd = COALESCE((
  SELECT ROUND(SUM(b.amount_usd), 2) FROM public.bets b WHERE b.event_id = e.id
), 0);

-- Legacy synthetic numbers must not be used as a fallback for displayed volume.
UPDATE public.events SET simulated_volume_usd = NULL WHERE simulated_volume_usd IS NOT NULL;

CREATE OR REPLACE FUNCTION public.maintain_preket_trade_volume()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.events
    SET preket_trade_volume_usd = GREATEST(0, COALESCE(preket_trade_volume_usd, 0) + COALESCE(NEW.amount_usd, 0))
    WHERE id = NEW.event_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.events
    SET preket_trade_volume_usd = GREATEST(0, COALESCE(preket_trade_volume_usd, 0) - COALESCE(OLD.amount_usd, 0))
    WHERE id = OLD.event_id;
    RETURN OLD;
  ELSE
    IF OLD.event_id = NEW.event_id THEN
      UPDATE public.events
      SET preket_trade_volume_usd = GREATEST(0, COALESCE(preket_trade_volume_usd, 0) - COALESCE(OLD.amount_usd, 0) + COALESCE(NEW.amount_usd, 0))
      WHERE id = NEW.event_id;
    ELSE
      UPDATE public.events
      SET preket_trade_volume_usd = GREATEST(0, COALESCE(preket_trade_volume_usd, 0) - COALESCE(OLD.amount_usd, 0))
      WHERE id = OLD.event_id;
      UPDATE public.events
      SET preket_trade_volume_usd = GREATEST(0, COALESCE(preket_trade_volume_usd, 0) + COALESCE(NEW.amount_usd, 0))
      WHERE id = NEW.event_id;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

DROP TRIGGER IF EXISTS maintain_preket_trade_volume ON public.bets;
CREATE TRIGGER maintain_preket_trade_volume
AFTER INSERT OR DELETE OR UPDATE OF event_id, amount_usd
ON public.bets
FOR EACH ROW EXECUTE FUNCTION public.maintain_preket_trade_volume();

CREATE OR REPLACE FUNCTION public.import_external_event(
  p_source_platform text,
  p_source_event_id text,
  p_source_condition_id text,
  p_title text,
  p_description text,
  p_category text,
  p_yes_price numeric,
  p_no_price numeric,
  p_initial_liquidity_usd numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_house_id UUID;
  v_house_balance NUMERIC(24,2);
  v_seed_liquidity NUMERIC(24,2);
  v_yes_w NUMERIC;
  v_no_w NUMERIC;
  v_yes_pool NUMERIC(24,2);
  v_no_pool NUMERIC(24,2);
  v_event_id UUID;
BEGIN
  IF p_initial_liquidity_usd IS NULL OR p_initial_liquidity_usd < 0 THEN
    RAISE EXCEPTION 'Invalid liquidity amount';
  END IF;

  -- Deterministic initial local pool seed; source liquidity is stored separately
  -- and displayed as Polymarket liquidity / 5. No randomized volume or liquidity.
  v_seed_liquidity := ROUND(p_initial_liquidity_usd, 2);

  SELECT id, balance_usd INTO v_house_id, v_house_balance
  FROM public.users
  WHERE role = 'admin'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'No house/admin account found'; END IF;
  IF v_house_balance < v_seed_liquidity THEN
    RAISE EXCEPTION 'Insufficient house balance for source-ratio seed liquidity';
  END IF;

  v_yes_w := GREATEST(COALESCE(p_yes_price, 0.5), 0.01);
  v_no_w := GREATEST(COALESCE(p_no_price, 0.5), 0.01);
  v_yes_pool := ROUND(v_seed_liquidity * (v_yes_w / (v_yes_w + v_no_w)), 2);
  v_no_pool := v_seed_liquidity - v_yes_pool;

  INSERT INTO public.events (
    title, description, category, status,
    total_yes_pool, total_no_pool, cpmm_ry, cpmm_rn,
    source_platform, source_event_id, source_condition_id,
    simulated_volume_usd, preket_trade_volume_usd
  )
  VALUES (
    p_title, p_description, p_category, 'active',
    v_yes_pool, v_no_pool, 500 + v_yes_pool, 500 + v_no_pool,
    p_source_platform, p_source_event_id, p_source_condition_id,
    NULL, 0
  )
  ON CONFLICT (source_platform, source_event_id)
    WHERE source_platform IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NOT NULL AND v_seed_liquidity > 0 THEN
    UPDATE public.users SET balance_usd = balance_usd - v_seed_liquidity WHERE id = v_house_id;
  END IF;

  RETURN v_event_id;
END;
$function$;
