-- ============================================================
-- 082: Subscription plans
--
-- Two plans, assigned by hand on the platform admin page:
--
--   standard   Dashboard, Inbox (with Notifications), Contacts,
--              Pipelines, Broadcasts, Automations, Flows, AI Agents;
--              one WhatsApp Web number; a team of one agent and one
--              viewer; no business branding, wish scheduler or API
--              keys (shown read-only in Settings)
--   premium    every module and every part of Settings; two WhatsApp
--              Web numbers; no team limit
--
-- Which modules a plan includes is data (plans.sections), edited on the
-- admin page, so a module added to the portal later can be given to
-- either plan without a code change. A module in no plan is read-only
-- for everyone until the platform admin ticks it.
--
-- A module outside the account's plan stays visible in the menu and can
-- be opened and read; changing anything in it is refused by the server
-- (`requireRole(min, section)`).
--
-- An account has exactly one plan: assigning another replaces it.
-- Assigning a plan also sets the account's WhatsApp Web number limit
-- (accounts.web_number_limit) to the plan's; numbers already connected
-- beyond a lower limit stay connected, only new ones are refused.
-- ============================================================

CREATE TABLE IF NOT EXISTS plans (
  key               TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name              TEXT NOT NULL,
  description       TEXT,
  -- Order on the Plans page, lowest first.
  position          INTEGER NOT NULL DEFAULT 0,
  web_number_limit  INTEGER NOT NULL DEFAULT 1 CHECK (web_number_limit BETWEEN 0 AND 50),
  -- Section keys (src/lib/auth/sections.ts) the plan may use.
  sections          TEXT[] NOT NULL DEFAULT '{}',
  -- Parts of Settings the plan may use: branding, wishes, api_keys.
  features          TEXT[] NOT NULL DEFAULT '{}',
  -- Most team members of each role (the owner is never counted);
  -- NULL = no limit.
  max_admins        INTEGER CHECK (max_admins >= 0),
  max_agents        INTEGER CHECK (max_agents >= 0),
  max_viewers       INTEGER CHECK (max_viewers >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plans (key, name, description, position, web_number_limit, sections, features, max_admins, max_agents, max_viewers) VALUES
  ('standard', 'Standard', 'The essentials for chatting with customers and following up.', 1, 1,
   ARRAY['dashboard', 'inbox', 'contacts', 'pipelines', 'broadcasts', 'automations', 'flows', 'agents'],
   ARRAY[]::TEXT[], 0, 1, 1),
  ('premium', 'Premium', 'Every module of the portal.', 2, 2,
   ARRAY['dashboard', 'inbox', 'contacts', 'pipelines', 'broadcasts', 'posts', 'appointments', 'events', 'service', 'automations', 'flows', 'agents', 'data'],
   ARRAY['branding', 'wishes', 'api_keys'], NULL, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- Everyone signed in may read the plans (the Plans page compares them);
-- only the server, with the service role, changes them.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans FOR SELECT TO authenticated USING (true);

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan_key TEXT NOT NULL DEFAULT 'standard' REFERENCES plans(key) ON UPDATE CASCADE;

-- The platform admin's own account keeps every module.
UPDATE accounts a
   SET plan_key = 'premium'
  FROM auth.users u
 WHERE u.id = a.owner_user_id
   AND lower(u.email) = 'parmar.suresh22@gmail.com'
   AND a.plan_key = 'standard';

-- Each account's number limit follows its plan from now on.
UPDATE accounts a
   SET web_number_limit = p.web_number_limit
  FROM plans p
 WHERE p.key = a.plan_key
   AND a.web_number_limit IS DISTINCT FROM p.web_number_limit;
