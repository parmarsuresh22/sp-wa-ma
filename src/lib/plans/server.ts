// ============================================================
// Subscription plans on the server (migration 082): what an account's
// plan includes, and the checks that refuse what it does not.
//
// Read on almost every API call, so a plan is remembered for a short
// while per server instance. A change made on the admin page is
// therefore felt everywhere within half a minute.
//
// Anything that goes wrong reading a plan (the table missing on an
// older database, a network blip) locks nothing: `null` means "not
// known", and every check treats that as allowed.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { SectionKey } from '@/lib/auth/sections'
import { PlanLimitError, planAllows, planHasFeature, roleHasRoom, roleLimit, toPlan, type Plan, type PlanFeature } from './plans'

const KEEP_MS = 30_000
const remembered = new Map<string, { at: number; plan: Plan | null }>()

/** Forget what was remembered (after the admin page changes a plan). */
export function forgetPlans(): void {
  remembered.clear()
}

/** One plan, or null when it cannot be read. */
export async function loadPlan(db: SupabaseClient, planKey: string | null | undefined): Promise<Plan | null> {
  if (!planKey) return null
  const hit = remembered.get(planKey)
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.plan
  let plan: Plan | null = null
  try {
    const { data, error } = await db.from('plans').select('*').eq('key', planKey).maybeSingle()
    if (!error && data) plan = toPlan(data as Record<string, unknown>)
  } catch {
    plan = null
  }
  remembered.set(planKey, { at: Date.now(), plan })
  return plan
}

/** The plan of an account, or null when it cannot be read. */
export async function loadAccountPlan(db: SupabaseClient, accountId: string): Promise<Plan | null> {
  try {
    const { data, error } = await db.from('accounts').select('plan_key').eq('id', accountId).maybeSingle()
    if (error || !data) return null
    return await loadPlan(db, (data as { plan_key?: string | null }).plan_key)
  } catch {
    return null
  }
}

/**
 * May this account use the module? For work the server does on its own
 * (answering a chat, for instance), where there is no signed-in caller.
 */
export async function accountPlanAllows(db: SupabaseClient, accountId: string, section: SectionKey): Promise<boolean> {
  const plan = await loadAccountPlan(db, accountId)
  return planAllows(plan?.sections, section)
}

const FEATURE_NAMES: Record<PlanFeature, string> = {
  branding: 'Business branding',
  wishes: 'The wish scheduler',
  api_keys: 'API keys',
}

/** Refuse a change to a part of Settings the plan does not include. */
export async function assertPlanFeature(db: SupabaseClient, accountId: string, feature: PlanFeature): Promise<void> {
  const plan = await loadAccountPlan(db, accountId)
  if (!planHasFeature(plan, feature)) {
    throw new PlanLimitError(`${FEATURE_NAMES[feature]} is not part of your ${plan?.name ?? ''} plan. See the Plans page.`)
  }
}

/**
 * Refuse one more member of a role when the plan's team is full.
 * Members and invitations still open both count; `exceptUserId` leaves
 * out the member whose role is being changed.
 */
export async function assertRoleRoom(
  db: SupabaseClient,
  accountId: string,
  role: string,
  exceptUserId?: string | null,
): Promise<void> {
  const plan = await loadAccountPlan(db, accountId)
  const limit = roleLimit(plan, role)
  if (limit === null) return
  let members = db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId).eq('account_role', role)
  if (exceptUserId) members = members.neq('user_id', exceptUserId)
  const [{ count: joined }, { count: invited }] = await Promise.all([
    members,
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('role', role)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ])
  if (!roleHasRoom(plan, role, (joined ?? 0) + (invited ?? 0))) {
    const noun = limit === 1 ? role : `${role}s`
    throw new PlanLimitError(
      limit === 0
        ? `Your ${plan?.name ?? ''} plan does not include ${role}s. See the Plans page.`
        : `Your ${plan?.name ?? ''} plan allows ${limit} ${noun} (open invitations count). See the Plans page.`,
    )
  }
}

/** Every plan, lowest first. */
export async function listPlans(db: SupabaseClient): Promise<Plan[]> {
  const { data, error } = await db.from('plans').select('*').order('position', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Record<string, unknown>[]).map(toPlan)
}
