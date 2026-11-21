// ============================================================
// Posts (migration 072) — shared shapes and the pure helpers.
// No I/O here, so both the browser and the routes can import it.
// ============================================================

export type AudienceMode = 'all' | 'tags' | 'contacts' | 'list'

export interface PostAudience {
  mode: AudienceMode
  tag_ids: string[]
  contact_ids: string[]
  /** The WhatsApp Web number the broadcast leaves from. */
  channel_id: string
  /** mode 'list': the saved recipient list (migration 077). */
  list_id?: string | null
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

// ------------------------------------------------------------
// Pacing. WhatsApp blocks numbers that send many messages quickly, so
// a broadcast from a WhatsApp Web number goes out slowly on purpose:
// a few messages, a pause, a few more.
// ------------------------------------------------------------

/** Average gap between two messages of one batch (the real gap varies). */
export const MESSAGE_GAP_MS = 3000
/** Rest between two batches. */
export const BATCH_PAUSE_MS = 20_000

/** Roughly how long a broadcast to `count` people takes, in seconds. */
export function estimateBroadcastSeconds(count: number): number {
  const n = Math.max(0, Math.min(Math.floor(count), MAX_BROADCAST_RECIPIENTS))
  if (n === 0) return 0
  const batches = Math.ceil(n / BROADCAST_CHUNK)
  return Math.round((n * MESSAGE_GAP_MS + (batches - 1) * BATCH_PAUSE_MS) / 1000)
}

// ------------------------------------------------------------
// Mobile numbers from an uploaded file
// ------------------------------------------------------------

/**
 * A cell as a 10-digit mobile number, or null when it is not one.
 *
 * Spaces, dashes, brackets and a leading `+` are ignored. A leading
 * country code `91` or a trunk `0` in front of ten digits is dropped.
 * What is left must be exactly ten digits starting with 6, 7, 8 or 9 —
 * landlines, short codes, order numbers and half-typed numbers are all
 * left out rather than messaged.
 */
export function toTenDigitMobile(cell: string | null | undefined): string | null {
  const raw = (cell ?? '').trim()
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

/** Unique 10-digit mobiles out of a list of cells, with what was left out. */
export function extractMobileNumbers(cells: readonly string[]): {
  numbers: string[]
  read: number
  rejected: number
  duplicates: number
} {
  const seen = new Set<string>()
  let read = 0
  let rejected = 0
  let duplicates = 0
  for (const cell of cells) {
    if (!cell || !cell.trim()) continue
    read++
    const n = toTenDigitMobile(cell)
    if (!n) rejected++
    else if (seen.has(n)) duplicates++
    else seen.add(n)
  }
  return { numbers: [...seen], read, rejected, duplicates }
}

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
  if (mode !== 'all' && mode !== 'tags' && mode !== 'contacts' && mode !== 'list') return null
  if (!isUuid(v.channel_id)) return null
  if (mode === 'list') {
    if (!isUuid(v.list_id)) return null
    return { mode, tag_ids: [], contact_ids: [], channel_id: v.channel_id, list_id: v.list_id }
  }
  const tag_ids = cleanIdList(v.tag_ids, 50)
  const contact_ids = cleanIdList(v.contact_ids, MAX_BROADCAST_RECIPIENTS)
  if (mode === 'tags' && tag_ids.length === 0) return null
  if (mode === 'contacts' && contact_ids.length === 0) return null
  return { mode, tag_ids, contact_ids, channel_id: v.channel_id }
}
