-- ============================================================
-- 080: Event passes with a QR code
--
-- A business creates an event (concert, wedding, dinner, meet-up) with
-- one or more pass types, each with its own price and number of places.
-- A customer asks for passes in the WhatsApp chat (or the business
-- issues them from the portal). A paid pass is paid to the business's
-- own UPI ID: the chat sends a UPI QR with the amount filled in, the
-- customer sends back the payment screenshot, the portal reads it and
-- either issues the pass or leaves it for a person to approve. Every
-- pass is one QR code that the portal's scanner admits once.
--
--   events            the occasion, its payment and approval settings
--   event_pass_types  "General – free – 200 places", "VIP – ₹500 – 50"
--   event_orders      one request for N passes, and its payment proof
--   event_passes      one row (one QR code) per person
--   event_scans       every scan at the gate, good or bad
--
-- All writes go through the server (service role). Members read their
-- own account's rows, and only when they may open the "events" section.
-- ============================================================

CREATE TABLE IF NOT EXISTS events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id      UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  -- Short name the chat assistant uses for the event ("EV4K7Q").
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  venue           TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Passes can be requested until then (NULL = until the event starts).
  apply_until     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  -- Customers may ask for passes in the chat.
  chat_booking    BOOLEAN NOT NULL DEFAULT true,
  max_per_phone   INTEGER NOT NULL DEFAULT 5 CHECK (max_per_phone BETWEEN 1 AND 50),
  -- Where a paid pass is paid to.
  upi_id          TEXT,
  upi_name        TEXT,
  -- Issue the pass as soon as the screenshot passes the checks, without
  -- waiting for a person.
  auto_issue      BOOLEAN NOT NULL DEFAULT false,
  -- How long an unpaid request keeps its places.
  hold_minutes    INTEGER NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 5 AND 1440),
  -- WhatsApp number that is told about payments waiting for approval.
  notify_phone    TEXT,
  -- Remind pass holders this many hours before the start (0 = never).
  reminder_hours  INTEGER NOT NULL DEFAULT 0 CHECK (reminder_hours BETWEEN 0 AND 168),
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, code)
);
CREATE INDEX IF NOT EXISTS events_channel_idx ON events (channel_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS event_pass_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 1, 2, 3… — what the chat assistant calls the type.
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  price       NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (event_id, position)
);

CREATE TABLE IF NOT EXISTS event_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  pass_type_id     UUID NOT NULL REFERENCES event_pass_types(id) ON DELETE RESTRICT,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  phone_key        TEXT NOT NULL,
  customer_name    TEXT,
  -- Short order number shown to the customer and put in the UPI note.
  code             TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  amount           NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  --   awaiting_payment  places held until expires_at
  --   review            proof received, a person must approve
  --   issued            passes sent
  --   rejected          proof refused
  --   cancelled         given up by the customer or the business
  status           TEXT NOT NULL DEFAULT 'awaiting_payment'
                   CHECK (status IN ('awaiting_payment', 'review', 'issued', 'rejected', 'cancelled')),
  source           TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'portal')),
  expires_at       TIMESTAMPTZ,
  -- The UPI reference number (UTR) of the payment.
  payment_ref      TEXT,
  proof_url        TEXT,
  -- What was read from the screenshot, and what did not match.
  proof            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Opens the one-tap approval page sent to notify_phone.
  review_token     TEXT NOT NULL UNIQUE,
  decided_by       UUID,
  decided_at       TIMESTAMPTZ,
  issued_at        TIMESTAMPTZ,
  reminded_at      TIMESTAMPTZ,
  message_error    TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, code)
);
CREATE INDEX IF NOT EXISTS event_orders_event_idx ON event_orders (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_orders_phone_idx ON event_orders (account_id, phone_key, created_at DESC);
-- One payment buys one order: a reference number that is waiting for
-- approval or already bought passes cannot be used again.
CREATE UNIQUE INDEX IF NOT EXISTS event_orders_payment_ref_once
  ON event_orders (account_id, payment_ref)
  WHERE payment_ref IS NOT NULL AND status IN ('review', 'issued');

CREATE TABLE IF NOT EXISTS event_passes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES event_orders(id) ON DELETE CASCADE,
  pass_type_id  UUID NOT NULL REFERENCES event_pass_types(id) ON DELETE RESTRICT,
  -- 1 of 3, 2 of 3…
  seq           INTEGER NOT NULL,
  -- What the QR code holds: random, so it cannot be guessed or edited.
  code          TEXT NOT NULL UNIQUE,
  holder_name   TEXT,
  phone_key     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'used', 'cancelled')),
  used_at       TIMESTAMPTZ,
  used_by       UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_passes_event_idx ON event_passes (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS event_passes_order_idx ON event_passes (order_id);

CREATE TABLE IF NOT EXISTS event_scans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  pass_id     UUID REFERENCES event_passes(id) ON DELETE SET NULL,
  code        TEXT,
  result      TEXT NOT NULL,
  scanned_by  UUID,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_scans_event_idx ON event_scans (event_id, scanned_at DESC);

-- ------------------------------------------------------------
-- Who may read
-- ------------------------------------------------------------
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_pass_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_select ON events;
CREATE POLICY events_select ON events FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_pass_types_select ON event_pass_types;
CREATE POLICY event_pass_types_select ON event_pass_types FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_orders_select ON event_orders;
CREATE POLICY event_orders_select ON event_orders FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_passes_select ON event_passes;
CREATE POLICY event_passes_select ON event_passes FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_scans_select ON event_scans;
CREATE POLICY event_scans_select ON event_scans FOR SELECT USING (is_account_member(account_id));

-- Only members who may open the "events" section (migration 076).
DROP POLICY IF EXISTS events_section_gate ON events;
CREATE POLICY events_section_gate ON events AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['events'])));
DROP POLICY IF EXISTS event_pass_types_section_gate ON event_pass_types;
CREATE POLICY event_pass_types_section_gate ON event_pass_types AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['events'])));
DROP POLICY IF EXISTS event_orders_section_gate ON event_orders;
CREATE POLICY event_orders_section_gate ON event_orders AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['events'])));
DROP POLICY IF EXISTS event_passes_section_gate ON event_passes;
CREATE POLICY event_passes_section_gate ON event_passes AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['events'])));
DROP POLICY IF EXISTS event_scans_section_gate ON event_scans;
CREATE POLICY event_scans_section_gate ON event_scans AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['events'])));

