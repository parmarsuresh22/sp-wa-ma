-- ============================================================
-- 060_ai_gemini.sql — Google Gemini as a native AI provider
--
-- Adds 'gemini' to the provider allow-lists on `ai_configs` and
-- `ai_usage_log`. Everything else (encrypted key, model free text,
-- usage logging) is provider-agnostic already. The adapter lives in
-- src/lib/ai/providers/gemini.ts and talks to Gemini's OpenAI-compatible
-- endpoint, so no new columns are needed; `base_url` stays NULL for it
-- exactly like the other native providers.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible', 'gemini'));
