-- ============================================================
-- 066: broadcasts can carry a plain-text message (WhatsApp Web numbers)
--
-- A broadcast was always a Meta template. A WhatsApp Web channel has
-- no templates, so a campaign from one is a free-text message instead:
-- `message_text` holds it (with `{{name}}` substituted per recipient)
-- and `template_name` is '' for such rows. Delivery on a bridge is
-- paced (one message a second) and capped per request to stay well
-- inside what a personal number can send without being flagged.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS message_text TEXT;

ALTER TABLE broadcasts ALTER COLUMN template_name SET DEFAULT '';

COMMENT ON COLUMN broadcasts.message_text IS
  'Free-text message for broadcasts sent from a WhatsApp Web (bridge) number; NULL for template broadcasts. {{name}} is replaced per recipient.';
