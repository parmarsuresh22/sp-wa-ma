// ============================================================
// Event passes (migration 080): everything that touches the database
// or WhatsApp — creating events, holding places, issuing passes with
// their QR images, payment requests, approvals, the gate scan and the
// reminders.
//
// Server-only.
// ============================================================

import { randomBytes, randomInt } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'

import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts'
import { bold, localizeAppointmentText } from '@/lib/appointments/service'
import { formatDay, formatTime, type AppointmentSettings } from '@/lib/appointments/time'
import { loadChannel } from '@/lib/whatsapp/channels'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  CODE_ALPHABET,
  PASS_CODE_LENGTH,
  money,
  passQrText,
  upiLink,
  type EventInput,
  type EventRow,
  type OrderRow,
  type PassRow,
  type PassTypeRow,
  type ProofProblem,
} from './types'

const BUCKET = 'chat-media'
/** Between two pictures to the same chat. */
const SEND_GAP_MS = 1200

export class EventError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public detail: string | null = null,
  ) {
    super(message)
  }
}

export type EventWithTypes = EventRow & { pass_types: PassTypeRow[] }

export interface TypeStats {
  pass_type_id: string
  held: number
  issued: number
  used: number
  review: number
  awaiting: number
  revenue: number
}

function randomCode(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

export function normalizeEvent(row: Record<string, unknown>): EventWithTypes {
  const types = ((row.pass_types as Record<string, unknown>[] | null) ?? [])
    .map((t) => ({ ...t, price: Number(t.price), capacity: Number(t.capacity) }) as PassTypeRow)
    .sort((a, b) => a.position - b.position)
  return { ...(row as unknown as EventRow), pass_types: types }
}

export function normalizeOrder(row: Record<string, unknown>): OrderRow {
  return { ...(row as unknown as OrderRow), amount: Number(row.amount), proof: (row.proof as OrderRow['proof']) ?? {} }
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------

const EVENT_SELECT = '*, pass_types:event_pass_types(*)'

export async function loadEvent(db: SupabaseClient, accountId: string, eventId: string): Promise<EventWithTypes | null> {
  const { data, error } = await db
    .from('events')
    .select(EVENT_SELECT)
    .eq('account_id', accountId)
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw error
  return data ? normalizeEvent(data as Record<string, unknown>) : null
}

export async function listEvents(db: SupabaseClient, accountId: string, channelId: string): Promise<EventWithTypes[]> {
  const { data, error } = await db
    .from('events')
    .select(EVENT_SELECT)
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .order('starts_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeEvent)
}

export async function loadStats(db: SupabaseClient, accountId: string, eventIds: string[]): Promise<TypeStats[]> {
  if (eventIds.length === 0) return []
  const { data, error } = await db.rpc('event_stats', { p_account_id: accountId, p_event_ids: eventIds })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    pass_type_id: String(r.pass_type_id),
    held: Number(r.held),
    issued: Number(r.issued),
    used: Number(r.used),
    review: Number(r.review),
    awaiting: Number(r.awaiting),
    revenue: Number(r.revenue),
  }))
}

function eventColumns(input: EventInput) {
  return {
    name: input.name,
    description: input.description,
    venue: input.venue,
    starts_at: input.starts_at,
    timezone: input.timezone,
    apply_until: input.apply_until,
    status: input.status,
    chat_booking: input.chat_booking,
    max_per_phone: input.max_per_phone,
    upi_id: input.upi_id,
    upi_name: input.upi_name,
    auto_issue: input.auto_issue,
    hold_minutes: input.hold_minutes,
    notify_phone: input.notify_phone,
    reminder_hours: input.reminder_hours,
  }
}

export async function createEvent(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  input: EventInput,
  userId: string | null,
): Promise<EventWithTypes> {
  let eventId: string | null = null
  // The short code is random; on the rare clash, draw again.
  for (let attempt = 0; attempt < 4 && !eventId; attempt++) {
    const { data, error } = await db
      .from('events')
      .insert({
        ...eventColumns(input),
        account_id: accountId,
        channel_id: channelId,
        code: `EV${randomCode(4)}`,
        created_by: userId,
      })
      .select('id')
      .single()
    if (!error) eventId = (data as { id: string }).id
    else if (error.code !== '23505') throw error
  }
  if (!eventId) throw new EventError('busy', 'Could not create the event, please try again', 500)

  const { error: typeErr } = await db.from('event_pass_types').insert(
    input.pass_types.map((t, i) => ({
      account_id: accountId,
      event_id: eventId,
      position: i + 1,
      name: t.name,
      price: t.price,
      capacity: t.capacity,
      active: t.active,
    })),
  )
  if (typeErr) {
    await db.from('events').delete().eq('id', eventId)
    throw typeErr
  }
  return (await loadEvent(db, accountId, eventId)) as EventWithTypes
}

