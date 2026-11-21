// ============================================================
// Appointments (migration 073): reading the diary, booking, moving and
// cancelling, and the messages that go with them.
//
// Server-only. Every function takes the service-role client and an
// account / channel the caller has already been authorised for. The
// customer-facing ones take a `phoneKey` that the caller derived from
// the WhatsApp number the message arrived from — never from anything
// the customer (or the model) typed — so a customer can only ever see
// and change their own appointments.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { loadChannel } from '@/lib/whatsapp/channels'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import {
  DATE_RE,
  DEFAULT_HOURS,
  TIME_RE,
  addDays,
  daySlots,
  formatDay,
  formatTime,
  localParts,
  minutesOf,
  reminderAt,
  type AppointmentSettings,
  type HoursRange,
  type Slot,
} from './time'

export type AppointmentStatus = 'booked' | 'completed' | 'cancelled' | 'no_show'

export interface AppointmentRow {
  id: string
  account_id: string
  channel_id: string
  contact_id: string
  conversation_id: string | null
  phone_key: string
  customer_name: string | null
  starts_at: string
  ends_at: string
  status: AppointmentStatus
  source: 'ai' | 'portal'
  treatment: string | null
  medicine: string | null
  notes: string | null
  reminder_at: string | null
  reminder_sent_at: string | null
  reminder_error: string | null
  created_by: string | null
  cancelled_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export class AppointmentError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'AppointmentError'
    this.code = code
    this.status = status
  }
}

/** Settings as stored, or the defaults a number starts with. */
export function settingsFromRow(
  row: Record<string, unknown> | null,
  accountId: string,
  channelId: string,
): AppointmentSettings {
  const r = row ?? {}
  const hours =
    r.hours && typeof r.hours === 'object' && !Array.isArray(r.hours)
      ? (r.hours as Record<string, HoursRange[]>)
      : null
  return {
    id: (r.id as string) ?? null,
    account_id: accountId,
    channel_id: channelId,
    enabled: r.enabled === true,
    business_name: (r.business_name as string) ?? null,
    address: (r.address as string) ?? null,
    timezone: (r.timezone as string) || 'Asia/Kolkata',
    slot_minutes: (r.slot_minutes as number) ?? 30,
    slot_capacity: (r.slot_capacity as number) ?? 1,
    days_ahead: (r.days_ahead as number) ?? 30,
    hours: row ? (hours ?? {}) : DEFAULT_HOURS,
    holidays: Array.isArray(r.holidays) ? (r.holidays as string[]) : [],
    reminder_mode: (r.reminder_mode as AppointmentSettings['reminder_mode']) ?? 'same_day',
    reminder_time: (r.reminder_time as string) ?? '09:00',
    confirm_template: (r.confirm_template as string) ?? null,
    confirm_template_language: (r.confirm_template_language as string) ?? null,
    reminder_template: (r.reminder_template as string) ?? null,
    reminder_template_language: (r.reminder_template_language as string) ?? null,
  }
}

export async function loadAppointmentSettings(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
): Promise<AppointmentSettings> {
  const { data, error } = await db
    .from('appointment_settings')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return settingsFromRow(data as Record<string, unknown> | null, accountId, channelId)
}

// ------------------------------------------------------------
// Availability
// ------------------------------------------------------------

export interface SlotState extends Slot {
  /** Places still open in this slot. */
  left: number
  free: boolean
}

/** The last calendar date that may be booked, in the business's zone. */
export function lastBookableDate(settings: AppointmentSettings, now: Date): string {
  return addDays(localParts(now, settings.timezone).date, settings.days_ahead)
}

/**
 * Every slot of `date` with how many places are left. Slots that have
 * already started, and dates beyond the booking horizon, are not free.
 * `ignoreId` leaves one appointment out of the count (the one being
 * moved must not block its own new time).
 */
