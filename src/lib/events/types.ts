// ============================================================
// Event passes (migration 080): shapes and the rules that need no
// database — what a pass QR holds, the UPI payment link, tidying an
// event form, and judging what was read from a payment screenshot.
//
// Pure module — safe to import from server and client code.
// ============================================================

import { DATE_RE, TIME_RE, isValidTimezone, localToUtc } from '@/lib/appointments/time'

export type EventStatus = 'open' | 'closed' | 'cancelled'
export type OrderStatus = 'awaiting_payment' | 'review' | 'issued' | 'rejected' | 'cancelled'
export type PassStatus = 'valid' | 'used' | 'cancelled'

export interface PassTypeRow {
  id: string
  event_id: string
  position: number
  name: string
  price: number
  capacity: number
  active: boolean
}

export interface EventRow {
  id: string
  account_id: string
  channel_id: string
  code: string
  name: string
  description: string | null
  venue: string | null
  starts_at: string
  timezone: string
  apply_until: string | null
  status: EventStatus
  chat_booking: boolean
  max_per_phone: number
  upi_id: string | null
  upi_name: string | null
  auto_issue: boolean
  hold_minutes: number
  notify_phone: string | null
  reminder_hours: number
  created_at: string
}

export interface ProofReading {
  /** The picture is a UPI / bank payment receipt. */
  is_payment: boolean
  status: 'success' | 'failed' | 'pending' | 'unknown'
  amount: number | null
  /** The 12-digit UPI reference number (UTR). */
  utr: string | null
  payee_upi: string | null
  payee_name: string | null
  /** YYYY-MM-DD as shown on the receipt. */
  paid_on: string | null
}

export interface OrderProof {
  reading?: ProofReading | null
  /** Why the proof could not be accepted without a person looking. */
  problems?: string[]
  /** 'screenshot' or 'typed' (the customer typed the reference number). */
  via?: string
}

export interface OrderRow {
  id: string
  account_id: string
  event_id: string
  pass_type_id: string
  contact_id: string | null
  conversation_id: string | null
  phone_key: string
  customer_name: string | null
  code: string
  quantity: number
  amount: number
  status: OrderStatus
  source: 'ai' | 'portal'
  expires_at: string | null
  payment_ref: string | null
  proof_url: string | null
  proof: OrderProof
  review_token: string
  decided_at: string | null
  issued_at: string | null
  message_error: string | null
  created_at: string
}

export interface PassRow {
  id: string
  account_id: string
  event_id: string
  order_id: string
  pass_type_id: string
  seq: number
  code: string
  holder_name: string | null
  phone_key: string
  status: PassStatus
  used_at: string | null
  created_at: string
}

// ------------------------------------------------------------
// The pass QR
// ------------------------------------------------------------

/** No 0/O, 1/I/L — a code read out over the phone stays unambiguous. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PASS_CODE_LENGTH = 20
const PASS_PREFIX = 'ATLASPASS:'
const PASS_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${PASS_CODE_LENGTH}}$`)

/** What the QR image of a pass holds. */
export function passQrText(code: string): string {
  return `${PASS_PREFIX}${code}`
}

/** The pass code inside a scanned QR (or a typed code); null when it is not one of ours. */
export function parsePassQr(scanned: string): string | null {
  let text = scanned.trim()
  if (text.toUpperCase().startsWith(PASS_PREFIX)) text = text.slice(PASS_PREFIX.length)
  text = text.replace(/[\s-]/g, '').toUpperCase()
  return PASS_CODE_RE.test(text) ? text : null
}

// ------------------------------------------------------------
// Money and UPI
// ------------------------------------------------------------

/** "₹1,000" / "₹499.50". */
export function money(amount: number): string {
  const whole = Number.isInteger(amount)
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

export function isUpiId(value: string): boolean {
  return /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/i.test(value.trim())
}

/** The link a UPI app opens (and the text of the payment QR): amount and note filled in. */
export function upiLink(args: { upiId: string; name?: string | null; amount: number; note: string }): string {
  const q = new URLSearchParams({
    pa: args.upiId.trim(),
    pn: (args.name ?? '').trim() || args.upiId.trim(),
    am: args.amount.toFixed(2),
    cu: 'INR',
    tn: args.note.slice(0, 50),
  })
  // UPI apps expect %20, not "+", for spaces, and the "@" of the ID as it is.
  return `upi://pay?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`
}

// ------------------------------------------------------------
// Judging a payment screenshot
// ------------------------------------------------------------

export type ProofProblem =
  | 'unread'
  | 'not_payment'
  | 'not_successful'
  | 'amount_missing'
  | 'amount_mismatch'
  | 'utr_missing'
  | 'payee_unread'
  | 'payee_mismatch'
  | 'date_missing'
  | 'old_date'
  | 'paid_late'
  | 'typed_reference'

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
}

function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * Compare what was read from a screenshot with the order. An empty
 * list means every check passed: right amount, paid to this business,
 * a reference number, dated today or yesterday. Anything unreadable
 * counts as a problem — a pass is only issued automatically when
 * nothing is left to doubt.
 */
