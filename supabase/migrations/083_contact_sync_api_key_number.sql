-- ============================================================
-- 083: Contacts synced from the phone, and an API key's own number
--
--   contact_channels    which WhatsApp number a contact belongs to
--                       without having a chat on it yet. Filled by
--                       "Sync from phone" on the Contacts page: the
--                       address book of the phone behind a WhatsApp Web
--                       number. A synced contact shows only under the
--                       number it was synced from.
--   filter_contacts()   a contact belongs to a number when it has a
--                       chat on it OR was synced from it.
--   api_keys.channel_id the WhatsApp number an API key sends from. Asked
--                       for when a key is made; NULL (older keys) keeps
--                       using the account's default number.
--
-- (Whether a WhatsApp Web number needs the platform admin's approval is
-- a row in internal_settings, key 'web_number_approval'; no schema.)
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_channels (
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'device',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, channel_id)
);
CREATE INDEX IF NOT EXISTS contact_channels_channel_idx ON contact_channels (channel_id);

ALTER TABLE contact_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_channels_select ON contact_channels;
CREATE POLICY contact_channels_select ON contact_channels FOR SELECT USING (is_account_member(account_id));

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
        OR EXISTS (SELECT 1 FROM contact_channels cc WHERE cc.contact_id = c.id AND cc.channel_id = p_channel)
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

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- The platform admin's existing key was sending from the Business API
-- number (the account default). It now sends from the WhatsApp Web
-- number ending 1949.
UPDATE api_keys k
   SET channel_id = w.id
  FROM whatsapp_config w
 WHERE w.id = '80c0c6d6-bfff-48d2-9ead-e6821c73e1bf'
   AND w.account_id = k.account_id
   AND k.channel_id IS NULL
   AND k.revoked_at IS NULL;
