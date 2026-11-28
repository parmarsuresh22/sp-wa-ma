-- ============================================================
-- 087: A new account's number limit follows its plan; the owner
--      chooses which modules the menu shows
--
-- 1. `accounts.web_number_limit` still defaulted to 2 (migration 071),
--    while a new account starts on the Standard plan, which allows one
--    WhatsApp Web number. Migration 082 lined up the accounts that
--    existed then; every account created since got 2 again. The limit
--    is now taken from the plan when the account is created, and the
--    column default is 1 for the case where the plan cannot be read.
--
--    Accounts on Standard that were created with 2 in the meantime are
--    brought back to the plan's limit. Numbers already linked stay
--    linked; only new ones are refused.
--
-- 2. `accounts.menu_hidden`: module keys (src/lib/auth/sections.ts) the
--    owner switched off in Settings → Menu modules. The menu leaves
--    them out for everyone in the account. Nothing else changes: the
--    page still opens from a link, and the module keeps working.
-- ============================================================

ALTER TABLE accounts ALTER COLUMN web_number_limit SET DEFAULT 1;

CREATE OR REPLACE FUNCTION public.set_account_number_limit_from_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan_limit INTEGER;
BEGIN
  SELECT p.web_number_limit INTO plan_limit
    FROM plans p
   WHERE p.key = COALESCE(NEW.plan_key, 'standard');
  IF FOUND THEN
    NEW.web_number_limit := plan_limit;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.set_account_number_limit_from_plan() OWNER TO postgres;

DROP TRIGGER IF EXISTS accounts_number_limit_from_plan ON accounts;
CREATE TRIGGER accounts_number_limit_from_plan
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_account_number_limit_from_plan();

-- Standard accounts created with the old default of 2.
UPDATE accounts a
   SET web_number_limit = p.web_number_limit
  FROM plans p
 WHERE p.key = a.plan_key
   AND a.plan_key = 'standard'
   AND a.web_number_limit = 2
   AND p.web_number_limit < 2;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS menu_hidden TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN accounts.menu_hidden IS
  'Module keys the owner hid from the menu (Settings → Menu modules).';
