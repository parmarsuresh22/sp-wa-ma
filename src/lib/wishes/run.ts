// ============================================================
// Wish runner — sends the wishes that are due on one number.
//
// A run covers the window since the schedule's previous run (see
// `runWindow`), always including today in the schedule's time zone so
// a wish saved on the day itself still goes out. Each wish is claimed
// (`last_sent_year`) *before* its send, so overlapping runs — a cron
// ping racing "Run now" — can never wish a contact twice in a year; a
// failed send releases the claim and records `last_error`.
//
// Sends go through `sendMessageToConversation`, the same core the
// inbox uses, so a wish appears in the thread like any other message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { renderBroadcastText } from '@/lib/whatsapp/broadcast-core'
import { loadChannel, type ChannelRow } from '@/lib/whatsapp/channels'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  computeNextRun,
  isValidTimeZone,
  runWindow,
  wishDueYear,
  zonedParts,
  zonedToUtc,
  type WishFrequency,
} from './schedule'

export interface WishScheduleRow {
  id: string
  account_id: string
  channel_id: string
  enabled: boolean
  frequency: WishFrequency
  timezone: string
  time_of_day: string
  day_of_week: number | null
  day_of_month: number | null
  month: number | null
  last_run_at: string | null
  next_run_at: string | null
  last_result?: unknown
}

export interface ContactWishRow {
  id: string
  account_id: string
  contact_id: string
  channel_id: string | null
  enabled: boolean
  month: number
  day: number
  message_text: string | null
  template_name: string | null
  template_language: string | null
  template_params: unknown
  last_sent_year: number | null
  last_sent_at: string | null
  last_error: string | null
}

/** Stored template values: body variables plus optional header / URL-button values. */
export interface WishTemplateParams {
  body: string[]
  headerText?: string
  buttonParams?: Record<number, string>
}

export interface WishRunResult {
  at: string
  manual: boolean
  due: number
  sent: number
  failed: number
  /** True when the time budget ran out; the next check continues. */
  truncated: boolean
  error?: string
}

/** Pause between sends — the same one-a-second pace broadcasts use. */
const SEND_GAP_MS = 1_000
const MAX_WISHES_SCANNED = 5_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Accepts the stored JSONB in either shape: `[...]` (body only) or `{ body, … }`. */
export function parseWishTemplateParams(raw: unknown): WishTemplateParams {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : []
  if (Array.isArray(raw)) return { body: strings(raw) }
  if (raw && typeof raw === 'object') {
    const o = raw as { body?: unknown; headerText?: unknown; buttonParams?: unknown }
    const out: WishTemplateParams = { body: strings(o.body) }
    if (typeof o.headerText === 'string' && o.headerText.trim()) out.headerText = o.headerText
    if (o.buttonParams && typeof o.buttonParams === 'object' && !Array.isArray(o.buttonParams)) {
      const buttons: Record<number, string> = {}
      for (const [k, v] of Object.entries(o.buttonParams as Record<string, unknown>)) {
        if (/^\d+$/.test(k) && typeof v === 'string' && v.trim()) buttons[Number(k)] = v
      }
      if (Object.keys(buttons).length > 0) out.buttonParams = buttons
    }
    return out
  }
  return { body: [] }
}

/** `{{name}}` → the contact's name, in every stored template value. */
export function renderWishTemplateParams(
  params: WishTemplateParams,
  name: string | null | undefined,
): WishTemplateParams {
  const out: WishTemplateParams = { body: params.body.map((v) => renderBroadcastText(v, name)) }
  if (params.headerText) out.headerText = renderBroadcastText(params.headerText, name)
  if (params.buttonParams) {
    out.buttonParams = Object.fromEntries(
      Object.entries(params.buttonParams).map(([k, v]) => [Number(k), renderBroadcastText(v, name)]),
    )
  }
  return out
}

/**
 * The enabled wishes of one number that are due in (from, to] — or
 * today — and not yet sent for that year. Pure; exported for tests.
 */
export function selectDueWishes(
  wishes: ContactWishRow[],
  lastRunAt: Date | null,
  now: Date,
  timezone: string,
): { wish: ContactWishRow; year: number }[] {
  const tz = isValidTimeZone(timezone) ? timezone : 'UTC'
  let { from } = runWindow(lastRunAt, now)
  // `wishDueYear` excludes `from`'s own calendar day. When the previous
  // run was earlier today, step back so today stays inside the window —
  // otherwise a wish saved after this morning's run would be skipped
  // until next year. `last_sent_year` keeps it to one send.
  const f = zonedParts(from, tz)
  const t = zonedParts(now, tz)
  if (f.year === t.year && f.month === t.month && f.day === t.day) {
    from = new Date(zonedToUtc(t.year, t.month, t.day, 0, 0, tz).getTime() - 1)
  }

  const due: { wish: ContactWishRow; year: number }[] = []
  for (const wish of wishes) {
    if (!wish.enabled) continue
    const year = wishDueYear({ month: wish.month, day: wish.day }, from, now, tz)
    if (year === null) continue
    if (wish.last_sent_year !== null && wish.last_sent_year >= year) continue
    due.push({ wish, year })
  }
  // Never-failed wishes first, so one that keeps failing cannot starve
  // the rest when a run is cut short by the time budget.
  due.sort((a, b) => Number(!!a.wish.last_error) - Number(!!b.wish.last_error))
  return due
}

