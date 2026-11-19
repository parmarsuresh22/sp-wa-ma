-- ============================================================
-- 072: posts — one piece of content sent to several places
--
-- A post is an image and/or a caption that an account publishes as a
-- WhatsApp Status on its WhatsApp Web numbers, broadcasts to contacts,
-- and optionally copies to its Google Drive. `posts` is the history the
-- "Reuse" button reads from; the media itself lives in the existing
-- `chat-media` bucket.
--
--   posts.status_channel_ids  numbers the status went to
--   posts.audience            { mode: all|tags|contacts, tag_ids,
--                               contact_ids, channel_id } or null
--   posts.results             per-destination outcome:
--                             { status: [{channel_id, ok, error}],
--                               drive: {ok, file_id, error},
--                               broadcast: {total, sent, failed, cursor, done} }
--
-- `google_drive_connections` holds one Google account per Atlas account
-- (refresh token encrypted by the app). Service role only.
--
-- The Google OAuth client itself (client id / secret) is deployment
-- wide and lives in `internal_settings` (`google_client_id`,
-- `google_client_secret`), set from the platform admin page.
--
-- redeem_invitation is redefined to count both tables as account data.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         UUID,
  -- What the person wrote, without the WhatsApp contact line.
  caption            TEXT,
  -- What was actually published (caption + contact line).
  final_text         TEXT,
  media_url          TEXT,
  media_path         TEXT,
  media_mime         TEXT,
  include_link       BOOLEAN NOT NULL DEFAULT FALSE,
  link_channel_id    UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  status_channel_ids UUID[] NOT NULL DEFAULT '{}',
  audience           JSONB,
  results            JSONB NOT NULL DEFAULT '{}'::jsonb,
  drive_file_id      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posts_account_created
  ON posts (account_id, created_at DESC);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- Members read their account's posts. Writes go through the API on the
-- service role (publishing has side effects the API owns).
DROP POLICY IF EXISTS posts_select ON posts;
CREATE POLICY posts_select ON posts FOR SELECT
  USING (is_account_member(account_id));

REVOKE INSERT, UPDATE, DELETE ON posts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS google_drive_connections (
  account_id    UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  email         TEXT,
  folder_id     TEXT,
  connected_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No policies on purpose: the refresh token never leaves the server.
ALTER TABLE google_drive_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON google_drive_connections FROM anon, authenticated;

-- ------------------------------------------------------------
-- redeem_invitation (from 070), now counting posts and a Drive
-- connection as account data.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_wishes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM wish_schedules WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM data_tables WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM posts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM google_drive_connections WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
