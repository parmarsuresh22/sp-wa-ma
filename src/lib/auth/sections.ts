// ============================================================
// Which parts of the portal a team member may open (migration 076).
//
// An owner or admin always sees everything. For an agent or viewer the
// account admin may tick the sections they can open; `null` means "all
// of them" (the default, and how every member worked before 076).
//
// The list is enforced in three places that all read from here:
//   - the menu and the page guard (what the member can navigate to),
//   - the API routes (`requireRole(min, section)`),
//   - the database (`member_can_see()` + RESTRICTIVE policies), so a
//     member without "inbox" cannot read a conversation or a message
//     no matter what their browser asks for.
//
// Pure module — safe to import from server and client code.
// ============================================================

import type { AccountRole } from './roles'

export const SECTIONS = [
  { key: 'dashboard', path: '/dashboard' },
  { key: 'inbox', path: '/inbox' },
  { key: 'contacts', path: '/contacts' },
  { key: 'pipelines', path: '/pipelines' },
  { key: 'broadcasts', path: '/broadcasts' },
  { key: 'posts', path: '/posts' },
  { key: 'appointments', path: '/appointments' },
  { key: 'events', path: '/events' },
  { key: 'automations', path: '/automations' },
  { key: 'flows', path: '/flows' },
  { key: 'agents', path: '/agents' },
  { key: 'data', path: '/data' },
] as const

export type SectionKey = (typeof SECTIONS)[number]['key']

export const SECTION_KEYS: readonly SectionKey[] = SECTIONS.map((s) => s.key)

/** Pages that belong to a section without having their own tick box. */
const PATH_ALIASES: { path: string; key: SectionKey }[] = [
  // Notifications are about chats.
  { path: '/notifications', key: 'inbox' },
]

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === 'string' && (SECTION_KEYS as readonly string[]).includes(value)
}

/**
 * Tidy a list coming from the browser or the database. `null` (or
 * anything that is not a list) means "no restriction".
 */
export function cleanSections(raw: unknown): SectionKey[] | null {
  if (!Array.isArray(raw)) return null
  const picked = SECTION_KEYS.filter((key) => raw.includes(key))
  return picked
}

/** The section a path belongs to, or null for pages everyone may open (Settings, …). */
export function sectionForPath(pathname: string): SectionKey | null {
  for (const s of [...SECTIONS, ...PATH_ALIASES]) {
    if (pathname === s.path || pathname.startsWith(`${s.path}/`)) return s.key
  }
  return null
}

/** May a member with this role and this list open the section? */
export function canSeeSection(
  role: AccountRole | null | undefined,
  allowed: readonly string[] | null | undefined,
  section: SectionKey,
): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (!allowed) return true
  return allowed.includes(section)
}

/** Only agents and viewers can be restricted. */
export function roleCanBeRestricted(role: AccountRole | null | undefined): boolean {
  return role === 'agent' || role === 'viewer'
}

/** The first page this member may open — where a blocked page sends them. */
export function firstAllowedPath(
  role: AccountRole | null | undefined,
  allowed: readonly string[] | null | undefined,
): string {
  const first = SECTIONS.find((s) => canSeeSection(role, allowed, s.key))
  return first?.path ?? '/settings'
}
