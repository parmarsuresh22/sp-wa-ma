-- ============================================================
-- 061: several WhatsApp numbers ("channels") per account
--
-- Until now `whatsapp_config` held exactly one row per account
-- (UNIQUE(account_id), migration 017) and that row was always a Meta
-- Cloud API number. This migration turns each row into a *channel*:
--
--   * `provider`        — 'meta' (Cloud API, unchanged behaviour) or
--                         'waha' (a WhatsApp Web session hosted on a
--                         self-run WAHA bridge).
--   * `label`           — free-text name shown in the inbox dropdown.
--   * `display_phone`   — the human-readable number (+91…), filled
--                         from Meta's /phone_number_id lookup or from
--                         the bridge session's `me.id`.
--   * `is_default`      — the channel used when a caller does not name
--                         one (public API without channel_id, contact
--                         detail "send template", legacy conversations
--                         with no channel_id). Exactly one per account,
--                         enforced by a partial unique index.
--   * bridge columns    — base URL, session name, encrypted webhook
--                         HMAC key and the bridge's own status word.
--                         `access_token` doubles as the encrypted
--                         bridge API key so every provider's credential
--                         lives in the same encrypted column.
--
-- Conversations gain `channel_id`. One conversation per
-- (account, contact, channel) replaces the (account, contact) key so a
-- customer who writes to two business numbers gets two threads, and a
-- reply always leaves from the number they wrote to. Rows created
-- before this migration are backfilled onto the account's single
-- existing channel.
--
-- Broadcasts gain `channel_id` ("send from"). Broadcasts never run on
-- bridge channels (the app refuses), but the column is provider-neutral.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. whatsapp_config → channels
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS display_phone TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bridge_base_url TEXT,
  ADD COLUMN IF NOT EXISTS bridge_session TEXT,
  ADD COLUMN IF NOT EXISTS bridge_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS bridge_status TEXT;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'waha'));

-- Meta ids are only meaningful for Meta channels. A bridge channel has
-- no phone_number_id, so the column becomes nullable; the global
-- UNIQUE(phone_number_id) from migration 013 still holds for non-null
-- values (Postgres treats NULLs as distinct).
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;

-- Bridge sessions are unique per bridge host.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_bridge_session
  ON whatsapp_config (bridge_base_url, bridge_session)
  WHERE provider = 'waha';

-- One number per account → many. Drop the account-level unique.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_id
  ON whatsapp_config (account_id);

-- Every existing row is its account's only channel → the default.
UPDATE whatsapp_config SET is_default = TRUE WHERE is_default = FALSE
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config d
    WHERE d.account_id = whatsapp_config.account_id AND d.is_default
  );

-- Exactly one default per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_default
  ON whatsapp_config (account_id)
  WHERE is_default;

-- A channel must carry the credentials its provider needs.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta' AND phone_number_id IS NOT NULL)
    OR
    (provider = 'waha' AND bridge_base_url IS NOT NULL AND bridge_session IS NOT NULL)
  );

COMMENT ON COLUMN whatsapp_config.provider IS
  'meta = WhatsApp Cloud API number; waha = WhatsApp Web session on a self-hosted WAHA bridge. For waha rows access_token holds the encrypted bridge API key.';
COMMENT ON COLUMN whatsapp_config.is_default IS
  'The channel used when a send names none. Exactly one per account (partial unique index).';
COMMENT ON COLUMN whatsapp_config.bridge_webhook_secret IS
  'Encrypted HMAC key the bridge signs webhook bodies with (X-Webhook-Hmac, sha512).';
COMMENT ON COLUMN whatsapp_config.bridge_status IS
  'Last session status reported by the bridge: STOPPED, STARTING, SCAN_QR_CODE, WORKING, FAILED.';

-- ------------------------------------------------------------
-- 2. conversations.channel_id
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- Backfill: every pre-existing conversation belongs to its account's
-- (single, now default) channel.
UPDATE conversations c
SET channel_id = w.id
FROM whatsapp_config w
WHERE c.channel_id IS NULL
  AND w.account_id = c.account_id
  AND w.is_default;

CREATE INDEX IF NOT EXISTS idx_conversations_channel_id
  ON conversations (channel_id);

-- (account, contact) → (account, contact, channel). A NULL channel
-- (channel deleted, or an account that never connected a number) is
-- collapsed to a sentinel so the index still forbids two "no channel"
-- threads for one contact.
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (
    account_id,
    contact_id,
    COALESCE(channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

COMMENT ON COLUMN conversations.channel_id IS
  'The WhatsApp number (whatsapp_config row) this thread runs on. Replies always go out from it. NULL falls back to the account default at send time.';

-- ------------------------------------------------------------
-- 3. broadcasts.channel_id ("send from")
-- ------------------------------------------------------------
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE broadcasts b
SET channel_id = w.id
FROM whatsapp_config w
WHERE b.channel_id IS NULL
  AND w.account_id = b.account_id
  AND w.is_default;

CREATE INDEX IF NOT EXISTS idx_broadcasts_channel_id
  ON broadcasts (channel_id);
