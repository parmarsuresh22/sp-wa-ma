-- ============================================================
-- 085: Blocking an account, and columns only the platform decides
--
-- The platform admin can block an account from the admin page. While
-- `accounts.blocked_at` is set, nobody of that account can sign in or
-- use the portal or its API; the sign-in screen tells them the account
-- is blocked and whom to write to. Reactivating clears the column.
-- Nothing of the account is deleted either way.
--
-- An account's own admins may update their account row (its name,
-- currency, branding…). Until now that also let them change, straight
-- from the browser, columns that only the platform decides: the
-- subscription plan and the WhatsApp Web number limit. Those, and the
-- new blocked_at, are now refused for a signed-in user the same way
-- owner_user_id already was (migration 047); the server, working with
-- the service role, still changes them.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.blocked_at IS
  'Set while the platform admin has blocked the account; NULL = active.';

CREATE OR REPLACE FUNCTION public.enforce_account_identity_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'owner_user_id, id and created_at cannot be changed directly; use transfer_account_ownership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.plan_key IS DISTINCT FROM OLD.plan_key
      OR NEW.web_number_limit IS DISTINCT FROM OLD.web_number_limit
      OR NEW.blocked_at IS DISTINCT FROM OLD.blocked_at)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'The plan, the number limit and the blocked state of an account are set by the platform'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_identity_columns() OWNER TO postgres;
