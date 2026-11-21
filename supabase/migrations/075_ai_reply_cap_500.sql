-- ============================================================
-- 075: the AI agent's "max auto-replies per conversation" may be set up
-- to 500 (it was capped at 20).
--
-- A long back-and-forth — or a customer who comes back every few weeks
-- — reached 20 quickly, after which the agent stayed silent in that
-- chat. The limit is still there to stop a runaway loop; the business
-- now chooses how high.
--
-- The CHECK was created inline in 029 without a name, so it is found by
-- what it checks rather than by a guessed name.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.ai_configs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%auto_reply_max_per_conversation%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_configs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 500);