export async function sendWish(
  db: SupabaseClient,
  channel: ChannelRow,
  wish: ContactWishRow,
  auditUserId: string,
  /** The teammate behind a manual test send; null for the scheduler. */
  senderId: string | null = null,
): Promise<void> {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, name')
    .eq('id', wish.contact_id)
    .eq('account_id', wish.account_id)
    .maybeSingle()
  if (error || !contact) throw new Error('Contact not found')
  const name = (contact as { name?: string | null }).name ?? null

  const isBridge = channel.provider === 'waha'
  if (isBridge && !wish.message_text?.trim()) {
    throw new Error('This wish has no message')
  }
  if (!isBridge && !wish.template_name) {
    throw new Error('A Business API number needs an approved template for this wish')
  }

  const conversation = await findOrCreateConversationRow(
    db,
    wish.account_id,
    wish.contact_id,
    auditUserId,
    channel.id,
  )

  if (isBridge) {
    await sendMessageToConversation(db, wish.account_id, {
      conversationId: conversation.id,
      channelId: channel.id,
      messageType: 'text',
      contentText: renderBroadcastText(wish.message_text!, name),
      senderId,
    })
    return
  }

  const params = renderWishTemplateParams(parseWishTemplateParams(wish.template_params), name)
  if (params.body.some((v) => !v.trim())) {
    throw new Error('A template value is empty for this contact (no name on the contact?)')
  }
  await sendMessageToConversation(db, wish.account_id, {
    conversationId: conversation.id,
    channelId: channel.id,
    messageType: 'template',
    templateName: wish.template_name,
    templateLanguage: wish.template_language,
    templateParams: params.body,
    templateMessageParams: params,
    senderId,
  })
}

/**
 * Run one schedule now. `db` must be the service-role client (the cron
 * has no user session). `deadline` (epoch ms) bounds the run inside the
 * serverless time limit; a cut-short run leaves `last_run_at` alone and
 * books itself for the next check, which carries on where this stopped.
 */
export async function runWishSchedule(
  db: SupabaseClient,
  schedule: WishScheduleRow,
  opts: { now?: Date; manual?: boolean; deadline?: number } = {},
): Promise<WishRunResult> {
  const now = opts.now ?? new Date()
  const deadline = opts.deadline ?? Date.now() + 240_000
  const result: WishRunResult = {
    at: now.toISOString(),
    manual: !!opts.manual,
    due: 0,
    sent: 0,
    failed: 0,
    truncated: false,
  }

  const finish = async (): Promise<WishRunResult> => {
    const nextRun = schedule.enabled ? computeNextRun(schedule, now).toISOString() : null
    const patch: Record<string, unknown> = { last_result: result }
    if (result.truncated) {
      // Due again at once; the window still starts at the old last_run_at.
      if (schedule.enabled) patch.next_run_at = now.toISOString()
    } else if (result.error) {
      // Nothing was checked (number gone or offline): try again at the
      // next slot without moving the window, so its wishes are not lost.
      patch.next_run_at = nextRun
    } else {
      patch.last_run_at = now.toISOString()
      patch.next_run_at = nextRun
    }
    const { error } = await db.from('wish_schedules').update(patch).eq('id', schedule.id)
    if (error) console.error('[wishes] schedule update failed:', error.message)
    return result
  }

  const channel = await loadChannel(db, schedule.account_id, schedule.channel_id)
  if (!channel) {
    result.error = 'Number not found'
    return finish()
  }
  if (channel.status !== 'connected') {
    result.error = 'Number is not connected'
    return finish()
  }

  const { data, error } = await db
    .from('contact_wishes')
    .select('*')
    .eq('account_id', schedule.account_id)
    .eq('channel_id', schedule.channel_id)
    .eq('enabled', true)
    .limit(MAX_WISHES_SCANNED)
  if (error) {
    result.error = error.message
    return finish()
  }

  const due = selectDueWishes(
    (data ?? []) as ContactWishRow[],
    schedule.last_run_at ? new Date(schedule.last_run_at) : null,
    now,
    schedule.timezone,
  )
  result.due = due.length
  if (due.length === 0) return finish()

  let auditUserId: string
  try {
    auditUserId = await resolveAuditUserId(db, schedule.account_id)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return finish()
  }

  for (let i = 0; i < due.length; i++) {
    if (Date.now() > deadline) {
      result.truncated = true
      break
    }
    const { wish, year } = due[i]

    // Claim first: only one run may move last_sent_year up to `year`.
    const { data: claimed, error: claimError } = await db
      .from('contact_wishes')
      .update({ last_sent_year: year })
      .eq('id', wish.id)
      .eq('enabled', true)
      .or(`last_sent_year.is.null,last_sent_year.lt.${year}`)
      .select('id')
    if (claimError) {
      console.error('[wishes] claim failed:', claimError.message)
      result.failed += 1
      continue
    }
    if (!claimed || claimed.length === 0) continue // another run has it

    try {
      await sendWish(db, channel, wish, auditUserId)
      result.sent += 1
      await db
        .from('contact_wishes')
        .update({ last_sent_at: new Date().toISOString(), last_error: null })
        .eq('id', wish.id)
    } catch (err) {
      result.failed += 1
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[wishes] send failed for wish ${wish.id}:`, message)
      await db
        .from('contact_wishes')
        .update({ last_sent_year: wish.last_sent_year, last_error: message.slice(0, 500) })
        .eq('id', wish.id)
    }

    if (i < due.length - 1) await sleep(SEND_GAP_MS)
  }

  return finish()
}

/** The schedule a number has before anyone saves one. */
export const DEFAULT_WISH_SCHEDULE = {
  enabled: false,
  frequency: 'daily' as WishFrequency,
  timezone: 'Asia/Kolkata',
  time_of_day: '09:00',
  day_of_week: null,
  day_of_month: null,
  month: null,
}
