// ============================================================
// Platform ("super") admin — the person who runs this deployment.
//
// Not an account role: account roles (owner / admin / agent) are scoped
// to one tenant, while this identity sees every tenant on the hidden
// admin page. It is decided by the signed-in user's *confirmed* email
// against a short allow-list, checked on the server for the page and
// for every admin API call. Everything behind it runs on the service
// role, so the check here is the whole gate.
//
// Server-only (imports the SSR Supabase client).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { normalizeBridgeBaseUrl } from '@/lib/whatsapp/providers/waha'

const DEFAULT_SUPER_ADMINS = ['parmar.suresh22@gmail.com']

/** Allow-list: `SUPER_ADMIN_EMAILS` (comma separated) or the default. */
export function superAdminEmails(): string[] {
  const raw = process.env.SUPER_ADMIN_EMAILS?.trim()
  const list = raw ? raw.split(',') : DEFAULT_SUPER_ADMINS
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean)
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return superAdminEmails().includes(email.trim().toLowerCase())
}

export interface SuperAdminContext {
  userId: string
  email: string
  /** Service-role client — bypasses RLS; every tenant is visible. */
  db: SupabaseClient
}

/**
 * The signed-in platform admin, or null for anyone else (signed out,
 * another user, or an unconfirmed email — an address someone merely
 * typed at signup must never open this door).
 */
export async function getSuperAdmin(): Promise<SuperAdminContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user || !user.email) return null
  if (!user.email_confirmed_at) return null
  if (!isSuperAdminEmail(user.email)) return null
  return { userId: user.id, email: user.email, db: supabaseAdmin() }
}

// ------------------------------------------------------------
// The platform's WhatsApp Web bridge
// ------------------------------------------------------------

export const PLATFORM_BRIDGE_URL_KEY = 'platform_bridge_url'
export const PLATFORM_BRIDGE_KEY_KEY = 'platform_bridge_key'

export interface PlatformBridge {
  baseUrl: string
  apiKey: string
  /** Where it came from: saved on the admin page, or borrowed. */
  source: 'settings' | 'admin_channel'
}

/**
 * The bridge approved numbers are created on. Saved settings win; with
 * none saved, the bridge the platform admin already uses for their own
 * number is borrowed, so approval works before anything is configured.
 */
export async function loadPlatformBridge(db: SupabaseClient): Promise<PlatformBridge | null> {
  const { data: rows } = await db
    .from('internal_settings')
    .select('key, value')
    .in('key', [PLATFORM_BRIDGE_URL_KEY, PLATFORM_BRIDGE_KEY_KEY])
  const settings = new Map(
    ((rows ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  )
  const savedUrl = normalizeBridgeBaseUrl(settings.get(PLATFORM_BRIDGE_URL_KEY) ?? '')
  const savedKey = settings.get(PLATFORM_BRIDGE_KEY_KEY)
  if (savedUrl && savedKey) {
    try {
      return { baseUrl: savedUrl, apiKey: decrypt(savedKey), source: 'settings' }
    } catch {
      console.error('[platform bridge] saved key could not be decrypted — check ENCRYPTION_KEY')
    }
  }

  // Fallback: a bridge number on the platform admin's own account.
  const emails = superAdminEmails()
  if (emails.length === 0) return null
  const { data: profiles } = await db
    .from('profiles')
    .select('account_id, email')
    .in('email', emails)
  const accountIds = ((profiles ?? []) as { account_id: string | null }[])
    .map((p) => p.account_id)
    .filter((id): id is string => !!id)
  if (accountIds.length === 0) return null
  const { data: channels } = await db
    .from('whatsapp_config')
    .select('bridge_base_url, access_token, created_at')
    .in('account_id', accountIds)
    .eq('provider', 'waha')
    .not('bridge_base_url', 'is', null)
    .order('created_at', { ascending: true })
    .limit(5)
  for (const ch of (channels ?? []) as { bridge_base_url: string | null; access_token: string }[]) {
    const url = normalizeBridgeBaseUrl(ch.bridge_base_url ?? '')
    if (!url) continue
    try {
      return { baseUrl: url, apiKey: decrypt(ch.access_token), source: 'admin_channel' }
    } catch {
      // try the next one
    }
  }
  return null
}

/** Save the platform bridge (key encrypted at rest). */
export async function savePlatformBridge(
  db: SupabaseClient,
  input: { baseUrl: string; apiKey: string },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db.from('internal_settings').upsert(
    [
      { key: PLATFORM_BRIDGE_URL_KEY, value: input.baseUrl, updated_at: now },
      { key: PLATFORM_BRIDGE_KEY_KEY, value: encrypt(input.apiKey), updated_at: now },
    ],
    { onConflict: 'key' },
  )
  if (error) throw new Error(error.message)
}
