-- ============================================================
-- 079: business branding
--
--   accounts.brand_enabled / brand_name / brand_logo_url
--       A business can show its own name and one logo at the top of
--       the portal, with the product name small underneath. Off by
--       default: the portal looks exactly as before until it is
--       switched on.
--   appointment_settings.send_brand_logo
--       Send that logo as the picture of the appointment confirmation
--       (confirmations only, and only when switched on).
--
-- No RLS change: `accounts_update` already limits changes to admins.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS brand_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS brand_name     TEXT,
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;

ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS send_brand_logo BOOLEAN NOT NULL DEFAULT false;
