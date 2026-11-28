-- ============================================================
-- 089: AEDA Forms — a form builder inside the portal
--
-- Projects hold forms. A form has a working design (schema) that is
-- edited freely, and a published copy that people fill in. Every
-- publish is kept as a version, so an answer always knows which design
-- it was given on.
--
--   aeda_form_projects      a folder of forms
--   aeda_forms              one form: working design, published design,
--                           and the token of its public link
--   aeda_form_versions      every published design, never changed
--   aeda_form_submissions   the answers
--
-- While the module is being tried out it is open to the platform admin
-- only, and every read and write goes through the server (service
-- role). Row level security is on with no policies, so nothing here is
-- reachable from a browser directly. Policies for account members are
-- added when the module is opened to everyone.
-- ============================================================

CREATE TABLE IF NOT EXISTS aeda_form_projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  archived_at  TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeda_form_projects_account_idx ON aeda_form_projects (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aeda_forms (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id         UUID NOT NULL REFERENCES aeda_form_projects(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  -- The design being worked on.
  schema             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  -- The design people fill in; NULL until first published.
  published_schema   JSONB,
  published_version  INTEGER NOT NULL DEFAULT 0,
  published_at       TIMESTAMPTZ,
  -- The long random part of the public link.
  public_token       TEXT NOT NULL UNIQUE,
  -- Off: the form can be filled in from the portal only.
  public_enabled     BOOLEAN NOT NULL DEFAULT true,
  archived_at        TIMESTAMPTZ,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeda_forms_project_idx ON aeda_forms (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aeda_forms_account_idx ON aeda_forms (account_id);

CREATE TABLE IF NOT EXISTS aeda_form_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id       UUID NOT NULL REFERENCES aeda_forms(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  schema        JSONB NOT NULL,
  published_by  UUID,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);

CREATE TABLE IF NOT EXISTS aeda_form_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id       UUID NOT NULL REFERENCES aeda_forms(id) ON DELETE CASCADE,
  -- The published version the answer was given on.
  version       INTEGER NOT NULL DEFAULT 0,
  -- The reference shown to people instead of the row id.
  ref           TEXT NOT NULL UNIQUE,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage         TEXT,
  -- 'portal' (filled in by a signed-in person) or 'link' (the public link).
  source        TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'link')),
  submitted_by  UUID,
  modified_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeda_form_submissions_form_idx ON aeda_form_submissions (form_id, created_at DESC);

ALTER TABLE aeda_form_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeda_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeda_form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aeda_form_submissions ENABLE ROW LEVEL SECURITY;
