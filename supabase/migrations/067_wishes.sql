-- ============================================================
-- 067: automated wishes (birthdays, anniversaries, …)
--
-- Two tables:
--
--   contact_wishes   — one per contact: the day + month to wish them,
--                      the number it goes out on, and the message —
--                      free text for a WhatsApp Web number, an approved
--                      template (+ params) for a Business API number,
--                      since Meta refuses free text outside the 24-hour
--                      window. `last_sent_year` makes a wish go out at
--                      most once per year however often the schedule
--                      runs.
--   wish_schedules   — one per number: when its wishes are checked
--                      (hourly / daily / weekly / monthly / yearly, at a
--                      time of day in a time zone). A run sends every
--                      enabled wish on that number whose date fell since
--                      the previous run, so a weekly schedule still
--                      catches a mid-week birthday.
--
-- A scheduler (Vercel cron or an n8n Schedule node) calls
-- GET /api/wishes/cron hourly with the shared secret; due schedules run.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_wishes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id       UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  month            INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day              INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  message_text     TEXT,
  template_name    TEXT,
  template_language TEXT,
  template_params  JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_sent_year   INTEGER,
  last_sent_at     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_wishes_account_channel_idx
  ON contact_wishes (account_id, channel_id) WHERE enabled;

ALTER TABLE contact_wishes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_wishes_select ON contact_wishes;
CREATE POLICY contact_wishes_select ON contact_wishes FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_wishes_insert ON contact_wishes;
CREATE POLICY contact_wishes_insert ON contact_wishes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_wishes_update ON contact_wishes;
CREATE POLICY contact_wishes_update ON contact_wishes FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_wishes_delete ON contact_wishes;
CREATE POLICY contact_wishes_delete ON contact_wishes FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON contact_wishes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_wishes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS wish_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL UNIQUE REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  frequency     TEXT NOT NULL DEFAULT 'daily'
                  CHECK (frequency IN ('hourly', 'daily', 'weekly', 'monthly', 'yearly')),
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  time_of_day   TEXT NOT NULL DEFAULT '09:00',
  day_of_week   INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month  INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  month         INTEGER CHECK (month BETWEEN 1 AND 12),
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  last_result   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wish_schedules_due_idx
  ON wish_schedules (next_run_at) WHERE enabled;

ALTER TABLE wish_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wish_schedules_select ON wish_schedules;
CREATE POLICY wish_schedules_select ON wish_schedules FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS wish_schedules_insert ON wish_schedules;
CREATE POLICY wish_schedules_insert ON wish_schedules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS wish_schedules_update ON wish_schedules;
CREATE POLICY wish_schedules_update ON wish_schedules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS wish_schedules_delete ON wish_schedules;
CREATE POLICY wish_schedules_delete ON wish_schedules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON wish_schedules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON wish_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
