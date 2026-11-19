-- ============================================================
-- 071: platform admin — approval for WhatsApp Web numbers
--
-- Until now an account linked a WhatsApp Web number by typing in the
-- address and API key of a WAHA bridge it hosted itself. From here on
-- the platform owner hosts one bridge for everyone:
--
--   * an account asks for a number (`web_number_requests`, pending),
--   * the platform owner approves it on the hidden admin page,
--   * approval creates the channel on the platform bridge and the
--     account then scans its QR code.
--
-- The bridge address and key live in `internal_settings`
-- (`platform_bridge_url`, `platform_bridge_key` — the key encrypted by
-- the app), set from the admin page. Nothing about the bridge reaches
-- the requesting account.
--
-- `accounts.web_number_limit` caps WhatsApp Web numbers (linked +
-- pending) per account; the platform owner can change it per account.
--
-- `platform_account_stats()` is the admin page's overview: one row per
-- account with usage counts. Service role only.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS web_number_limit INTEGER NOT NULL DEFAULT 2
  CHECK (web_number_limit >= 0 AND web_number_limit <= 50);

COMMENT ON COLUMN accounts.web_number_limit IS
  'Most WhatsApp Web numbers (linked + awaiting approval) this account may have.';

CREATE TABLE IF NOT EXISTS web_number_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- The channel approval created. Nulled if that number is removed.
  channel_id   UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  note         TEXT,
  decided_by   UUID,
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_number_requests_account
  ON web_number_requests (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_number_requests_pending
  ON web_number_requests (created_at) WHERE status = 'pending';

ALTER TABLE web_number_requests ENABLE ROW LEVEL SECURITY;

-- Members see their account's requests. Every write goes through the
-- API with the service role (which enforces the limit and who may
-- decide), so there is no INSERT / UPDATE / DELETE policy.
DROP POLICY IF EXISTS web_number_requests_select ON web_number_requests;
CREATE POLICY web_number_requests_select ON web_number_requests FOR SELECT
  USING (is_account_member(account_id));

REVOKE INSERT, UPDATE, DELETE ON web_number_requests FROM anon, authenticated;

-- ------------------------------------------------------------
-- Overview for the platform admin page.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_account_stats()
RETURNS TABLE (
  account_id        UUID,
  name              TEXT,
  created_at        TIMESTAMPTZ,
  owner_email       TEXT,
  last_sign_in_at   TIMESTAMPTZ,
  members           INTEGER,
  meta_numbers      INTEGER,
  web_numbers       INTEGER,
  web_connected     INTEGER,
  web_pending       INTEGER,
  web_number_limit  INTEGER,
  contacts          BIGINT,
  conversations     BIGINT,
  messages_total    BIGINT,
  messages_7d       BIGINT,
  messages_30d      BIGINT,
  last_message_at   TIMESTAMPTZ,
  flows             INTEGER,
  automations       INTEGER,
  broadcasts        INTEGER,
  data_tables       INTEGER,
  ai_enabled        BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    a.id,
    a.name,
    a.created_at,
    (SELECT u.email::text FROM auth.users u WHERE u.id = a.owner_user_id),
    (SELECT max(u.last_sign_in_at)
       FROM profiles p JOIN auth.users u ON u.id = p.user_id
      WHERE p.account_id = a.id),
    (SELECT count(*)::int FROM profiles p WHERE p.account_id = a.id),
    (SELECT count(*)::int FROM whatsapp_config w
      WHERE w.account_id = a.id AND coalesce(w.provider, 'meta') = 'meta'),
    (SELECT count(*)::int FROM whatsapp_config w
      WHERE w.account_id = a.id AND w.provider = 'waha'),
    (SELECT count(*)::int FROM whatsapp_config w
      WHERE w.account_id = a.id AND w.provider = 'waha' AND w.status = 'connected'),
    (SELECT count(*)::int FROM web_number_requests r
      WHERE r.account_id = a.id AND r.status = 'pending'),
    a.web_number_limit,
    (SELECT count(*) FROM contacts c WHERE c.account_id = a.id),
    (SELECT count(*) FROM conversations c WHERE c.account_id = a.id),
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id),
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id AND m.created_at >= now() - interval '7 days'),
    (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = a.id AND m.created_at >= now() - interval '30 days'),
    (SELECT max(c.last_message_at) FROM conversations c WHERE c.account_id = a.id),
    (SELECT count(*)::int FROM flows f WHERE f.account_id = a.id),
    (SELECT count(*)::int FROM automations t WHERE t.account_id = a.id),
    (SELECT count(*)::int FROM broadcasts b WHERE b.account_id = a.id),
    (SELECT count(*)::int FROM data_tables d WHERE d.account_id = a.id),
    coalesce((SELECT bool_or(g.is_active) FROM ai_configs g WHERE g.account_id = a.id), false)
  FROM accounts a
  ORDER BY a.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.platform_account_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_account_stats() TO service_role;
