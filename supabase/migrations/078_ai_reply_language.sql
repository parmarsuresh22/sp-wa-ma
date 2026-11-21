-- ============================================================
-- 078: the AI agent's reply language
--
-- ai_configs.reply_language — 'auto' (answer in the customer's own
-- language, as before) or one fixed language, the same list the
-- appointment assistant offers.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS reply_language TEXT NOT NULL DEFAULT 'auto';