export async function slotsForDate(
  db: SupabaseClient,
  settings: AppointmentSettings,
  date: string,
  now: Date,
  ignoreId?: string | null,
): Promise<SlotState[]> {
  const slots = daySlots(settings, date)
  if (slots.length === 0) return []
  const first = slots[0].startsAt
  const last = slots[slots.length - 1].endsAt
  const { data, error } = await db
    .from('appointments')
    .select('id, starts_at, ends_at')
    .eq('channel_id', settings.channel_id)
    .eq('status', 'booked')
    .lt('starts_at', last.toISOString())
    .gt('ends_at', first.toISOString())
    .limit(5000)
  if (error) throw new Error(error.message)
  const taken = ((data ?? []) as { id: string; starts_at: string; ends_at: string }[])
    .filter((a) => a.id !== ignoreId)
    .map((a) => ({ start: Date.parse(a.starts_at), end: Date.parse(a.ends_at) }))

  const tooFar = date > lastBookableDate(settings, now)
  return slots.map((slot) => {
    const s = slot.startsAt.getTime()
    const e = slot.endsAt.getTime()
    const used = taken.filter((a) => a.start < e && a.end > s).length
    const left = Math.max(0, settings.slot_capacity - used)
    const free = left > 0 && s > now.getTime() && !tooFar
    return { ...slot, left, free }
  })
}

export interface SlotCheck {
  available: boolean
  /** Why not: not_a_slot | past | too_far | closed | full. */
  reason?: 'not_a_slot' | 'past' | 'too_far' | 'closed' | 'full'
  slot?: SlotState
  /** Up to three free slots: the nearest that day, else the next days. */
  alternatives: SlotState[]
}

/** Is `date` `time` bookable? If not, what are the nearest free slots? */
export async function checkSlot(
  db: SupabaseClient,
  settings: AppointmentSettings,
  date: string,
  time: string,
  now: Date,
  ignoreId?: string | null,
): Promise<SlotCheck> {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return { available: false, reason: 'not_a_slot', alternatives: [] }
  }
  const slots = await slotsForDate(db, settings, date, now, ignoreId)
  const exact = slots.find((s) => s.time === time)
  if (exact?.free) return { available: true, slot: exact, alternatives: [] }

  const wanted = minutesOf(time)
  let alternatives = slots
    .filter((s) => s.free)
    .sort((a, b) => Math.abs(minutesOf(a.time) - wanted) - Math.abs(minutesOf(b.time) - wanted))
    .slice(0, 3)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())

  // Nothing left that day: offer the first free slots of the next days.
  if (alternatives.length === 0) {
    const horizon = lastBookableDate(settings, now)
    const today = localParts(now, settings.timezone).date
    let day = date < today ? today : addDays(date, 1)
    for (let i = 0; i < 14 && day <= horizon && alternatives.length < 3; i++, day = addDays(day, 1)) {
      const next = (await slotsForDate(db, settings, day, now, ignoreId)).filter((s) => s.free)
      alternatives = alternatives.concat(next.slice(0, 3 - alternatives.length))
    }
  }

  let reason: SlotCheck['reason']
  if (slots.length === 0) reason = 'closed'
  else if (!exact) reason = 'not_a_slot'
  else if (exact.startsAt.getTime() <= now.getTime()) reason = 'past'
  else if (date > lastBookableDate(settings, now)) reason = 'too_far'
  else reason = 'full'
  return { available: false, reason, slot: exact, alternatives }
}

// ------------------------------------------------------------
// A customer's own appointments
// ------------------------------------------------------------

