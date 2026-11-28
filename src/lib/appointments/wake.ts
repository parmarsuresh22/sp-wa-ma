// ============================================================
// "Answer only when woken" (migration 086).
//
// For a number that is also somebody's personal WhatsApp: the
// Appointment assistant and the AI agent stay silent in a chat until
// the customer writes one of the business's wake words, then answer
// that chat until it has been quiet for a while.
//
// Pure rules live here (and are tested); the database part is at the
// bottom.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Offered to every business; each may replace them with its own. */
export const DEFAULT_WAKE_WORDS = [
  'appointment',
  'appoinment',
  'apointment',
  'booking',
  'book',
  'slot',
  'reschedule',
  'अपॉइंटमेंट',
  'अपॉइंटमेन्ट',
  'बुकिंग',
  'बुक',
]

export const DEFAULT_WAKE_MINUTES = 30
export const MIN_WAKE_MINUTES = 5
export const MAX_WAKE_MINUTES = 1440
export const MAX_WAKE_WORDS = 40

/** The tag that keeps a contact out of every automatic answer. */
export const PERSONAL_TAG = 'personal'

/** Words as typed in the settings, tidied: trimmed, lower case, no repeats. */
export function cleanWakeWords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const word = item.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40)
    if (word.length >= 2) seen.add(word)
    if (seen.size >= MAX_WAKE_WORDS) break
  }
  return [...seen]
}

/** The words in force: the business's own, or the suggested ones. */
export function wakeWordsInForce(saved: string[] | null | undefined): string[] {
  const own = cleanWakeWords(saved ?? [])
  return own.length > 0 ? own : DEFAULT_WAKE_WORDS
}

export function cleanWakeMinutes(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_WAKE_MINUTES
  return Math.min(MAX_WAKE_MINUTES, Math.max(MIN_WAKE_MINUTES, Math.round(n)))
}

/**
 * True when the message contains a wake word. The word must start a
 * word of the message ("book" wakes on "booking" and "Book me", not on
 * "facebook"); what follows it is free, so plurals and endings count.
 */
export function messageWakes(text: string | null | undefined, words: string[]): boolean {
  const body = (text ?? '').normalize('NFC').toLowerCase()
  if (!body.trim()) return false
  return words.some((word) => {
    const w = word.normalize('NFC').toLowerCase()
    let from = 0
    for (;;) {
      const at = body.indexOf(w, from)
      if (at < 0) return false
      const before = at === 0 ? '' : [...body.slice(0, at)].pop()!
      // A letter, digit or vowel sign right before means we are inside
      // another word.
      if (!before || !/[\p{L}\p{N}\p{M}]/u.test(before)) return true
      from = at + 1
    }
  })
}

export interface WakeInput {
  wakeMode: boolean
  words: string[]
  minutes: number
  /** `conversations.assistant_awake_until` as stored. */
  awakeUntil: string | null
  text: string | null | undefined
  /** The contact carries the "Personal" tag. */
  personal: boolean
  now: Date
}

export interface WakeDecision {
  /** Whether the assistants may answer this message. */
  answer: boolean
  /** New value for `assistant_awake_until`; undefined = leave as it is. */
  awakeUntil?: string | null
}

export function wakeDecision(input: WakeInput): WakeDecision {
  if (!input.wakeMode) return { answer: true }
  if (input.personal) return { answer: false }
  const until = new Date(input.now.getTime() + input.minutes * 60_000).toISOString()
  const awake = !!input.awakeUntil && Date.parse(input.awakeUntil) > input.now.getTime()
  // Every message of an awake chat keeps it awake a while longer.
  if (awake) return { answer: true, awakeUntil: until }
  if (messageWakes(input.text, input.words)) return { answer: true, awakeUntil: until }
  return { answer: false }
}

// ------------------------------------------------------------
// With the database
// ------------------------------------------------------------

/**
 * Whether the Appointment assistant and the AI agent may answer this
 * incoming message, by the number's wake setting. Any failure here
 * answers "yes": a hiccup must not silence a business that never
 * switched the setting on.
 */
export async function assistantsMayAnswer(
  db: SupabaseClient,
  args: {
    accountId: string
    channelId: string | null | undefined
    conversationId: string
    contactId: string
    text: string | null | undefined
    now?: Date
  },
): Promise<boolean> {
  if (!args.channelId) return true
  try {
    const { data: settings, error } = await db
      .from('appointment_settings')
      .select('wake_mode, wake_words, wake_minutes')
      .eq('account_id', args.accountId)
      .eq('channel_id', args.channelId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const s = settings as { wake_mode?: boolean; wake_words?: string[] | null; wake_minutes?: number | null } | null
    if (!s?.wake_mode) return true

    const [{ data: conv }, { data: tags }] = await Promise.all([
      db.from('conversations').select('assistant_awake_until').eq('id', args.conversationId).maybeSingle(),
      db.from('contact_tags').select('tag:tags(name)').eq('contact_id', args.contactId),
    ])
    const personal = ((tags ?? []) as unknown as { tag: { name?: string | null } | { name?: string | null }[] | null }[]).some(
      (row) => {
        const tag = Array.isArray(row.tag) ? row.tag[0] : row.tag
        return (tag?.name ?? '').trim().toLowerCase() === PERSONAL_TAG
      },
    )

    const decision = wakeDecision({
      wakeMode: true,
      words: wakeWordsInForce(s.wake_words),
      minutes: cleanWakeMinutes(s.wake_minutes),
      awakeUntil: (conv as { assistant_awake_until?: string | null } | null)?.assistant_awake_until ?? null,
      text: args.text,
      personal,
      now: args.now ?? new Date(),
    })
    if (decision.awakeUntil !== undefined) {
      await db
        .from('conversations')
        .update({ assistant_awake_until: decision.awakeUntil })
        .eq('id', args.conversationId)
    }
    return decision.answer
  } catch (err) {
    console.error('[wake] setting not read, answering as usual:', err instanceof Error ? err.message : err)
    return true
  }
}