-- Issuing a pass from the portal picks a contact.
DROP POLICY IF EXISTS contacts_section_gate ON contacts;
CREATE POLICY contacts_section_gate ON contacts AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['contacts', 'inbox', 'appointments', 'broadcasts', 'pipelines', 'events'])));

-- ------------------------------------------------------------
-- Take places for a request
-- ------------------------------------------------------------
-- One request at a time per event (advisory lock), so two people can
-- never take the last place. Raises a short code the server turns into
-- a message: event_not_found, event_closed, applications_closed,
-- pass_type_not_found, sold_out:<left>, phone_limit:<left>,
-- has_unpaid_order:<code>.
CREATE OR REPLACE FUNCTION public.reserve_event_order(
  p_account_id       UUID,
  p_event_id         UUID,
  p_pass_type_id     UUID,
  p_contact_id       UUID,
  p_conversation_id  UUID,
  p_phone_key        TEXT,
  p_customer_name    TEXT,
  p_quantity         INTEGER,
  p_source           TEXT,
  p_created_by       UUID,
  p_code             TEXT,
  p_review_token     TEXT,
  -- NULL = price × quantity. The portal passes 0 for a complimentary pass.
  p_amount           NUMERIC
)
RETURNS event_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event   events;
  v_type    event_pass_types;
  v_taken   INTEGER;
  v_mine    INTEGER;
  v_unpaid  TEXT;
  v_row     event_orders;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('event:' || p_event_id::text));

  SELECT * INTO v_event FROM events WHERE id = p_event_id AND account_id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
  IF v_event.status = 'cancelled' THEN RAISE EXCEPTION 'event_closed'; END IF;
  -- The business itself may still issue passes after closing requests.
  IF p_source <> 'portal' THEN
    IF v_event.status <> 'open' OR NOT v_event.chat_booking THEN RAISE EXCEPTION 'event_closed'; END IF;
    IF now() >= COALESCE(v_event.apply_until, v_event.starts_at) THEN RAISE EXCEPTION 'applications_closed'; END IF;
  END IF;

  SELECT * INTO v_type FROM event_pass_types
   WHERE id = p_pass_type_id AND event_id = p_event_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'pass_type_not_found'; END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_taken FROM event_orders
   WHERE pass_type_id = p_pass_type_id
     AND (status IN ('review', 'issued') OR (status = 'awaiting_payment' AND expires_at > now()));
  IF v_taken + p_quantity > v_type.capacity THEN
    RAISE EXCEPTION 'sold_out:%', GREATEST(v_type.capacity - v_taken, 0);
  END IF;

  IF p_source <> 'portal' THEN
    SELECT code INTO v_unpaid FROM event_orders
     WHERE account_id = p_account_id AND phone_key = p_phone_key
       AND status = 'awaiting_payment' AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1;
    IF v_unpaid IS NOT NULL THEN RAISE EXCEPTION 'has_unpaid_order:%', v_unpaid; END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_mine FROM event_orders
     WHERE event_id = p_event_id AND phone_key = p_phone_key
       AND status IN ('review', 'issued');
    IF v_mine + p_quantity > v_event.max_per_phone THEN
      RAISE EXCEPTION 'phone_limit:%', GREATEST(v_event.max_per_phone - v_mine, 0);
    END IF;
  END IF;

  INSERT INTO event_orders (
    account_id, event_id, pass_type_id, contact_id, conversation_id, phone_key, customer_name,
    code, quantity, amount, status, source, expires_at, review_token, created_by
  ) VALUES (
    p_account_id, p_event_id, p_pass_type_id, p_contact_id, p_conversation_id, p_phone_key, p_customer_name,
    p_code, p_quantity, COALESCE(p_amount, v_type.price * p_quantity), 'awaiting_payment', p_source,
    now() + make_interval(mins => v_event.hold_minutes), p_review_token, p_created_by
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_event_order(
  UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_event_order(
  UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, TEXT, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

-- ------------------------------------------------------------
-- Scan a pass at the gate
-- ------------------------------------------------------------
-- Marks the pass used in one conditional UPDATE, so two scanners
-- reading the same QR at the same moment admit it once. Every scan is
-- logged. Result: ok | used | cancelled | wrong_event | unknown.
CREATE OR REPLACE FUNCTION public.check_in_event_pass(
  p_account_id  UUID,
  p_event_id    UUID,
  p_code        TEXT,
  p_user        UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pass    event_passes;
  v_result  TEXT;
  v_done    event_passes;
BEGIN
  SELECT * INTO v_pass FROM event_passes WHERE code = p_code AND account_id = p_account_id;
  IF NOT FOUND THEN
    INSERT INTO event_scans (account_id, event_id, code, result, scanned_by)
    VALUES (p_account_id, p_event_id, left(p_code, 80), 'unknown', p_user);
    RETURN jsonb_build_object('result', 'unknown');
  END IF;

  IF v_pass.event_id <> p_event_id THEN
    v_result := 'wrong_event';
  ELSIF v_pass.status = 'cancelled' THEN
    v_result := 'cancelled';
  ELSE
    UPDATE event_passes SET status = 'used', used_at = now(), used_by = p_user
     WHERE id = v_pass.id AND status = 'valid'
    RETURNING * INTO v_done;
    IF FOUND THEN
      v_result := 'ok';
      v_pass := v_done;
    ELSE
      v_result := 'used';
      SELECT * INTO v_pass FROM event_passes WHERE id = v_pass.id;
    END IF;
  END IF;

  INSERT INTO event_scans (account_id, event_id, pass_id, code, result, scanned_by)
  VALUES (p_account_id, p_event_id, v_pass.id, v_pass.code, v_result, p_user);

  RETURN jsonb_build_object(
    'result', v_result,
    'pass', jsonb_build_object(
      'id', v_pass.id,
      'holder_name', v_pass.holder_name,
      'phone_key', v_pass.phone_key,
      'seq', v_pass.seq,
      'status', v_pass.status,
      'used_at', v_pass.used_at,
      'pass_type', (SELECT name FROM event_pass_types WHERE id = v_pass.pass_type_id),
      'quantity', (SELECT quantity FROM event_orders WHERE id = v_pass.order_id),
      'event_name', (SELECT name FROM events WHERE id = v_pass.event_id)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_in_event_pass(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_event_pass(UUID, UUID, TEXT, UUID) TO service_role;

-- ------------------------------------------------------------
-- Numbers for the Events page
-- ------------------------------------------------------------
-- One row per pass type: places held, passes issued, people checked
-- in, payments waiting for approval, unpaid requests, money received.
CREATE OR REPLACE FUNCTION public.event_stats(p_account_id UUID, p_event_ids UUID[])
RETURNS TABLE (
  event_id      UUID,
  pass_type_id  UUID,
  held          INTEGER,
  issued        INTEGER,
  used          INTEGER,
  review        INTEGER,
  awaiting      INTEGER,
  revenue       NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.event_id,
    t.id,
    COALESCE((SELECT SUM(o.quantity) FROM event_orders o
               WHERE o.pass_type_id = t.id
                 AND (o.status IN ('review', 'issued')
                      OR (o.status = 'awaiting_payment' AND o.expires_at > now()))), 0)::int,
    (SELECT COUNT(*) FROM event_passes p WHERE p.pass_type_id = t.id AND p.status <> 'cancelled')::int,
    (SELECT COUNT(*) FROM event_passes p WHERE p.pass_type_id = t.id AND p.status = 'used')::int,
    (SELECT COUNT(*) FROM event_orders o WHERE o.pass_type_id = t.id AND o.status = 'review')::int,
    (SELECT COUNT(*) FROM event_orders o
      WHERE o.pass_type_id = t.id AND o.status = 'awaiting_payment' AND o.expires_at > now())::int,
    COALESCE((SELECT SUM(o.amount) FROM event_orders o WHERE o.pass_type_id = t.id AND o.status = 'issued'), 0)
  FROM event_pass_types t
  WHERE t.account_id = p_account_id AND t.event_id = ANY (p_event_ids)
$$;

REVOKE ALL ON FUNCTION public.event_stats(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_stats(UUID, UUID[]) TO service_role;