/** The future booking this phone number holds on this number, if any. */
export async function liveAppointment(
  db: SupabaseClient,
  channelId: string,
  phoneKey: string,
  now: Date,
): Promise<AppointmentRow | null> {
  const { data, error } = await db
    .from('appointments')
    .select('*')
    .eq('channel_id', channelId)
    .eq('phone_key', phoneKey)
    .eq('status', 'booked')
    .gt('starts_at', now.toISOString())
    .order('starts_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(error.message)
  return ((data ?? [])[0] as AppointmentRow | undefined) ?? null
}

/** The latest past visits of this phone number (newest first). */
export async function pastAppointments(
  db: SupabaseClient,
  channelId: string,
  phoneKey: string,
  now: Date,
  limit = 3,
): Promise<AppointmentRow[]> {
  const { data, error } = await db
    .from('appointments')
    .select('*')
    .eq('channel_id', channelId)
    .eq('phone_key', phoneKey)
    .neq('status', 'cancelled')
    .lte('starts_at', now.toISOString())
    .order('starts_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as AppointmentRow[]
}

// ------------------------------------------------------------
// Booking
// ------------------------------------------------------------

export interface BookInput {
  settings: AppointmentSettings
  contactId: string
  conversationId: string | null
  phoneKey: string
  customerName: string | null
  date: string
  time: string
  source: 'ai' | 'portal'
  createdBy: string | null
  /** Move this booking instead of making a new one. */
  replaceId?: string | null
  now?: Date
}

/**
 * Book (or move) an appointment. Throws AppointmentError with code
 * `slot_unavailable`, `slot_full` or `has_live_appointment` when the
 * rules say no — the database function is the final word on the last
 * two, so two people cannot take the same last place.
 */
export async function bookAppointment(db: SupabaseClient, input: BookInput): Promise<AppointmentRow> {
  const now = input.now ?? new Date()
  const { settings } = input
  const check = await checkSlot(db, settings, input.date, input.time, now, input.replaceId)
  if (!check.available || !check.slot) {
    throw new AppointmentError('slot_unavailable', 'That time is not available')
  }
  const { data, error } = await db.rpc('book_appointment', {
    p_account_id: settings.account_id,
    p_channel_id: settings.channel_id,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId,
    p_phone_key: input.phoneKey,
    p_customer_name: input.customerName,
    p_starts_at: check.slot.startsAt.toISOString(),
    p_ends_at: check.slot.endsAt.toISOString(),
    p_capacity: settings.slot_capacity,
    p_source: input.source,
    p_created_by: input.createdBy,
    p_reminder_at: reminderAt(settings, check.slot.startsAt, now)?.toISOString() ?? null,
    p_replace_id: input.replaceId ?? null,
  })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('has_live_appointment')) {
      throw new AppointmentError(
        'has_live_appointment',
        'This phone number already has an upcoming appointment',
        409,
      )
    }
    if (msg.includes('slot_full')) {
      throw new AppointmentError('slot_full', 'That time has just been taken', 409)
    }
    if (msg.includes('appointment_not_found')) {
      throw new AppointmentError('not_found', 'That appointment can no longer be changed', 404)
    }
    throw new Error(msg || 'Could not book the appointment')
  }
  const row = (Array.isArray(data) ? data[0] : data) as AppointmentRow | null
  if (!row?.id) throw new Error('Could not book the appointment')
  return row
}

export async function cancelAppointment(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<AppointmentRow | null> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('appointments')
    .update({ status: 'cancelled', cancelled_at: now, updated_at: now })
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('status', 'booked')
    .select('*')
  if (error) throw new Error(error.message)
  return ((data ?? [])[0] as AppointmentRow | undefined) ?? null
}

// ------------------------------------------------------------
// Messages to the customer
// ------------------------------------------------------------

export type AppointmentMessageKind = 'confirmed' | 'rescheduled' | 'cancelled' | 'reminder'

export function appointmentWhen(appt: Pick<AppointmentRow, 'starts_at'>, settings: AppointmentSettings) {
  const at = new Date(appt.starts_at)
  return { day: formatDay(at, settings.timezone), time: formatTime(at, settings.timezone) }
}

/** The plain-text message for each occasion. */
export function appointmentMessageText(
  kind: AppointmentMessageKind,
  appt: Pick<AppointmentRow, 'starts_at' | 'customer_name'>,
  settings: AppointmentSettings,
): string {
  const { day, time } = appointmentWhen(appt, settings)
  const name = appt.customer_name?.trim()
  const hello = name ? `Hello ${name},` : 'Hello,'
  const at = settings.business_name ? ` at ${settings.business_name}` : ''
  const address = settings.address ? `\nAddress: ${settings.address}` : ''
  switch (kind) {
    case 'confirmed':
      return `${hello} your appointment${at} is confirmed.\nDate: ${day}\nTime: ${time}${address}\n\nReply here if you need to change or cancel it.`
    case 'rescheduled':
      return `${hello} your appointment${at} has been moved.\nNew date: ${day}\nNew time: ${time}${address}\n\nReply here if you need to change or cancel it.`
    case 'cancelled':
      return `${hello} your appointment${at} on ${day} at ${time} has been cancelled. Reply here if you would like to book a new one.`
    case 'reminder':
      return `${hello} this is a reminder of your appointment${at}.\nDate: ${day}\nTime: ${time}${address}\n\nReply here if you need to change or cancel it.`
  }
}

