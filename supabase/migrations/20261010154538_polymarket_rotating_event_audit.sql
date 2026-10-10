ALTER TABLE public.events ADD COLUMN IF NOT EXISTS polymarket_audit_checked_at TIMESTAMPTZ;
COMMENT ON COLUMN public.events.polymarket_audit_checked_at IS 'Last attempt to re-fetch this source event by ID during the rotating reconciliation audit.';
