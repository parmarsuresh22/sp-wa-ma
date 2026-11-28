-- ============================================================
-- 084: An API key's number also decides what comes back
--
--   webhook_endpoints.channel_id   the WhatsApp number an endpoint
--                                  listens to. Set from the API key
--                                  that registers it. Events about a
--                                  chat on another number are not sent
--                                  to it; NULL keeps every number.
--
-- With migration 083 a key sends from its own number. Together: a key
-- made for one number sends from it and hears from it, and nothing
-- from the account's other numbers.
--
-- The platform admin's own key and endpoints belong to the Business
-- API number ending 6401: customers write to that number, and the
-- replies must come from it (083 had pointed the key at the WhatsApp
-- Web number ending 1949, which made replies leave from there).
-- ============================================================

ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

UPDATE api_keys k
   SET channel_id = w.id
  FROM whatsapp_config w
 WHERE w.id = '98e28df5-16ec-427b-ada9-126e4dd48b41'
   AND w.account_id = k.account_id
   AND k.revoked_at IS NULL;

UPDATE webhook_endpoints e
   SET channel_id = w.id
  FROM whatsapp_config w
 WHERE w.id = '98e28df5-16ec-427b-ada9-126e4dd48b41'
   AND w.account_id = e.account_id
   AND e.channel_id IS NULL;
