// ============================================================
// Service Today (migration 081): shapes, input checks, dates and the
// wording of the messages. Pure — used by the server, the screen and
// the tests.
// ============================================================

export type ServiceLanguage = 'en' | 'hi'

export interface ServiceSettings {
  id: string | null
  channel_id: string
  business_name: string
  address: string
  language: ServiceLanguage
  timezone: string
  reminder_time: string
}

export interface ServiceCustomer {
  id: string
  channel_id: string
  contact_id: string
  phone_key: string
  name: string
  area: string | null
  status: 'active' | 'inactive'
  created_at: string
}

export interface ServiceVisit {
  id: string
  channel_id: string
  customer_id: string
  service: string
  area: string | null
  visit_date: string
  next_visit: string
  comment: string | null
  images: string[]
  status: 'active' | 'inactive'
  rem1_sent_for: string | null
  rem0_sent_for: string | null
  rem1_sent_at: string | null
  rem0_sent_at: string | null
  message_error: string | null
  created_at: string
}

export const MAX_VISIT_IMAGES = 3
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** YYYY-MM-DD and minutes since midnight of an instant in a time zone. */
export function localDay(at: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** The same day some months later; the 31st of a short month lands on its last day. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10)
}

/** 2026-11-25 → 25/11/2026 */
export function indianDate(date: string | null | undefined): string {
  if (!date || !DATE_RE.test(date)) return '-'
  const [y, m, d] = date.split('-')
  return `${d}/${m}/${y}`
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export interface BusinessInput {
  business_name: string
  address: string
  language: ServiceLanguage
  reminder_time: string
}

export function parseBusinessInput(raw: unknown): Parsed<BusinessInput> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const business_name = text(r.name ?? r.business_name, 60)
  const address = text(r.address, 200)
  if (!business_name || !address) return { ok: false, error: 'Fill in both the business name and the address' }
  const reminder_time = text(r.reminder_time, 5) || '09:00'
  if (!TIME_RE.test(reminder_time)) return { ok: false, error: 'Choose a valid reminder time' }
  return { ok: true, value: { business_name, address, language: r.language === 'hi' ? 'hi' : 'en', reminder_time } }
}

export interface VisitInput {
  service: string
  area: string | null
  visit_date: string
  next_visit: string
  comment: string | null
  customer_name: string
  images: string[]
}

/**
 * One visit as typed on the screen. Field names follow the original
 * Service Today contract (customerName, visitDate, nextVisit…).
 */
export function parseVisitInput(raw: unknown): Parsed<VisitInput> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const customer_name = text(r.customerName, 50)
  if (!customer_name) return { ok: false, error: 'Fill in the customer name' }
  const service = text(r.service, 80)
  if (!service) return { ok: false, error: 'Fill in the service or device' }
  const visit_date = text(r.visitDate, 10)
  const next_visit = text(r.nextVisit, 10)
  if (!DATE_RE.test(visit_date)) return { ok: false, error: 'Choose the visit date' }
  if (!DATE_RE.test(next_visit)) return { ok: false, error: 'Choose the next visit date' }
  if (next_visit < visit_date) return { ok: false, error: 'The next visit cannot be before the visit date' }
  const images = (Array.isArray(r.images) ? r.images : [])
    .filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u))
    .slice(0, MAX_VISIT_IMAGES)
  return {
    ok: true,
    value: { customer_name, service, area: text(r.area, 80) || null, visit_date, next_visit, comment: text(r.comment, 300) || null, images },
  }
}

export type ServiceMessageKind = 'saved' | 'due_tomorrow' | 'due_today'

/** WhatsApp bold; an asterisk inside would end it early. */
const bold = (s: string) => `*${s.replace(/[*]/g, '').trim()}*`

export function serviceMessage(
  kind: ServiceMessageKind,
  settings: Pick<ServiceSettings, 'business_name' | 'address' | 'language'>,
  input: { customerName: string; service: string; visitDate: string; nextVisit: string },
): string {
  const name = input.customerName.trim()
  const biz = bold(settings.business_name)
  const next = bold(indianDate(input.nextVisit))
  const service = input.service.trim()
  if (settings.language === 'hi') {
    const hello = name ? `नमस्ते ${name},` : 'नमस्ते,'
    switch (kind) {
      case 'saved':
        return `${hello}\n${biz} की सेवा लेने के लिए धन्यवाद।\n\nसर्विस: ${service}\nतारीख: ${bold(indianDate(input.visitDate))}\nअगली सर्विस: ${next}\n\nअगली सर्विस से पहले हम आपको यहाँ याद दिला देंगे।\n${settings.address}`
      case 'due_tomorrow':
        return `${hello}\n${biz} की ओर से रिमाइंडर: आपकी ${service} की सर्विस *कल*, ${next} को होनी है।\n\nसमय तय करने के लिए यहाँ जवाब दें।`
      case 'due_today':
        return `${hello}\n${biz} की ओर से रिमाइंडर: आपकी ${service} की सर्विस *आज*, ${next} को होनी है।\n\nसमय तय करने के लिए यहाँ जवाब दें।`
    }
  }
  const hello = name ? `Hello ${name},` : 'Hello,'
  switch (kind) {
    case 'saved':
      return `${hello}\nthank you for choosing ${biz}.\n\nService: ${service}\nDate: ${bold(indianDate(input.visitDate))}\nNext service due: ${next}\n\nWe will remind you here before the next service.\n${settings.address}`
    case 'due_tomorrow':
      return `${hello}\na reminder from ${biz}: your ${service} service is due *tomorrow*, ${next}.\n\nReply here to fix a time.`
    case 'due_today':
      return `${hello}\na reminder from ${biz}: your ${service} service is due *today*, ${next}.\n\nReply here to fix a time.`
  }
}

/**
 * Which reminder a visit is owed right now, if any. Reminders start at
 * the business's reminder time; each goes out once per next-visit date,
 * so moving the date makes the visit due for its reminders again.
 */
export function reminderDue(
  visit: Pick<ServiceVisit, 'next_visit' | 'rem0_sent_for' | 'rem1_sent_for' | 'status'>,
  now: { date: string; minutes: number },
  reminderTime: string,
): 'due_today' | 'due_tomorrow' | null {
  if (visit.status !== 'active') return null
  const [h, m] = reminderTime.split(':').map(Number)
  if (now.minutes < h * 60 + m) return null
  if (visit.next_visit === now.date) return visit.rem0_sent_for === visit.next_visit ? null : 'due_today'
  if (visit.next_visit === addDays(now.date, 1)) return visit.rem1_sent_for === visit.next_visit ? null : 'due_tomorrow'
  return null
}