export async function updateEvent(
  db: SupabaseClient,
  current: EventWithTypes,
  input: EventInput,
): Promise<EventWithTypes> {
  const { error } = await db
    .from('events')
    .update({ ...eventColumns(input), updated_at: new Date().toISOString() })
    .eq('id', current.id)
  if (error) throw error

  const kept = new Set<string>()
  let position = current.pass_types.reduce((max, t) => Math.max(max, t.position), 0)
  for (const t of input.pass_types) {
    const existing = t.id ? current.pass_types.find((p) => p.id === t.id) : undefined
    if (existing) {
      kept.add(existing.id)
      const { error: upErr } = await db
        .from('event_pass_types')
        .update({ name: t.name, price: t.price, capacity: t.capacity, active: t.active })
        .eq('id', existing.id)
      if (upErr) throw upErr
    } else {
      position += 1
      const { error: insErr } = await db.from('event_pass_types').insert({
        account_id: current.account_id,
        event_id: current.id,
        position,
        name: t.name,
        price: t.price,
        capacity: t.capacity,
        active: t.active,
      })
      if (insErr) throw insErr
    }
  }
  // A type taken off the form: removed when nobody asked for it yet,
  // otherwise only closed (its passes stay valid).
  for (const t of current.pass_types) {
    if (kept.has(t.id)) continue
    const { error: delErr } = await db.from('event_pass_types').delete().eq('id', t.id)
    if (delErr) await db.from('event_pass_types').update({ active: false }).eq('id', t.id)
  }
  return (await loadEvent(db, current.account_id, current.id)) as EventWithTypes
}

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

const RESERVE_MESSAGES: Record<string, string> = {
  event_not_found: 'That event was not found',
  event_closed: 'This event is not taking requests',
  applications_closed: 'The last date to ask for passes has passed',
  pass_type_not_found: 'That pass type is not available',
  sold_out: 'Not enough places left',
  phone_limit: 'This phone number already has the most passes allowed',
  has_unpaid_order: 'This phone number already has a request waiting for payment',
}

export interface ReserveInput {
  event: EventWithTypes
  passTypeId: string
  contactId: string
  conversationId: string | null
  phoneKey: string
  customerName: string | null
  quantity: number
  source: 'ai' | 'portal'
  createdBy: string | null
  /** Overrides price × quantity (0 = complimentary). */
  amount?: number | null
}

/** Hold places for a request. Throws EventError with the reason when it cannot. */
export async function reserveOrder(db: SupabaseClient, input: ReserveInput): Promise<OrderRow> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await db.rpc('reserve_event_order', {
      p_account_id: input.event.account_id,
      p_event_id: input.event.id,
      p_pass_type_id: input.passTypeId,
      p_contact_id: input.contactId,
      p_conversation_id: input.conversationId,
      p_phone_key: input.phoneKey,
      p_customer_name: input.customerName,
      p_quantity: input.quantity,
      p_source: input.source,
      p_created_by: input.createdBy,
      p_code: randomCode(6),
      p_review_token: randomBytes(24).toString('hex'),
      p_amount: input.amount ?? null,
    })
    if (!error) return normalizeOrder(data as Record<string, unknown>)
    if (error.code === '23505') continue // order code clash: draw again
    const [code, detail] = (error.message ?? '').split(':')
    if (RESERVE_MESSAGES[code]) throw new EventError(code, RESERVE_MESSAGES[code], 409, detail ?? null)
    throw error
  }
  throw new EventError('busy', 'Could not save the request, please try again', 500)
}

export async function loadOrder(db: SupabaseClient, accountId: string, orderId: string): Promise<OrderRow | null> {
  const { data, error } = await db
    .from('event_orders')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  return data ? normalizeOrder(data as Record<string, unknown>) : null
}

export async function loadOrderByToken(db: SupabaseClient, token: string): Promise<OrderRow | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null
  const { data } = await db.from('event_orders').select('*').eq('review_token', token).maybeSingle()
  return data ? normalizeOrder(data as Record<string, unknown>) : null
}