export function checkProof(
  reading: ProofReading | null,
  order: { amount: number; upiId: string | null; upiName: string | null; today: string },
): ProofProblem[] {
  if (!reading) return ['unread']
  if (!reading.is_payment) return ['not_payment']
  const problems: ProofProblem[] = []
  if (reading.status === 'failed' || reading.status === 'pending') problems.push('not_successful')

  if (reading.amount == null) problems.push('amount_missing')
  else if (Math.abs(reading.amount - order.amount) > 0.009) problems.push('amount_mismatch')

  if (!reading.utr) problems.push('utr_missing')

  const wantUpi = (order.upiId ?? '').trim().toLowerCase()
  const gotUpi = (reading.payee_upi ?? '').trim().toLowerCase()
  // Some apps mask the ID ("xxxx1234@okaxis"): that proves nothing either way.
  const upiReadable = gotUpi.includes('@') && !/[x*•]{3,}/.test(gotUpi)
  const wantName = words(order.upiName ?? '')
  const gotName = words(reading.payee_name ?? '')
  if (upiReadable && wantUpi) {
    if (gotUpi !== wantUpi) problems.push('payee_mismatch')
  } else if (wantName.length > 0 && gotName.length > 0) {
    if (!wantName.some((w) => gotName.includes(w))) problems.push('payee_mismatch')
  } else {
    problems.push('payee_unread')
  }

  if (!reading.paid_on) problems.push('date_missing')
  else if (reading.paid_on !== order.today && reading.paid_on !== dayBefore(order.today)) problems.push('old_date')

  return problems
}

/** A 12-digit UPI reference number typed in a message. */
export function referenceInText(text: string): string | null {
  const match = text.replace(/[\s-]/g, ' ').match(/(?<!\d)\d{12}(?!\d)/)
  return match ? match[0] : null
}

// ------------------------------------------------------------
// The event form
// ------------------------------------------------------------

export interface PassTypeInput {
  id?: string
  name: string
  price: number
  capacity: number
  active: boolean
}

export interface EventInput {
  name: string
  description: string | null
  venue: string | null
  starts_at: string
  timezone: string
  apply_until: string | null
  status: EventStatus
  chat_booking: boolean
  max_per_phone: number
  upi_id: string | null
  upi_name: string | null
  auto_issue: boolean
  hold_minutes: number
  notify_phone: string | null
  reminder_hours: number
  pass_types: PassTypeInput[]
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Tidy an event coming from the form. Returns the cleaned event, or
 * the sentence to show when something is missing or wrong.
 */
export function parseEventInput(raw: unknown): { ok: true; value: EventInput } | { ok: false; error: string } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fail = (error: string) => ({ ok: false as const, error })

  const name = text(body.name, 120)
  if (!name) return fail('Give the event a name')
  const date = text(body.date, 10)
  const time = text(body.time, 5)
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return fail('Choose the date and time of the event')
  const timezone = text(body.timezone, 64) || 'Asia/Kolkata'
  if (!isValidTimezone(timezone)) return fail('That timezone is not valid')
  const startsAt = localToUtc(date, time, timezone)

  let applyUntil: string | null = null
  const untilDate = text(body.apply_until_date, 10)
  if (untilDate) {
    const untilTime = text(body.apply_until_time, 5) || '23:59'
    if (!DATE_RE.test(untilDate) || !TIME_RE.test(untilTime)) return fail('The last date to apply is not valid')
    const until = localToUtc(untilDate, untilTime, timezone)
    if (until.getTime() > startsAt.getTime()) return fail('The last date to apply must be before the event starts')
    applyUntil = until.toISOString()
  }

  const status = body.status === 'closed' || body.status === 'cancelled' ? body.status : 'open'

  const rawTypes = Array.isArray(body.pass_types) ? body.pass_types : []
  const passTypes: PassTypeInput[] = []
  for (const item of rawTypes.slice(0, 12)) {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const typeName = text(row.name, 60)
    if (!typeName) continue
    const price = typeof row.price === 'number' ? row.price : Number(row.price ?? 0)
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000) return fail(`The price of "${typeName}" is not valid`)
    const capacity = int(row.capacity, 0, 100_000, 0)
    if (capacity < 1) return fail(`Say how many "${typeName}" passes there are`)
    passTypes.push({
      id: typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) ? row.id : undefined,
      name: typeName,
      price: Math.round(price * 100) / 100,
      capacity,
      active: row.active !== false,
    })
  }
  if (passTypes.length === 0) return fail('Add at least one pass type')
  const names = passTypes.map((p) => p.name.toLowerCase())
  if (new Set(names).size !== names.length) return fail('Two pass types have the same name')

  const upiId = text(body.upi_id, 120).toLowerCase()
  if (upiId && !isUpiId(upiId)) return fail('That UPI ID does not look right (example: name@okaxis)')
  const paid = passTypes.some((p) => p.active && p.price > 0)
  if (paid && !upiId) return fail('Enter the UPI ID that paid passes are paid to')

  const notifyDigits = text(body.notify_phone, 30).replace(/\D/g, '')
  if (notifyDigits && notifyDigits.length < 10) return fail('The approval number needs at least 10 digits')

  return {
    ok: true,
    value: {
      name,
      description: text(body.description, 1000) || null,
      venue: text(body.venue, 300) || null,
      starts_at: startsAt.toISOString(),
      timezone,
      apply_until: applyUntil,
      status,
      chat_booking: body.chat_booking !== false,
      max_per_phone: int(body.max_per_phone, 1, 50, 5),
      upi_id: upiId || null,
      upi_name: text(body.upi_name, 80) || null,
      auto_issue: body.auto_issue === true,
      hold_minutes: int(body.hold_minutes, 5, 1440, 30),
      notify_phone: notifyDigits || null,
      reminder_hours: int(body.reminder_hours, 0, 168, 0),
      pass_types: passTypes,
    },
  }
}
