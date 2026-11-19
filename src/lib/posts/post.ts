// ============================================================
// Posts (migration 072) — shared shapes and the pure helpers.
// No I/O here, so both the browser and the routes can import it.
// ============================================================

export type AudienceMode = 'all' | 'tags' | 'contacts'

export interface PostAudience {
  mode: AudienceMode
  tag_ids: string[]
  contact_ids: string[]
  /** The WhatsApp Web number the broadcast leaves from. */
  channel_id: string
}

export interface PostStatusResult {
  channel_id: string
  ok: boolean
  error?: string
}

export interface PostBroadcastResult {
  total: number
  sent: number
  failed: number
  /** Last contact id handled; the next chunk starts after it. */
  cursor: string | null
  done: boolean
  last_error?: string
}

export interface PostResults {
  status?: PostStatusResult[]
  drive?: { ok: boolean; file_id?: string; error?: string }
  broadcast?: PostBroadcastResult
}

export interface PostRow {
  id: string
  account_id: string
  created_by: string | null
  caption: string | null
  final_text: string | null
  media_url: string | null
  media_path: string | null
  media_mime: string | null
  include_link: boolean
  link_channel_id: string | null
  status_channel_ids: string[]
  audience: PostAudience | null
  results: PostResults
  drive_file_id: string | null
  created_at: string
  updated_at: string
}

/** Caps that keep one post from turning into a bulk blast. */
export const MAX_CAPTION_LENGTH = 1000
export const MAX_BROADCAST_RECIPIENTS = 500
export const BROADCAST_CHUNK = 5

/** `+91 98765 43210` → `https://wa.me/919876543210`; null if unusable. */
export function waMeLink(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  return `https://wa.me/${digits}`
}

/**
 * The text that is actually published: the caption, then a line that
 * tells the viewer how to reach the business on WhatsApp. With no usable
 * number the caption is returned as it is.
 */
export function withWhatsAppLink(
  caption: string | null | undefined,
  phone: string | null | undefined,
  lead = 'Chat with us on WhatsApp:',
): string {
  const text = (caption ?? '').trim()
  const link = waMeLink(phone)
  if (!link) return text
  const line = `${lead} ${link}`
  if (text.includes(link)) return text
  return text ? `${text}\n\n${line}` : line
}

/**
 * Whether `url` is a public object of this account in the chat-media
 * bucket. Posts only ever publish media the account uploaded itself:
 * the bridge fetches the URL, so an arbitrary one would make the server
 * a relay for someone else's file.
 */
export function isAccountMediaUrl(
  url: string | null | undefined,
  supabaseUrl: string | null | undefined,
  accountId: string,
): boolean {
  if (!url || !supabaseUrl) return false
  const base = supabaseUrl.replace(/\/+$/, '')
  const prefix = `${base}/storage/v1/object/public/chat-media/account-${accountId}/`
  if (!url.startsWith(prefix)) return false
  const rest = url.slice(prefix.length)
  return rest.length > 0 && !rest.includes('..') && !rest.includes('?') && !rest.includes('#')
}

/** Storage path (`account-<id>/…`) of an account media URL, or null. */
export function accountMediaPath(
  url: string,
  supabaseUrl: string | null | undefined,
  accountId: string,
): string | null {
  if (!isAccountMediaUrl(url, supabaseUrl, accountId)) return null
  const marker = '/storage/v1/object/public/chat-media/'
  return decodeURIComponent(url.slice(url.indexOf(marker) + marker.length))
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/** Unique UUIDs out of untrusted input, capped. */
export function cleanIdList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isUuid))].slice(0, max)
}

/** Validate an audience from a request body; null when there is none. */
export function parseAudience(value: unknown): PostAudience | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const mode = v.mode
  if (mode !== 'all' && mode !== 'tags' && mode !== 'contacts') return null
  if (!isUuid(v.channel_id)) return null
  const tag_ids = cleanIdList(v.tag_ids, 50)
  const contact_ids = cleanIdList(v.contact_ids, MAX_BROADCAST_RECIPIENTS)
  if (mode === 'tags' && tag_ids.length === 0) return null
  if (mode === 'contacts' && contact_ids.length === 0) return null
  return { mode, tag_ids, contact_ids, channel_id: v.channel_id }
}
