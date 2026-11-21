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
  web_number_limit: number
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

export function bridgeInfo(
  bridge: { baseUrl: string; source: 'settings' | 'admin_channel' } | null,
): AdminBridgeInfo {
  return bridge ? { configured: true, url: bridge.baseUrl, source: bridge.source } : { configured: false }
}

export async function loadAdminHome(db: SupabaseClient): Promise<AdminHome> {
  const [accountsRes, requests, bridge, google] = await Promise.all([
    db
      .from('accounts')
      .select('id, name, created_at, web_number_limit, owner_user_id')
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
  }[]

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
    })),
    requests: requests.rows.map((r) => ({
      ...(r as unknown as AdminHomeRequest),
      requested_by_email: emails.get(r.requested_by as string) ?? null,
    })),
    bridge: bridgeInfo(bridge),
    google: { configured: !!google, client_id: google?.clientId ?? null },
  }
}
