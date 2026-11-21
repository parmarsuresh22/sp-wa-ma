-- ============================================================
-- 076: booking confirmation, pre-booking questions, and which parts of
-- the portal a team member may see
--
-- Appointments
--   appointment_settings.confirm_required  a booking made in chat waits
--       as 'pending' until the business confirms it.
--   appointment_settings.ask_requirements / ask_address /
--       custom_questions  what the assistant must ask before booking.
--   appointments.status gains 'pending'; a pending booking holds its
--       slot and counts as the customer's one upcoming appointment.
--   appointments.details  the customer's answers:
--       { "requirements": ..., "address": ..., "answers": [{q, a}] }
--   book_appointment() takes the status and the details.
--
-- Team members
--   profiles.allowed_sections / account_invitations.allowed_sections
--       NULL = the whole portal; otherwise the sections this member may
--       open (inbox, contacts, appointments, ...). Owners and admins
--       always see everything.
--   member_can_see() + RESTRICTIVE select policies make that real at
--       the database, not just in the menu: a member without "inbox"
--       cannot read a single conversation or message, whatever the
--       browser asks for.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Appointments
-- ------------------------------------------------------------
ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS confirm_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ask_requirements BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ask_address      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_questions JSONB   NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.appointments'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%no_show%'
  LOOP
    EXECUTE format('ALTER TABLE public.appointments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending', 'booked', 'completed', 'cancelled', 'no_show'));

DROP INDEX IF EXISTS idx_appointments_reminder_due;
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments (reminder_at)
  WHERE status = 'booked' AND reminder_sent_at IS NULL AND reminder_at IS NOT NULL;

-- The 13-argument version from 073 is replaced (two versions that both
-- accept the same named arguments would be ambiguous).
DROP FUNCTION IF EXISTS public.book_appointment(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, UUID, TIMESTAMPTZ, UUID
);

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
  p_replace_id      UUID DEFAULT NULL,
  p_status          TEXT DEFAULT 'booked',
  p_details         JSONB DEFAULT '{}'::jsonb
)
RETURNS appointments
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_taken INTEGER;
  v_row   appointments;
BEGIN
  IF p_status NOT IN ('booked', 'pending') THEN
    RAISE EXCEPTION 'bad_status';
  END IF;

  -- One booking at a time per WhatsApp number.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_channel_id::text, 73));

  -- A request waiting for confirmation counts: it holds the slot and is
  -- the customer's one upcoming appointment.
  IF EXISTS (
    SELECT 1 FROM appointments a
     WHERE a.channel_id = p_channel_id
       AND a.phone_key = p_phone_key
       AND a.status IN ('booked', 'pending')
       AND a.starts_at > now()
       AND (p_replace_id IS NULL OR a.id <> p_replace_id)
  ) THEN
    RAISE EXCEPTION 'has_live_appointment';
  END IF;

  SELECT count(*) INTO v_taken
    FROM appointments a
   WHERE a.channel_id = p_channel_id
     AND a.status IN ('booked', 'pending')
     AND a.starts_at < p_ends_at
     AND a.ends_at > p_starts_at
     AND (p_replace_id IS NULL OR a.id <> p_replace_id);
  IF v_taken >= greatest(p_capacity, 1) THEN
    RAISE EXCEPTION 'slot_full';
  END IF;

  IF p_replace_id IS NOT NULL THEN
    -- Moving keeps the booking's own status unless one is given
    -- (confirming a request at a new time passes 'booked').
    UPDATE appointments a
       SET starts_at = p_starts_at,
           ends_at = p_ends_at,
           status = p_status,
           reminder_at = p_reminder_at,
           reminder_sent_at = NULL,
           reminder_error = NULL,
           updated_at = now()
     WHERE a.id = p_replace_id
       AND a.account_id = p_account_id
       AND a.channel_id = p_channel_id
       AND a.status IN ('booked', 'pending')
    RETURNING a.* INTO v_row;
    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'appointment_not_found';
    END IF;
    RETURN v_row;
  END IF;

  INSERT INTO appointments (
    account_id, channel_id, contact_id, conversation_id, phone_key, customer_name,
    starts_at, ends_at, source, created_by, reminder_at, status, details
  ) VALUES (
    p_account_id, p_channel_id, p_contact_id, p_conversation_id, p_phone_key, p_customer_name,
    p_starts_at, p_ends_at, p_source, p_created_by, p_reminder_at, p_status, coalesce(p_details, '{}'::jsonb)
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.book_appointment(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, UUID, TIMESTAMPTZ, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_appointment(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, UUID, TIMESTAMPTZ, UUID, TEXT, JSONB
) TO service_role;

-- ------------------------------------------------------------
-- Which sections a member may see
-- ------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allowed_sections TEXT[];
ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS allowed_sections TEXT[];

COMMENT ON COLUMN profiles.allowed_sections IS
  'NULL = every section. Otherwise the portal sections this member may open. Ignored for owners and admins.';

-- A member must not be able to widen their own access: only the server
-- (service role, no auth.uid()) may change this column.
CREATE OR REPLACE FUNCTION public.protect_allowed_sections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.allowed_sections IS DISTINCT FROM OLD.allowed_sections AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'allowed_sections can only be changed by an account admin';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_allowed_sections ON profiles;
CREATE TRIGGER trg_protect_allowed_sections
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_allowed_sections();

-- True when the signed-in member may see at least one of the sections.
-- Owners, admins and members with no restriction see everything.
CREATE OR REPLACE FUNCTION public.member_can_see(p_sections TEXT[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.account_role IN ('owner', 'admin')
            OR p.allowed_sections IS NULL
            OR p.allowed_sections && p_sections
       FROM profiles p
      WHERE p.user_id = auth.uid()),
    true
  )
$$;

REVOKE ALL ON FUNCTION public.member_can_see(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.member_can_see(TEXT[]) TO authenticated, service_role;

-- RESTRICTIVE policies are ANDed with the existing ones: a row must
-- still belong to the member's account, and now also to a section they
-- may open. The (SELECT ...) wrapper makes Postgres evaluate the check
-- once per query, not once per row.
DROP POLICY IF EXISTS conversations_section_gate ON conversations;
CREATE POLICY conversations_section_gate ON conversations AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['inbox'])));

DROP POLICY IF EXISTS messages_section_gate ON messages;
CREATE POLICY messages_section_gate ON messages AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['inbox'])));

-- Contacts are needed by the inbox, the contact book and appointments.
DROP POLICY IF EXISTS contacts_section_gate ON contacts;
CREATE POLICY contacts_section_gate ON contacts AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['contacts', 'inbox', 'appointments', 'broadcasts', 'pipelines'])));

DROP POLICY IF EXISTS appointments_section_gate ON appointments;
CREATE POLICY appointments_section_gate ON appointments AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['appointments'])));

DROP POLICY IF EXISTS posts_section_gate ON posts;
CREATE POLICY posts_section_gate ON posts AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['posts'])));

DROP POLICY IF EXISTS broadcasts_section_gate ON broadcasts;
CREATE POLICY broadcasts_section_gate ON broadcasts AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['broadcasts'])));