/** The customer's request that is still waiting for its payment proof (the newest, within two days). */
export async function unpaidOrder(
  db: SupabaseClient,
  accountId: string,
  phoneKey: string,
  now: Date,
): Promise<OrderRow | null> {
  const { data } = await db
    .from('event_orders')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone_key', phoneKey)
    .eq('status', 'awaiting_payment')
    .gt('amount', 0)
    .gte('created_at', new Date(now.getTime() - 48 * 3_600_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
  const row = (data ?? [])[0] as Record<string, unknown> | undefined
  return row ? normalizeOrder(row) : null
}

/**
 * Turn a request into passes: the order becomes `issued` in one
 * conditional UPDATE (so approving twice, or a repeated screenshot,
 * still gives one set of passes) and one pass row is made per person.
 * Returns null when the order was already decided by someone else.
 */
export async function issueOrder(
  db: SupabaseClient,
  order: OrderRow,
  opts: { decidedBy?: string | null; patch?: Record<string, unknown> } = {},
): Promise<{ order: OrderRow; passes: PassRow[] } | null> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('event_orders')
    .update({
      ...(opts.patch ?? {}),
      status: 'issued',
      issued_at: now,
      decided_at: now,
      decided_by: opts.decidedBy ?? null,
      updated_at: now,
    })
    .eq('id', order.id)
    .in('status', ['awaiting_payment', 'review'])
    .select('*')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') throw new EventError('reference_used', 'This payment reference was already used for another order', 409)
    throw error
  }
  if (!data) return null
  const issued = normalizeOrder(data as Record<string, unknown>)

  const rows = Array.from({ length: issued.quantity }, (_, i) => ({
    account_id: issued.account_id,
    event_id: issued.event_id,
    order_id: issued.id,
    pass_type_id: issued.pass_type_id,
    seq: i + 1,
    code: randomCode(PASS_CODE_LENGTH),
    holder_name: issued.customer_name,
    phone_key: issued.phone_key,
  }))
  const { data: passes, error: passErr } = await db.from('event_passes').insert(rows).select('*')
  if (passErr) throw passErr
  return { order: issued, passes: ((passes ?? []) as PassRow[]).sort((a, b) => a.seq - b.seq) }
}

