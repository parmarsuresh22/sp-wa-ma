// ============================================================
// Subscription plans (migration 082). Pure — safe to import from
// server and client code.
//
// A plan says three things about an account:
//   - sections   the menu modules it may use. A module outside the plan
//                stays visible and readable; only changing things in it
//                is refused. Pages that belong to no module (Settings,
//                Plans) are never locked.
//   - features   the parts of Settings it may use (branding, the wish
//                scheduler, API keys). The others are shown read-only.
//   - limits     WhatsApp Web numbers, and how many admins, agents and
//                viewers the team may have (null = no limit).
// ============================================================

import { SECTION_KEYS, sectionForPath, type SectionKey } from '@/lib/auth/sections'

/** Parts of Settings a plan can include. Add a key here for a new one. */
export const PLAN_FEATURES = ['branding', 'wishes', 'api_keys'] as const
export type PlanFeature = (typeof PLAN_FEATURES)[number]

/** Team roles a plan can limit (the owner is never counted). */
export const LIMITED_ROLES = ['admin', 'agent', 'viewer'] as const
export type LimitedRole = (typeof LIMITED_ROLES)[number]

export interface Plan {
  key: string
  name: string
  description: string | null
  position: number
  web_number_limit: number
  sections: SectionKey[]
  features: PlanFeature[]
  /** Most members of each role; null = no limit. */
  max_admins: number | null
  max_agents: number | null
  max_viewers: number | null
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/** A plan row as the database returns it, tidied. */
export function toPlan(row: Record<string, unknown>): Plan {
  const sections = Array.isArray(row.sections) ? (row.sections as unknown[]) : []
  const features = Array.isArray(row.features) ? (row.features as unknown[]) : []
  return {
    key: String(row.key ?? ''),
    name: String(row.name ?? row.key ?? ''),
    description: typeof row.description === 'string' && row.description.trim() ? row.description : null,
    position: typeof row.position === 'number' ? row.position : 0,
    web_number_limit: typeof row.web_number_limit === 'number' ? row.web_number_limit : 1,
    // Keys the portal no longer has are dropped; the portal's own order is kept.
    sections: SECTION_KEYS.filter((key) => sections.includes(key)),
    features: PLAN_FEATURES.filter((key) => features.includes(key)),
    max_admins: count(row.max_admins),
    max_agents: count(row.max_agents),
    max_viewers: count(row.max_viewers),
  }
}

/**
 * May an account on this plan use the section? `null` means the plan is
 * not known (plans not set up yet, or it could not be read): nothing is
 * locked, so a hiccup never takes the portal away from a customer.
 */
export function planAllows(sections: readonly string[] | null | undefined, section: SectionKey): boolean {
  if (!sections) return true
  return sections.includes(section)
}

/** Is this page read-only for the plan? */
export function pathLockedByPlan(sections: readonly string[] | null | undefined, pathname: string): boolean {
  const section = sectionForPath(pathname)
  return !!section && !planAllows(sections, section)
}

/** May the plan use this part of Settings? An unknown plan locks nothing. */
export function planHasFeature(plan: Pick<Plan, 'features'> | null | undefined, feature: PlanFeature): boolean {
  if (!plan) return true
  return plan.features.includes(feature)
}

/** The most members of a role the plan allows; null = no limit. */
export function roleLimit(plan: Plan | null | undefined, role: string): number | null {
  if (!plan) return null
  if (role === 'admin') return plan.max_admins
  if (role === 'agent') return plan.max_agents
  if (role === 'viewer') return plan.max_viewers
  return null
}

/** Is there room for one more member of this role? `have` counts members and open invitations. */
export function roleHasRoom(plan: Plan | null | undefined, role: string, have: number): boolean {
  const limit = roleLimit(plan, role)
  return limit === null || have < limit
}

/** Refused because of the plan. Turned into a 403 with this message. */
export class PlanLimitError extends Error {
  readonly status = 403
  readonly code = 'plan_limit'
  constructor(message: string) {
    super(message)
    this.name = 'PlanLimitError'
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export type PlanInput = Omit<Plan, 'key' | 'position'>

/** What the admin page may change on a plan. */
export function parsePlanInput(raw: unknown): Parsed<PlanInput> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
  if (!name) return { ok: false, error: 'Give the plan a name' }
  const limit = r.web_number_limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 50) {
    return { ok: false, error: 'WhatsApp Web numbers must be a whole number from 0 to 50' }
  }
  if (!Array.isArray(r.sections)) return { ok: false, error: 'Choose the modules of the plan' }
  const sections = r.sections as unknown[]
  const features = Array.isArray(r.features) ? (r.features as unknown[]) : []
  const members: Record<string, number | null> = {}
  for (const key of ['max_admins', 'max_agents', 'max_viewers']) {
    const v = r[key]
    if (v === null || v === undefined || v === '') members[key] = null
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000) members[key] = v
    else return { ok: false, error: 'A team limit must be a whole number, or empty for no limit' }
  }
  return {
    ok: true,
    value: {
      name,
      description: typeof r.description === 'string' && r.description.trim() ? r.description.trim().slice(0, 300) : null,
      web_number_limit: limit,
      sections: SECTION_KEYS.filter((key) => sections.includes(key)),
      features: PLAN_FEATURES.filter((key) => features.includes(key)),
      max_admins: members.max_admins,
      max_agents: members.max_agents,
      max_viewers: members.max_viewers,
    },
  }
}
