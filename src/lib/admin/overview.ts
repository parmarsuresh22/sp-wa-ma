// ============================================================
// First paint of the platform admin page (/admin8085).
//
// Only what the screen needs to draw at once: the account list (names
// and owners), the WhatsApp Web number requests, and whether the bridge
// and the Google client are set. The page renders this on the server,
// so it arrives with the HTML instead of after a second round trip.
//
// The usage counts (contacts, chats, messages…) scan much more data, so
// they are fetched afterwards by /api/admin8085/overview and filled in.
//
// Server-only; the caller has already checked the platform admin.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadPlatformBridge } from '@/lib/admin/super-admin'
import { loadGoogleClient } from '@/lib/google/drive'

export interface AdminHomeAccount {
  account_id: string
  name: string
  created_at: string
  owner_email: string | null
  /** The owner's name as it is in their profile now. */
  owner_name?: string | null
  web_number_limit: number
  plan_key?: string
  /** Set while the account is blocked (migration 085). */
  blocked_at?: string | null
}

export interface AdminHomeRequest {
  id: string
  account_id: string
  label: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  note: string | null
  created_at: string
  decided_at: string | null
  requested_by_email: string | null
}

export interface AdminBridgeInfo {
  configured: boolean
  url?: string
  source?: 'settings' | 'admin_channel'
}

export interface AdminHome {
  accounts: AdminHomeAccount[]
  requests: AdminHomeRequest[]
  bridge: AdminBridgeInfo
  google: { configured: boolean; client_id: string | null }
}

/** The latest requests, and who asked (ids, for the email lookup). */
export async function loadNumberRequests(
  db: SupabaseClient,
): Promise<{ rows: Record<string, unknown>[]; requesterIds: string[] }> {
  const { data, error } = await db
    .from('web_number_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Record<string, unknown>[]
  const requesterIds = [...new Set(rows.map((r) => r.requested_by as string).filter(Boolean))]
  return { rows, requesterIds }
}

export async function emailsByUserId(db: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return map
  const { data } = await db.from('profiles').select('user_id, email').in('user_id', ids)
  for (const p of (data ?? []) as { user_id: string; email: string | null }[]) {
    if (p.email) map.set(p.user_id, p.email)
  }
  return map
}

/**
 * What the usage counts do not carry, read fresh on every load: each
 * account's plan, and its owner's name and email as they are in the
 * owner's profile now — so a customer who changes their name or email
 * shows that way here too.
 */
export interface AccountOwner {
  plan_key: string | undefined
  owner_name: string | null
  owner_email: string | null
  blocked_at: string | null
}

export async function accountOwners(
  db: SupabaseClient,
): Promise<Map<string, AccountOwner>> {
  const out = new Map<string, AccountOwner>()
  const { data: accounts } = await db.from('accounts').select('id, plan_key, owner_user_id, blocked_at').limit(10000)
  const rows = (accounts ?? []) as { id: string; plan_key?: string; owner_user_id: string | null; blocked_at?: string | null }[]
  const ids = [...new Set(rows.map((r) => r.owner_user_id).filter((v): v is string => !!v))]
  const people = new Map<string, { full_name: string | null; email: string | null }>()
  if (ids.length > 0) {
    const { data: profiles } = await db.from('profiles').select('user_id, full_name, email').in('user_id', ids)
    for (const p of (profiles ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
      people.set(p.user_id, { full_name: p.full_name?.trim() || null, email: p.email })
    }
  }
  for (const r of rows) {
    const person = r.owner_user_id ? people.get(r.owner_user_id) : undefined
    out.set(r.id, {
      plan_key: r.plan_key,
      owner_name: person?.full_name ?? null,
      owner_email: person?.email ?? null,
      blocked_at: r.blocked_at ?? null,
    })
  }
  return out
}

export function bridgeInfo(
  bridge: { baseUrl: string; source: 'settings' | 'admin_channel' } | null,
): AdminBridgeInfo {
  return bridge ? { configured: true, url: bridge.baseUrl, source: bridge.source } : { configured: false }
}

export async function loadAdminHome(db: SupabaseClient): Promise<AdminHome> {
  const [accountsRes, requests, bridge, google] = await Promise.all([
    db
      .from('accounts')
      .select('id, name, created_at, web_number_limit, owner_user_id, plan_key')
      .order('created_at', { ascending: false })
      .limit(1000),
    loadNumberRequests(db),
    loadPlatformBridge(db).catch(() => null),
    loadGoogleClient(db).catch(() => null),
  ])
  if (accountsRes.error) throw new Error(accountsRes.error.message)
  const accounts = (accountsRes.data ?? []) as {
    id: string
    name: string
    created_at: string
    web_number_limit: number
    owner_user_id: string | null
    plan_key?: string
  }[]

  const owners = await accountOwners(db).catch(() => new Map<string, AccountOwner>())
  const emails = await emailsByUserId(db, [
    ...accounts.map((a) => a.owner_user_id ?? ''),
    ...requests.requesterIds,
  ])

  return {
    accounts: accounts.map((a) => ({
      account_id: a.id,
      name: a.name,
      created_at: a.created_at,
      owner_email: a.owner_user_id ? (emails.get(a.owner_user_id) ?? null) : null,
      web_number_limit: a.web_number_limit,
      plan_key: a.plan_key,
      owner_name: owners.get(a.id)?.owner_name ?? null,
      blocked_at: owners.get(a.id)?.blocked_at ?? null,
    })),
    requests: requests.rows.map((r) => ({
      ...(r as unknown as AdminHomeRequest),
      requested_by_email: emails.get(r.requested_by as string) ?? null,
    })),
    bridge: bridgeInfo(bridge),
    google: { configured: !!google, client_id: google?.clientId ?? null },
  }
}
