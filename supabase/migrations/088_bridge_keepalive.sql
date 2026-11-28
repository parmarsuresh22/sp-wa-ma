-- ============================================================
-- 088: WhatsApp Web sessions are brought back by themselves
--
-- A WhatsApp Web session can drop without anyone asking for it: the
-- bridge restarts, the session fails, a start never finishes. Until
-- now it then stayed "disconnected" until somebody opened Settings and
-- pressed Start. The portal now checks every number that is not
-- connected and starts its session again (the login is kept on the
-- bridge, so no new QR code is needed unless WhatsApp itself logged
-- the phone out).
--
--   bridge_keep_stopped  the person stopped the session on purpose;
--                        it is left alone until they start it again
--   bridge_recovery_at   when the portal last looked at a session that
--                        is not connected, so it looks at most every
--                        few minutes
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS bridge_keep_stopped BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bridge_recovery_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_config.bridge_keep_stopped IS
  'The WhatsApp Web session was stopped on purpose; do not start it again automatically.';
COMMENT ON COLUMN whatsapp_config.bridge_recovery_at IS
  'When the portal last tried to bring this WhatsApp Web session back.';
