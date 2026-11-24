-- ============================================================
-- 081: Service Today — service records and next-visit reminders
--
-- A business that visits its customers again and again (RO filters, AC
-- service, pest control…) keeps one line per visit: who, what was done,
-- when, and when the next visit is due. The customer gets a WhatsApp
-- confirmation when the visit is saved and a reminder the day before
-- and on the day of the next visit.
--
-- Everything belongs to one WhatsApp Web number of the account. It is
-- free: there is no balance, price or payment anywhere.
--
--   service_settings    the business name / address shown in messages
--   service_customers   one row per customer of a number
--   service_visits      one row per visit; several can be open at once
--                       for one customer (several appliances)
--
-- Rows are removed softly (status = 'inactive'), so history is kept and
-- reminders stop at once.
--
-- All writes go through the server with the service role. Members read
-- their own account's rows, and only when they may open the "service"
-- section.
-- ============================================================

CREATE TABLE IF NOT EXISTS service_settings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id     UUID NOT NULL UNIQUE REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  business_name  TEXT NOT NULL,
  address        TEXT NOT NULL,
  -- Language of the messages customers get.
  language       TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Reminders go out from this time of day (HH:MM, business's zone).
  reminder_time  TEXT NOT NULL DEFAULT '09:00' CHECK (reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Digits only, with the country code.
  phone_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  area        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, contact_id)
);
CREATE INDEX IF NOT EXISTS service_customers_channel_idx ON service_customers (channel_id, status);

CREATE TABLE IF NOT EXISTS service_visits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id     UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES service_customers(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,
  area           TEXT,
  visit_date     DATE NOT NULL,
  next_visit     DATE NOT NULL,
  comment        TEXT,
  -- Up to three photo addresses from the account's own media folder.
  images         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- The next-visit date each reminder was sent for: the day before
  -- (rem1) and on the day (rem0). Moving the date sends them again.
  rem1_sent_for  DATE,
  rem0_sent_for  DATE,
  -- When each of those went out (for "reminders sent today").
  rem1_sent_at   TIMESTAMPTZ,
  rem0_sent_at   TIMESTAMPTZ,
  message_error  TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (next_visit >= visit_date)
);
CREATE INDEX IF NOT EXISTS service_visits_channel_idx ON service_visits (channel_id, status);
CREATE INDEX IF NOT EXISTS service_visits_customer_idx ON service_visits (customer_id);
-- What the reminder run looks for.
CREATE INDEX IF NOT EXISTS service_visits_due_idx ON service_visits (next_visit) WHERE status = 'active';

ALTER TABLE service_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_settings_select ON service_settings;
CREATE POLICY service_settings_select ON service_settings FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS service_customers_select ON service_customers;
CREATE POLICY service_customers_select ON service_customers FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS service_visits_select ON service_visits;
CREATE POLICY service_visits_select ON service_visits FOR SELECT USING (is_account_member(account_id));

-- Only members who may open the "service" section (migration 076).
DROP POLICY IF EXISTS service_settings_section_gate ON service_settings;
CREATE POLICY service_settings_section_gate ON service_settings AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['service'])));
DROP POLICY IF EXISTS service_customers_section_gate ON service_customers;
CREATE POLICY service_customers_section_gate ON service_customers AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['service'])));
DROP POLICY IF EXISTS service_visits_section_gate ON service_visits;
CREATE POLICY service_visits_section_gate ON service_visits AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['service'])));
