-- ============================================================
-- 086: Answer only when woken
--
-- Some businesses run on a personal WhatsApp number, so the same
-- number gets family and friends as well as customers. With
-- `wake_mode` on, the Appointment assistant and the AI agent of that
-- number stay silent in a chat until the customer writes one of the
-- business's wake words ("appointment", "booking"…). The chat then
-- stays awake for `wake_minutes` after its last message and goes back
-- to sleep; other chats are not affected. A contact tagged "Personal"
-- is never auto-answered.
--
-- Off by default: a number answers every chat, as before, until its
-- business switches this on in the Appointments settings.
-- ============================================================

ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS wake_mode BOOLEAN NOT NULL DEFAULT false,
  -- Empty = the portal's suggested words.
  ADD COLUMN IF NOT EXISTS wake_words TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS wake_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (wake_minutes BETWEEN 5 AND 1440);

-- Until when the assistants answer in this chat; NULL or past = asleep.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assistant_awake_until TIMESTAMPTZ;
