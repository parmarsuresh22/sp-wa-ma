-- ============================================================
-- 068: several wishes per contact (birthday, anniversary, …)
--
-- 067 allowed one wish per contact (UNIQUE contact_id). A contact can
-- now carry several, each with its own date, message and "sent this
-- year" mark, told apart by `occasion`.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contact_wishes
  DROP CONSTRAINT IF EXISTS contact_wishes_contact_id_key;

ALTER TABLE contact_wishes
  ADD COLUMN IF NOT EXISTS occasion TEXT NOT NULL DEFAULT 'birthday';

ALTER TABLE contact_wishes
  DROP CONSTRAINT IF EXISTS contact_wishes_occasion_check;
ALTER TABLE contact_wishes
  ADD CONSTRAINT contact_wishes_occasion_check
  CHECK (occasion IN ('birthday', 'anniversary', 'other'));

CREATE INDEX IF NOT EXISTS contact_wishes_contact_idx
  ON contact_wishes (contact_id, created_at);
