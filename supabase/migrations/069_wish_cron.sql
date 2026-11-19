-- ============================================================
-- 069: the database calls the wish scheduler itself
--
-- Wish schedules only run when something calls GET /api/wishes/cron.
-- Until now that needed an env var on the host plus an outside pinger;
-- without both, schedules showed a "next run" that never happened.
--
-- This makes the install self-contained: pg_cron fires every 15
-- minutes and pg_net calls the app with a secret that lives in
-- `internal_settings` (service role only). The route accepts that
-- secret alongside AUTOMATION_CRON_SECRET / CRON_SECRET.
--
-- One value is deployment-specific and NOT set here — the app's URL:
--
--   INSERT INTO internal_settings (key, value)
--   VALUES ('app_url', 'https://your-app.example.com')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Until it is set, the job does nothing.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS internal_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No policies on purpose: only the service role (and SECURITY DEFINER
-- functions) may read it.
ALTER TABLE internal_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON internal_settings FROM anon, authenticated;

INSERT INTO internal_settings (key, value)
VALUES (
  'wish_cron_secret',
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ping_wish_cron()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    TEXT;
  v_secret TEXT;
  v_id     BIGINT;
BEGIN
  SELECT value INTO v_url FROM internal_settings WHERE key = 'app_url';
  SELECT value INTO v_secret FROM internal_settings WHERE key = 'wish_cron_secret';
  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT net.http_get(
    url := rtrim(v_url, '/') || '/api/wishes/cron',
    headers := jsonb_build_object('x-cron-secret', v_secret),
    timeout_milliseconds := 15000
  ) INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ping_wish_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ping_wish_cron() FROM anon, authenticated;

-- Naming the job makes this an upsert.
SELECT cron.schedule('wish-cron', '*/15 * * * *', 'select public.ping_wish_cron()');