/** Put an order in the approval queue with its proof. False when the reference was already used. */
export async function moveToReview(
  db: SupabaseClient,
  order: OrderRow,
  patch: { payment_ref: string | null; proof_url: string | null; proof: OrderRow['proof'] },
): Promise<boolean> {
  const { error } = await db
    .from('event_orders')
    .update({ ...patch, status: 'review', updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'awaiting_payment')
  if (error) {
    if (error.code === '23505') return false
    throw error
  }
  return true
}

export async function closeOrder(
  db: SupabaseClient,
  order: OrderRow,
  status: 'rejected' | 'cancelled',
  decidedBy: string | null,
): Promise<boolean> {
  const now = new Date().toISOString()
  const { data } = await db
    .from('event_orders')
    .update({ status, decided_at: now, decided_by: decidedBy, updated_at: now })
    .eq('id', order.id)
    .in('status', ['awaiting_payment', 'review'])
    .select('id')
  return (data ?? []).length > 0
}

// ------------------------------------------------------------
// Messages
// ------------------------------------------------------------

async function qrImageUrl(db: SupabaseClient, accountId: string, path: string, text: string): Promise<string> {
  const png = await QRCode.toBuffer(text, { type: 'png', width: 720, margin: 3, errorCorrectionLevel: 'M' })
  const full = `account-${accountId}/events/${path}`
  const { error } = await db.storage.from(BUCKET).upload(full, png, {
    contentType: 'image/png',
    cacheControl: '31536000',
    upsert: true,
  })
  if (error) throw new Error(`QR image could not be saved: ${error.message}`)
  return db.storage.from(BUCKET).getPublicUrl(full).data.publicUrl
}

async function conversationFor(db: SupabaseClient, event: EventRow, order: OrderRow): Promise<string> {
  if (order.conversation_id) return order.conversation_id
  if (!order.contact_id) throw new Error('The contact of this order was deleted')
  const auditUserId = await resolveAuditUserId(db, event.account_id)
  const conversation = await findOrCreateConversationRow(db, event.account_id, order.contact_id, auditUserId, event.channel_id)
  await db.from('event_orders').update({ conversation_id: conversation.id }).eq('id', order.id)
  return conversation.id
}

/** In the language the customer writes in (English when unsure). */
function localize(db: SupabaseClient, event: EventRow, conversationId: string, text: string): Promise<string> {
  return localizeAppointmentText(db, event.account_id, conversationId, { reply_language: 'auto' } as AppointmentSettings, text)
}

export function eventWhen(event: Pick<EventRow, 'starts_at' | 'timezone'>): { day: string; time: string } {
  const at = new Date(event.starts_at)
  return { day: formatDay(at, event.timezone), time: formatTime(at, event.timezone) }
}

function typeName(event: EventWithTypes, order: Pick<OrderRow, 'pass_type_id'>): string {
  return event.pass_types.find((t) => t.id === order.pass_type_id)?.name ?? 'Pass'
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function noteMessageError(db: SupabaseClient, orderId: string, err: unknown | null): Promise<string | null> {
  const message = err ? (err instanceof Error ? err.message : String(err)).slice(0, 300) : null
  await db.from('event_orders').update({ message_error: message }).eq('id', orderId)
  return message
}

export async function sendEventText(
  db: SupabaseClient,
  event: EventRow,
  order: OrderRow,
  text: string,
  senderId: string | null = null,
): Promise<void> {
  const conversationId = await conversationFor(db, event, order)
  await sendMessageToConversation(db, event.account_id, {
    conversationId,
    channelId: event.channel_id,
    messageType: 'text',
    contentText: await localize(db, event, conversationId, text),
    senderId,
  })
}

/**
 * Send the UPI QR for a paid request: amount and order number filled
 * in, plus the UPI ID in words for someone who cannot scan their own
 * screen. Returns the reason when it could not be sent.
 */
export async function sendPaymentRequest(
  db: SupabaseClient,
  event: EventWithTypes,
  order: OrderRow,
  senderId: string | null = null,
): Promise<string | null> {
  try {
    if (!event.upi_id) throw new Error('This event has no UPI ID to pay to')
    const conversationId = await conversationFor(db, event, order)
    const link = await qrImageUrl(
      db,
      event.account_id,
      `${event.id}/pay-${order.code}.png`,
      upiLink({ upiId: event.upi_id, name: event.upi_name, amount: order.amount, note: `Order ${order.code}` }),
    )
    const caption = [
      `${bold('Pay here')} - ${bold(money(order.amount))}`,
      `${order.quantity} x ${typeName(event, order)}, ${bold(event.name)}`,
      `Order ${order.code}`,
      '',
      `Scan this QR in any UPI app (to scan from this phone: save the picture, then in your UPI app choose Scan and pick it from the gallery), or pay ${bold(money(order.amount))} to UPI ID ${bold(event.upi_id)}.`,
      '',
      `After paying, send the payment screenshot here. Your places are held for ${event.hold_minutes} minutes.`,
    ].join('\n')
    await sendMessageToConversation(db, event.account_id, {
      conversationId,
      channelId: event.channel_id,
      messageType: 'image',
      mediaUrl: link,
      contentText: await localize(db, event, conversationId, caption),
      senderId,
    })
    return await noteMessageError(db, order.id, null)
  } catch (err) {
    console.error('[events] payment request not sent:', err instanceof Error ? err.message : err)
    return await noteMessageError(db, order.id, err)
  }
}

/** Send one QR picture per pass. Returns the reason when a pass could not be sent. */
export async function sendPasses(
  db: SupabaseClient,
  event: EventWithTypes,
  order: OrderRow,
  passes: PassRow[],
  senderId: string | null = null,
): Promise<string | null> {
  try {
    const conversationId = await conversationFor(db, event, order)
    const { day, time } = eventWhen(event)
    const total = passes.length
    const caption = (n: number) =>
      [
        `${bold('Your entry pass')} ${n}/${total}`,
        bold(event.name),
        `Date: ${bold(day)}`,
        `Time: ${bold(time)}`,
        event.venue ? `Venue: ${event.venue}` : '',
        `Pass: ${typeName(event, order)}`,
        order.customer_name ? `Name: ${order.customer_name}` : '',
        '',
        'Show this QR at the entry. It admits one person, once - please do not share it.',
      ]
        .filter((line, i, all) => line !== '' || all[i - 1] !== '')
        .join('\n')
    // Translate once and reuse it for the other passes of the order.
    const first = await localize(db, event, conversationId, caption(1))
    const marker = `1/${total}`
    for (const pass of passes) {
      const link = await qrImageUrl(db, event.account_id, `${event.id}/${pass.code}.png`, passQrText(pass.code))
      const text =
        pass.seq === 1 ? first : first.includes(marker) ? first.replace(marker, `${pass.seq}/${total}`) : caption(pass.seq)
      await sendMessageToConversation(db, event.account_id, {
        conversationId,
        channelId: event.channel_id,
        messageType: 'image',
        mediaUrl: link,
        contentText: text,
        senderId,
      })
      if (pass.seq < total) await pause(SEND_GAP_MS)
    }
    return await noteMessageError(db, order.id, null)
  } catch (err) {
    console.error('[events] passes not sent:', err instanceof Error ? err.message : err)
    return await noteMessageError(db, order.id, err)
  }
}

export async function passesOfOrder(db: SupabaseClient, orderId: string): Promise<PassRow[]> {
  const { data } = await db.from('event_passes').select('*').eq('order_id', orderId).order('seq', { ascending: true })
  return (data ?? []) as PassRow[]
}

/** Approve a request: issue its passes and send them. */
export async function approveOrder(
  db: SupabaseClient,
  event: EventWithTypes,
  order: OrderRow,
  decidedBy: string | null,
): Promise<{ order: OrderRow; message_error: string | null } | null> {
  const done = await issueOrder(db, order, { decidedBy })
  if (!done) return null
  const messageError = await sendPasses(db, event, done.order, done.passes, decidedBy)
  return { order: done.order, message_error: messageError }
}

/** Refuse a payment proof and tell the customer. */
export async function rejectOrder(
  db: SupabaseClient,
  event: EventWithTypes,
  order: OrderRow,
  decidedBy: string | null,
): Promise<{ message_error: string | null } | null> {
  if (!(await closeOrder(db, order, 'rejected', decidedBy))) return null
  try {
    await sendEventText(
      db,
      event,
      order,
      `We could not confirm the payment for your order ${order.code} (${order.quantity} x ${typeName(event, order)}, ${bold(event.name)}), so no pass was issued. If you have paid, please reply here with the payment screenshot showing the amount and the reference number.`,
      decidedBy,
    )
    return { message_error: await noteMessageError(db, order.id, null) }
  } catch (err) {
    return { message_error: await noteMessageError(db, order.id, err) }
  }
}

// ------------------------------------------------------------
// Telling the business about a payment to check
// ------------------------------------------------------------

export const PROBLEM_TEXT: Record<ProofProblem | 'reference_used', string> = {
  unread: 'the screenshot could not be read automatically',
  not_payment: 'the picture does not look like a payment receipt',
  not_successful: 'the payment does not show as successful',
  amount_missing: 'the amount could not be read',
  amount_mismatch: 'the amount is different from the order',
  utr_missing: 'no reference number could be read',
  payee_unread: 'who was paid could not be read',
  payee_mismatch: 'it looks paid to a different UPI ID or name',
  date_missing: 'the date could not be read',
  old_date: 'the payment date is not today or yesterday',
  paid_late: 'paid after the places were released',
  typed_reference: 'only a reference number was typed, no screenshot',
  reference_used: 'this reference number was already used',
}

/** The portal's own address, for links in messages (null when it is not known). */
export function portalOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim()
  return host ? `https://${host}` : null
}

/**
 * Message the approval number about a payment waiting for a person:
 * the details, what did not match, and a link that opens a page with
 * Approve and Reject. Never throws.
 */
export async function notifyReviewer(db: SupabaseClient, event: EventWithTypes, order: OrderRow): Promise<void> {
  try {
    if (!event.notify_phone) return
    const channel = await loadChannel(db, event.account_id, event.channel_id)
    if (!channel) return
    const digits = event.notify_phone.replace(/\D/g, '')
    const own = (channel.display_phone ?? '').replace(/\D/g, '')
    const country = own.length > 10 ? own.slice(0, own.length - 10) : '91'
    const phone = digits.length === 10 ? `+${country}${digits}` : `+${digits}`

    const auditUserId = await resolveAuditUserId(db, event.account_id)
    const contact = await findOrCreateContact(db, event.account_id, auditUserId, { phone, name: null })
    const conversation = await findOrCreateConversationRow(db, event.account_id, contact.id, auditUserId, event.channel_id)

    const problems = order.proof.problems ?? []
    const origin = portalOrigin()
    const text = [
      `${bold('Payment to check')} - order ${order.code}`,
      `Event: ${bold(event.name)}`,
      `From: ${order.customer_name ?? 'Customer'} (${order.phone_key})`,
      `Passes: ${order.quantity} x ${typeName(event, order)}`,
      `Amount: ${bold(money(order.amount))}`,
      order.payment_ref ? `Reference: ${order.payment_ref}` : '',
      problems.length === 0
        ? 'Checks: amount, payee, reference and date all match.'
        : `Please look at: ${problems.map((p) => PROBLEM_TEXT[p as ProofProblem] ?? p).join('; ')}.`,
      '',
      origin
        ? `Approve or reject: ${origin}/pass-review/${order.review_token}`
        : 'Open Events in the portal to approve or reject.',
    ]
      .filter((line, i, all) => line !== '' || all[i - 1] !== '')
      .join('\n')

    const picture = order.proof_url && /^https:\/\//.test(order.proof_url) ? order.proof_url : null
    await sendMessageToConversation(db, event.account_id, {
      conversationId: conversation.id,
      channelId: event.channel_id,
      messageType: picture ? 'image' : 'text',
      mediaUrl: picture,
      contentText: text,
      senderId: null,
    })
  } catch (err) {
    console.error('[events] approval notice not sent:', err instanceof Error ? err.message : err)
  }
}

// ------------------------------------------------------------
// The gate
// ------------------------------------------------------------

export interface ScanResult {
  result: 'ok' | 'used' | 'cancelled' | 'wrong_event' | 'unknown'
  pass?: {
    id: string
    holder_name: string | null
    phone_key: string
    seq: number
    status: string
    used_at: string | null
    pass_type: string | null
    quantity: number | null
    event_name: string | null
  }
}

export async function checkIn(
  db: SupabaseClient,
  accountId: string,
  eventId: string,
  code: string,
  userId: string | null,
): Promise<ScanResult> {
  const { data, error } = await db.rpc('check_in_event_pass', {
    p_account_id: accountId,
    p_event_id: eventId,
    p_code: code,
    p_user: userId,
  })
  if (error) throw error
  return data as ScanResult
}

// ------------------------------------------------------------
// Reminders (called by the 15-minute scheduler)
// ------------------------------------------------------------

/** How many reminders one scheduler call sends, so a big event is spread out. */
const REMINDERS_PER_RUN = 40

/**
 * Remind pass holders of events that start within their reminder
 * window. Each order is claimed first (`reminded_at` set in one
 * conditional UPDATE), so overlapping calls never remind twice.
 */
export async function runEventReminders(db: SupabaseClient, now: Date): Promise<{ due: number; sent: number; failed: number }> {
  const { data } = await db
    .from('events')
    .select(EVENT_SELECT)
    .neq('status', 'cancelled')
    .gt('reminder_hours', 0)
    .gt('starts_at', now.toISOString())
    .lte('starts_at', new Date(now.getTime() + 168 * 3_600_000).toISOString())
  const events = ((data ?? []) as Record<string, unknown>[])
    .map(normalizeEvent)
    .filter((e) => Date.parse(e.starts_at) - e.reminder_hours * 3_600_000 <= now.getTime())

  let due = 0
  let sent = 0
  let failed = 0
  for (const event of events) {
    if (sent + failed >= REMINDERS_PER_RUN) break
    const { data: orders } = await db
      .from('event_orders')
      .select('*')
      .eq('event_id', event.id)
      .eq('status', 'issued')
      .is('reminded_at', null)
      .order('created_at', { ascending: true })
      .limit(REMINDERS_PER_RUN - sent - failed)
    for (const raw of (orders ?? []) as Record<string, unknown>[]) {
      const order = normalizeOrder(raw)
      const { data: claimed } = await db
        .from('event_orders')
        .update({ reminded_at: now.toISOString() })
        .eq('id', order.id)
        .is('reminded_at', null)
        .select('id')
      if ((claimed ?? []).length === 0) continue
      due += 1
      try {
        const { day, time } = eventWhen(event)
        await sendEventText(
          db,
          event,
          order,
          [
            `Reminder: ${bold(event.name)} is on ${bold(day)} at ${bold(time)}.`,
            event.venue ? `Venue: ${event.venue}` : '',
            `You have ${order.quantity} ${order.quantity === 1 ? 'pass' : 'passes'} (${typeName(event, order)}). Please keep the QR ${order.quantity === 1 ? 'picture' : 'pictures'} sent here ready at the entry.`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        sent += 1
      } catch (err) {
        failed += 1
        console.warn('[events] reminder not sent:', err instanceof Error ? err.message : err)
      }
      await pause(SEND_GAP_MS)
    }
  }
  return { due, sent, failed }
}
