// ============================================================
// Channels — the WhatsApp numbers an account can talk through.
//
// A channel is one row of `whatsapp_config` (migration 061). It is
// either a Meta Cloud API number (`provider = 'meta'`, the only kind
// that existed before 061) or a WhatsApp Web session hosted on a
// self-run WAHA bridge (`provider = 'waha'`).
//
// Every outbound path resolves its channel the same way:
//   1. the conversation's own `channel_id` when it has one,
//   2. otherwise the account's default channel (`is_default`),
//   3. otherwise the oldest channel the account has.
// Inbound traffic already knows its channel: the Meta webhook matches
// `phone_number_id`, the bridge webhook carries the channel id in its
// URL.
//
// Loaders here deliberately avoid `.single()` — several rows per
// account is the whole point — and never throw: a missing channel is a
// normal state (fresh account) that callers map to their own
// "WhatsApp not configured" error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type ChannelProvider = 'meta' | 'waha'

export const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ['meta', 'waha']

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return typeof value === 'string' && (CHANNEL_PROVIDERS as readonly string[]).includes(value)
}

/** The `whatsapp_config` row shape every channel-aware path reads. */
export interface ChannelRow {
  id: string
  account_id: string
  user_id: string
  provider: ChannelProvider
  label: string | null
  display_phone: string | null
  is_default: boolean
  status: 'connected' | 'disconnected'
  connected_at: string | null
  created_at?: string
  /** Meta: encrypted Graph API token. WAHA: encrypted bridge API key. */
  access_token: string
  // --- Meta ---------------------------------------------------
  phone_number_id: string | null
  waba_id: string | null
  verify_token: string | null
  registered_at?: string | null
  subscribed_apps_at?: string | null
  last_registration_error?: string | null
  mirror_inbound_media?: boolean
  // --- WAHA bridge --------------------------------------------
  bridge_base_url: string | null
  bridge_session: string | null
  /** Encrypted HMAC key the bridge signs webhook bodies with. */
  bridge_webhook_secret: string | null
  bridge_status: string | null
}

/** Columns safe to hand to the browser (no secrets). */
export const CHANNEL_PUBLIC_COLUMNS =
  'id, account_id, provider, label, display_phone, is_default, status, connected_at, created_at, phone_number_id, waba_id, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media, bridge_base_url, bridge_session, bridge_status'

export type PublicChannel = Omit<
  ChannelRow,
  'access_token' | 'verify_token' | 'bridge_webhook_secret' | 'user_id'
>

/** Human label for a channel: its name, else its number, else its id. */
export function channelDisplayName(
  ch: Pick<ChannelRow, 'label' | 'display_phone' | 'phone_number_id' | 'bridge_session'>,
): string {
  return (
    (ch.label && ch.label.trim()) ||
    (ch.display_phone && ch.display_phone.trim()) ||
    ch.phone_number_id ||
    ch.bridge_session ||
    'WhatsApp'
  )
}

type Db = SupabaseClient

/**
 * The one query every loader issues: all channel rows of the account.
 * Sorting and filtering happen in JS — an account has a handful of
 * numbers, and a single, simple query shape keeps every caller (and
 * every test double) on the same path.
 */
async function fetchAccountChannels(db: Db, accountId: string): Promise<ChannelRow[]> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
  if (error) {
    console.error('[channels] account lookup failed:', error.message)
    return []
  }
  const rows: ChannelRow[] = Array.isArray(data)
    ? (data as ChannelRow[])
    : data
      ? [data as ChannelRow]
      : []
  return rows.slice().sort(compareChannels)
}

/** Default first, then oldest first. */
function compareChannels(a: ChannelRow, b: ChannelRow): number {
  if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1
  const ta = a.created_at ? Date.parse(a.created_at) : 0
  const tb = b.created_at ? Date.parse(b.created_at) : 0
  return ta - tb
}

/**
 * Every channel of the account, default first then oldest first —
 * the order the settings list and the inbox dropdown show.
 */
export async function listChannels(db: Db, accountId: string): Promise<ChannelRow[]> {
  return fetchAccountChannels(db, accountId)
}

/** The account's default channel, falling back to its oldest one. */
export async function loadDefaultChannel(
  db: Db,
  accountId: string,
): Promise<ChannelRow | null> {
  const rows = await fetchAccountChannels(db, accountId)
  return rows[0] ?? null
}

/**
 * The account's default *Meta* channel. Templates, broadcasts and the
 * Graph media proxy are Meta-only, so they resolve here rather than
 * through `loadDefaultChannel`, which may hand back a bridge.
 */
export async function loadDefaultMetaChannel(
  db: Db,
  accountId: string,
): Promise<ChannelRow | null> {
  const rows = await fetchAccountChannels(db, accountId)
  // Rows written before migration 061 carry no provider column.
  return rows.find((r) => (r.provider ?? 'meta') === 'meta') ?? null
}

/** One channel by id, scoped to the account. */
export async function loadChannel(
  db: Db,
  accountId: string,
  channelId: string,
): Promise<ChannelRow | null> {
  const rows = await fetchAccountChannels(db, accountId)
  return rows.find((r) => r.id === channelId) ?? null
}

/**
 * Resolve a channel for an outbound send: an explicit `channelId`
 * wins, then the conversation's own channel, then the account default.
 * The explicit id must belong to the account or it is ignored (never
 * trusted across tenants).
 */
export async function resolveSendChannel(
  db: Db,
  accountId: string,
  opts: { channelId?: string | null; conversationChannelId?: string | null } = {},
): Promise<ChannelRow | null> {
  const rows = await fetchAccountChannels(db, accountId)
  if (opts.channelId) {
    return rows.find((r) => r.id === opts.channelId) ?? null
  }
  if (opts.conversationChannelId) {
    const own = rows.find((r) => r.id === opts.conversationChannelId)
    if (own) return own
    // Channel row deleted under the thread — fall through to default.
  }
  return rows[0] ?? null
}

/**
 * Channel of an existing conversation (by id). Used by the paths that
 * only have a conversation id in hand: reactions, the auto-reply typing
 * indicator, the engines.
 */
export async function loadChannelForConversation(
  db: Db,
  accountId: string,
  conversationId: string,
): Promise<ChannelRow | null> {
  const { data, error } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[channels] conversation channel lookup failed:', error.message)
  }
  const conversationChannelId =
    (data as { channel_id?: string | null } | null)?.channel_id ?? null
  return resolveSendChannel(db, accountId, { conversationChannelId })
}

/** Whether the account has at least one connected channel. */
export async function hasConnectedChannel(db: Db, accountId: string): Promise<boolean> {
  const rows = await fetchAccountChannels(db, accountId)
  return rows.some((r) => r.status === 'connected')
}

/**
 * Strip secrets for the browser. Kept here so every route that lists
 * channels uses one allow-list.
 */
export function toPublicChannel(row: ChannelRow): PublicChannel {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { access_token, verify_token, bridge_webhook_secret, user_id, ...rest } = row
  return rest
}
