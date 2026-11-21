-- ============================================================
-- 074: appointment extras
--
--   appointment_settings.reply_language  the language the assistant
--       answers in: 'auto' (the customer's own) or a fixed one.
--   appointments.attachments             up to five documents (images
--       or PDFs) the business adds when closing a visit:
--       [{ "url": ..., "name": ..., "mime": ... }]
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS reply_language TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
