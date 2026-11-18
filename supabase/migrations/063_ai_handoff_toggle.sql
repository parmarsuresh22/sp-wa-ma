-- ============================================================
-- 063: make the AI auto-reply's human handoff optional
--
-- The auto-reply scaffold always taught the model to answer with the
-- handoff sentinel when a customer asks for a person, is upset, or asks
-- something it cannot answer — and then paused the bot on that thread.
-- A business running the bot as a first-line assistant that should
-- always say *something* (and leave the human follow-up to the inbox)
-- had no way to turn that off; a system prompt saying "never hand off"
-- lost to the scaffold.
--
-- `handoff_enabled = false`: the scaffold tells the model to always
-- answer briefly and kindly instead, and a stray sentinel never pauses
-- the thread.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN ai_configs.handoff_enabled IS
  'When true (default) the auto-reply hands the thread to a human when it cannot help and pauses itself there. When false it always answers and never pauses.';