/** Example wording a business can submit to Meta as a template. */
export const TEMPLATE_EXAMPLES = {
  confirm:
    'Hello {{1}}, your appointment is confirmed.\nDate: {{2}}\nTime: {{3}}\nAddress: {{4}}\nReply here if you need to change or cancel it.',
  reminder:
    'Hello {{1}}, this is a reminder of your appointment.\nDate: {{2}}\nTime: {{3}}\nAddress: {{4}}\nReply here if you need to change or cancel it.',
} as const

/**
 * Tell the customer about their appointment on the number it was booked
 * on. WhatsApp Web numbers send plain text. Business API numbers use
 * the chosen approved template when there is one (it works outside the
 * 24-hour window); without one they try plain text, which only reaches
 * a customer who wrote in the last 24 hours.
 *
 * Template body values: {{1}} name, {{2}} date, {{3}} time, {{4}} address.
 */
export async function sendAppointmentMessage(
  db: SupabaseClient,
  kind: AppointmentMessageKind,
  appt: AppointmentRow,
  settings: AppointmentSettings,
  senderId: string | null = null,
): Promise<void> {
  const channel = await loadChannel(db, appt.account_id, appt.channel_id)
  if (!channel) throw new Error('The WhatsApp number of this appointment was removed')

  const auditUserId = await resolveAuditUserId(db, appt.account_id)
  const conversation = await findOrCreateConversationRow(
    db,
    appt.account_id,
    appt.contact_id,
    auditUserId,
    appt.channel_id,
  )

  const useReminderTemplate = kind === 'reminder' && !!settings.reminder_template
  const useConfirmTemplate = (kind === 'confirmed' || kind === 'rescheduled') && !!settings.confirm_template
  if (channel.provider !== 'waha' && (useReminderTemplate || useConfirmTemplate)) {
    const { day, time } = appointmentWhen(appt, settings)
    await sendMessageToConversation(db, appt.account_id, {
      conversationId: conversation.id,
      channelId: appt.channel_id,
      messageType: 'template',
      templateName: useReminderTemplate ? settings.reminder_template : settings.confirm_template,
      templateLanguage:
        (useReminderTemplate ? settings.reminder_template_language : settings.confirm_template_language) || 'en_US',
      templateParams: [appt.customer_name?.trim() || 'there', day, time, settings.address || '-'],
      senderId,
    })
    return
  }

  await sendMessageToConversation(db, appt.account_id, {
    conversationId: conversation.id,
    channelId: appt.channel_id,
    messageType: 'text',
    contentText: appointmentMessageText(kind, appt, settings),
    senderId,
  })
}

// ------------------------------------------------------------
// Reminders (called by the 15-minute scheduler)
// ------------------------------------------------------------

/**
 * Send every reminder that has come due. Each row is claimed first (its
 * `reminder_sent_at` set in one conditional UPDATE), so two overlapping
 * scheduler calls can never remind the same customer twice.
 */
export async function runAppointmentReminders(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ due: number; sent: number; failed: number }> {
  const { data, error } = await db
    .from('appointments')
    .select('*')
    .eq('status', 'booked')
    .is('reminder_sent_at', null)
    .not('reminder_at', 'is', null)
    .lte('reminder_at', now.toISOString())
    .gt('starts_at', now.toISOString())
    .order('reminder_at', { ascending: true })
    .limit(100)
  if (error) throw new Error(error.message)
  const due = (data ?? []) as AppointmentRow[]
  let sent = 0
  let failed = 0
  const settingsByChannel = new Map<string, AppointmentSettings>()

  for (const appt of due) {
    const { data: claimed } = await db
      .from('appointments')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', appt.id)
      .eq('status', 'booked')
      .is('reminder_sent_at', null)
      .select('id')
    if (!claimed || claimed.length === 0) continue
    try {
      let settings = settingsByChannel.get(appt.channel_id)
      if (!settings) {
        settings = await loadAppointmentSettings(db, appt.account_id, appt.channel_id)
        settingsByChannel.set(appt.channel_id, settings)
      }
      await sendAppointmentMessage(db, 'reminder', appt, settings)
      sent++
    } catch (err) {
      failed++
      await db
        .from('appointments')
        .update({ reminder_error: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
        .eq('id', appt.id)
    }
  }
  return { due: due.length, sent, failed }
}
