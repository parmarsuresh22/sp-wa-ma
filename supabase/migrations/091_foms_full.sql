-- ============================================================
-- 091: AEDA Forms, the full version (the original FOMS, as it is)
--
-- Migration 089 held a first, smaller version of the module. This
-- replaces it with the data model of the original FOMS application,
-- table for table, so its screens and every feature work unchanged:
--
--   foms_projects        folders of forms
--   foms_forms           a form: working design + working workflow
--   foms_form_versions   every published design + workflow, kept forever
--   foms_submissions     answers, with their workflow run traces
--   foms_email_logs      emails produced by workflows
--   foms_settings        email sender accounts (secrets encrypted by the server)
--   foms_extract_tasks   saved / scheduled exports of submissions
--   foms_lookup_tables   uploaded CSV / Excel used to pre-fill fields
--
-- Numeric ids, as in the original, because its screens use them in
-- addresses. Every row belongs to an account.
--
-- Open to the platform admin only while it is being tried out: every
-- read and write goes through the server (service role); row level
-- security is on with no policies, so nothing is reachable from a
-- browser directly.
-- ============================================================

DROP TABLE IF EXISTS aeda_form_submissions;
DROP TABLE IF EXISTS aeda_form_versions;
DROP TABLE IF EXISTS aeda_forms;
DROP TABLE IF EXISTS aeda_form_projects;

CREATE TABLE IF NOT EXISTS foms_projects (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  archived     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_projects_account_idx ON foms_projects (account_id, id DESC);

CREATE TABLE IF NOT EXISTS foms_forms (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id            BIGINT NOT NULL REFERENCES foms_projects(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  archived              BOOLEAN NOT NULL DEFAULT false,
  working_schema        JSONB NOT NULL DEFAULT '{}'::jsonb,
  working_workflow      JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_version_id  BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_forms_project_idx ON foms_forms (project_id, id DESC);
CREATE INDEX IF NOT EXISTS foms_forms_account_idx ON foms_forms (account_id);

CREATE TABLE IF NOT EXISTS foms_form_versions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id        BIGINT NOT NULL REFERENCES foms_forms(id) ON DELETE CASCADE,
  version_no     INTEGER NOT NULL,
  schema_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_form_versions_form_idx ON foms_form_versions (form_id, version_no DESC);

CREATE TABLE IF NOT EXISTS foms_submissions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The 40-character reference shown instead of the id.
  uuid         TEXT NOT NULL UNIQUE,
  form_id      BIGINT NOT NULL REFERENCES foms_forms(id) ON DELETE CASCADE,
  version_id   BIGINT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'submitted',
  modified_by  TEXT NOT NULL DEFAULT '',
  -- The most recent workflow run, and the last 50 (newest first).
  last_trace   JSONB,
  traces       JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_ok      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_submissions_form_idx ON foms_submissions (form_id, id DESC);
CREATE INDEX IF NOT EXISTS foms_submissions_account_idx ON foms_submissions (account_id);

CREATE TABLE IF NOT EXISTS foms_email_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id        BIGINT NOT NULL REFERENCES foms_forms(id) ON DELETE CASCADE,
  submission_id  BIGINT,
  sender         TEXT NOT NULL DEFAULT '',
  recipient      TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  body_html      TEXT NOT NULL DEFAULT '',
  attachment     TEXT NOT NULL DEFAULT '',
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_email_logs_form_idx ON foms_email_logs (form_id, id DESC);

CREATE TABLE IF NOT EXISTS foms_settings (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, key)
);

CREATE TABLE IF NOT EXISTS foms_extract_tasks (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id      BIGINT NOT NULL REFERENCES foms_forms(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Extract',
  columns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_type    TEXT NOT NULL DEFAULT 'csv',
  folder_path  TEXT NOT NULL DEFAULT '',
  schedule     TEXT NOT NULL DEFAULT 'daily',
  minute       INTEGER NOT NULL DEFAULT 0,
  hour         INTEGER NOT NULL DEFAULT 9,
  weekday      INTEGER NOT NULL DEFAULT 0,
  day          INTEGER NOT NULL DEFAULT 1,
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  active       BOOLEAN NOT NULL DEFAULT true,
  last_run     TIMESTAMPTZ,
  next_run     TIMESTAMPTZ,
  -- Where the file of the last run was stored (the portal has no
  -- server folder to write to, so runs go to private storage).
  last_file    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_extract_tasks_due_idx ON foms_extract_tasks (next_run) WHERE active;

CREATE TABLE IF NOT EXISTS foms_lookup_tables (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id        BIGINT NOT NULL REFERENCES foms_forms(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT 'Lookup',
  key_column     TEXT NOT NULL DEFAULT '',
  key_component  TEXT NOT NULL DEFAULT '',
  columns        JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows           JSONB NOT NULL DEFAULT '[]'::jsonb,
  mappings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS foms_lookup_tables_form_idx ON foms_lookup_tables (form_id);

ALTER TABLE foms_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_extract_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE foms_lookup_tables ENABLE ROW LEVEL SECURITY;

-- Private storage for the files of scheduled extracts.
INSERT INTO storage.buckets (id, name, public)
VALUES ('foms-extracts', 'foms-extracts', false)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- Joining another account must not delete AEDA forms: the look of
-- redeem_invitation that decides whether the old account is empty now
-- reads the tables above instead of the ones dropped here. Otherwise
-- unchanged from migration 090.
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
    UNION ALL SELECT 1 FROM foms_projects WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_forms WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_form_versions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_submissions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_email_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_settings WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_extract_tasks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM foms_lookup_tables WHERE account_id = v_old_account_id
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
