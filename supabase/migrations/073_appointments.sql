-- ============================================================
-- 073: appointments
--
-- A business takes bookings on a WhatsApp number: the customer asks in
-- plain words, the AI turns that into a date and time, and the portal
-- — never the model — decides whether the slot is free and books it.
--
--   appointment_settings  one row per WhatsApp number: on/off, working
--                         hours, slot length, how many customers share
--                         a slot, the address, the timezone, and when
--                         (or whether) to remind.
--   appointments          the bookings. `phone_key` is the last 10
--                         digits of the customer's number; a customer
--                         only ever sees rows with their own key.
--
-- `book_appointment()` is the single way a booking is written. It takes
-- a per-number lock, so two customers asking for the last place in a
-- slot at the same moment cannot both get it, and it enforces "one
-- live (future) appointment per phone number".
--
-- Reminders are sent by the scheduler that already runs every 15
-- minutes (migration 069); it reads `reminder_at`.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS appointment_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL UNIQUE REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  business_name TEXT,
  address       TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  slot_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 480),
  slot_capacity INTEGER NOT NULL DEFAULT 1 CHECK (slot_capacity BETWEEN 1 AND 100),
  days_ahead    INTEGER NOT NULL DEFAULT 30 CHECK (days_ahead BETWEEN 1 AND 365),
  -- {"1": [["10:00","13:00"],["16:00","20:00"]], ...}; key = day of the
  -- week, 0 Sunday … 6 Saturday. A missing or empty day is closed.
  hours         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- ["2026-12-25", ...] — closed dates, in the business's own calendar.
  holidays      JSONB NOT NULL DEFAULT '[]'::jsonb,
  reminder_mode TEXT NOT NULL DEFAULT 'same_day'
                  CHECK (reminder_mode IN ('none', 'same_day', 'day_before')),
  reminder_time TEXT NOT NULL DEFAULT '09:00',
  -- WhatsApp Business API numbers only: approved templates to use when
  -- a plain message is not allowed (outside the 24-hour window).
  confirm_template           TEXT,
  confirm_template_language  TEXT,
  reminder_template          TEXT,
  reminder_template_language TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id       UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  phone_key        TEXT NOT NULL,
  customer_name    TEXT,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),
  source           TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('ai', 'portal')),
  -- Filled in by the business; the customer can ask for them later.
  treatment        TEXT,
  medicine         TEXT,
  notes            TEXT,
  reminder_at      TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  reminder_error   TEXT,
  created_by       UUID,
  cancelled_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_channel_start
  ON appointments (channel_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_phone
  ON appointments (channel_id, phone_key, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments (reminder_at)
  WHERE status = 'booked' AND reminder_sent_at IS NULL AND reminder_at IS NOT NULL;

ALTER TABLE appointment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

-- Members read their account's rows. Every write goes through the API
-- with the service role (which enforces the booking rules), so there is
-- no INSERT / UPDATE / DELETE policy.
DROP POLICY IF EXISTS appointment_settings_select ON appointment_settings;
CREATE POLICY appointment_settings_select ON appointment_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));

REVOKE INSERT, UPDATE, DELETE ON appointment_settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON appointments FROM anon, authenticated;

-- ------------------------------------------------------------
-- The one way to book (or move) an appointment.
--
-- p_replace_id NULL  → a new booking.
-- p_replace_id given → move that appointment to the new time.
--
-- Raises 'has_live_appointment' when the phone number already holds a
-- future booking, and 'slot_full' when the slot has no place left.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_appointment(
  p_account_id      UUID,
  p_channel_id      UUID,
  p_contact_id      UUID,
  p_conversation_id UUID,
  p_phone_key       TEXT,
  p_customer_name   TEXT,
  p_starts_at       TIMESTAMPTZ,
  p_ends_at         TIMESTAMPTZ,
  p_capacity        INTEGER,
  p_source          TEXT,
  p_created_by      UUID,
  p_reminder_at     TIMESTAMPTZ,
  p_replace_id      UUID DEFAULT NULL
)
RETURNS appointments
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_taken INTEGER;
  v_row   appointments;
BEGIN
  -- One booking at a time per WhatsApp number.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_channel_id::text, 73));

  IF EXISTS (
    SELECT 1 FROM appointments a
     WHERE a.channel_id = p_channel_id
       AND a.phone_key = p_phone_key
       AND a.status = 'booked'
       AND a.starts_at > now()
       AND (p_replace_id IS NULL OR a.id <> p_replace_id)
  ) THEN
    RAISE EXCEPTION 'has_live_appointment';
  END IF;

  SELECT count(*) INTO v_taken
    FROM appointments a
   WHERE a.channel_id = p_channel_id
     AND a.status = 'booked'
     AND a.starts_at < p_ends_at
     AND a.ends_at > p_starts_at
     AND (p_replace_id IS NULL OR a.id <> p_replace_id);
  IF v_taken >= greatest(p_capacity, 1) THEN
    RAISE EXCEPTION 'slot_full';
  END IF;

  IF p_replace_id IS NOT NULL THEN
    UPDATE appointments a
       SET starts_at = p_starts_at,
           ends_at = p_ends_at,
           reminder_at = p_reminder_at,
           reminder_sent_at = NULL,
           reminder_error = NULL,
           updated_at = now()
     WHERE a.id = p_replace_id
       AND a.account_id = p_account_id
       AND a.channel_id = p_channel_id
       AND a.status = 'booked'
    RETURNING a.* INTO v_row;
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'appointment_not_found';
    END IF;
    RETURN v_row;
  END IF;

  INSERT INTO appointments (
    account_id, channel_id, contact_id, conversation_id, phone_key, customer_name,
    starts_at, ends_at, source, created_by, reminder_at
  ) VALUES (
    p_account_id, p_channel_id, p_contact_id, p_conversation_id, p_phone_key, p_customer_name,
    p_starts_at, p_ends_at, p_source, p_created_by, p_reminder_at
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.book_appointment(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, UUID, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_appointment(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, UUID, TIMESTAMPTZ, UUID
) TO service_role;
