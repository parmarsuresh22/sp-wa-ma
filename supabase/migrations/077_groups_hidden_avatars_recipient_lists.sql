-- ============================================================
-- 077: groups stay in the inbox, profile photos, saved recipient lists
--
--   contacts.is_group           true for the row that stands for a
--       WhatsApp group (its `wa_user_id` is the group's chat id). A
--       group is only a chat: every list of contacts leaves it out.
--   contacts.avatar_checked_at  when the WhatsApp profile photo was
--       last looked up, so it is refreshed about once a week and never
--       on a page load.
--   filter_contacts()           the contacts page's filter, now without
--       groups.
--   post_recipient_lists        mobile numbers taken from an uploaded
--       CSV / Excel file, kept so the same list can be used for the
--       next post.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN
  GENERATED ALWAYS AS (COALESCE(wa_user_id LIKE '%@g.us', false)) STORED;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS avatar_checked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.filter_contacts(
  p_tag_ids UUID[] DEFAULT NULL,
  p_channel UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE NOT c.is_group
      AND (
        p_tag_ids IS NULL OR cardinality(p_tag_ids) = 0
        OR EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids))
      )
      AND (
        p_channel IS NULL
        OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = c.id AND cv.channel_id = p_channel)
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

-- ------------------------------------------------------------
-- Recipient lists for posts
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_recipient_lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The WhatsApp Web number the list was prepared for.
  channel_id      UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- 10-digit mobile numbers, no country code, no duplicates.
  numbers         TEXT[] NOT NULL DEFAULT '{}',
  -- What the file contained, for the "what was left out" note.
  rows_read       INTEGER NOT NULL DEFAULT 0,
  rejected        INTEGER NOT NULL DEFAULT 0,
  source_filename TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_post_recipient_lists_channel
  ON post_recipient_lists (channel_id, created_at DESC);

ALTER TABLE post_recipient_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS post_recipient_lists_select ON post_recipient_lists;
CREATE POLICY post_recipient_lists_select ON post_recipient_lists FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS post_recipient_lists_section_gate ON post_recipient_lists;
CREATE POLICY post_recipient_lists_section_gate ON post_recipient_lists AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.member_can_see(ARRAY['posts'])));

REVOKE INSERT, UPDATE, DELETE ON post_recipient_lists FROM anon, authenticated;
