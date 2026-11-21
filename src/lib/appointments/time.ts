// ============================================================
// Appointment clock arithmetic (migration 073). Pure functions: no
// database, no network — everything here is unit-tested.
//
// A business keeps its diary in its own timezone ("3 pm" means 3 pm
// there), while the database stores instants. These helpers convert
// between the two with `Intl`, so daylight-saving zones work too.
// ============================================================

export type ReminderMode = 'none' | 'same_day' | 'day_before'

/** [open, close] in "HH:MM", in the business's timezone. */
export type HoursRange = [string, string]

export interface AppointmentSettings {
  id: string | null
  account_id: string
  channel_id: string
  enabled: boolean
  business_name: string | null
  address: string | null
  timezone: string
  slot_minutes: number
  slot_capacity: number
  days_ahead: number
  /** Key = day of the week, "0" Sunday … "6" Saturday. */
  hours: Record<string, HoursRange[]>
  holidays: string[]
  reminder_mode: ReminderMode
  reminder_time: string
  /** 'auto' (the customer's own language) or a key of REPLY_LANGUAGES. */
  reply_language: string
  confirm_template: string | null
  confirm_template_language: string | null
  reminder_template: string | null
  reminder_template_language: string | null
}

/**
 * Languages the assistant can be told to answer in. The value is what
 * the model is told; the key is what is stored.
 */
export const REPLY_LANGUAGES: Record<string, string> = {
  english: 'English',
  hindi: 'Hindi (Devanagari script)',
  hinglish: 'Hinglish (Hindi written in English letters)',
  gujarati: 'Gujarati',
  marathi: 'Marathi',
  punjabi: 'Punjabi',
  bengali: 'Bengali',
  tamil: 'Tamil',
  telugu: 'Telugu',
  kannada: 'Kannada',
  malayalam: 'Malayalam',
  odia: 'Odia',
  assamese: 'Assamese',
  urdu: 'Urdu',
  nepali: 'Nepali',
  arabic: 'Arabic',
  spanish: 'Spanish',
  portuguese: 'Portuguese',
  french: 'French',
}

export const DEFAULT_HOURS: Record<string, HoursRange[]> = {
  '1': [['10:00', '18:00']],
  '2': [['10:00', '18:00']],
  '3': [['10:00', '18:00']],
  '4': [['10:00', '18:00']],
  '5': [['10:00', '18:00']],
  '6': [['10:00', '14:00']],
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

export function timeOf(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string
  /** HH:MM (24 h) */
  time: string
  /** 0 Sunday … 6 Saturday */
  weekday: number
}

/** What the wall clock in `tz` shows at the instant `at`. */
export function localParts(at: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday,
  }
}

/** The instant at which the wall clock in `tz` shows `date` `time`. */
export function localToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wanted = Date.UTC(y, mo - 1, d, h, mi)
  // Start from "as if UTC", then correct by the zone's offset at that
  // moment; a second pass settles the hour around a clock change.
  let guess = wanted
  for (let i = 0; i < 3; i++) {
    const shown = localParts(new Date(guess), tz)
    const [sy, smo, sd] = shown.date.split('-').map(Number)
    const [sh, smi] = shown.time.split(':').map(Number)
    const diff = wanted - Date.UTC(sy, smo - 1, sd, sh, smi)
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

/** `date` moved by whole days (calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** Day of the week of a calendar date, 0 Sunday … 6 Saturday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export interface Slot {
  date: string
  time: string
  startsAt: Date
  endsAt: Date
}

/** Every slot the business offers on `date` (open or not is decided later). */
export function daySlots(
  settings: Pick<AppointmentSettings, 'hours' | 'holidays' | 'slot_minutes' | 'timezone'>,
  date: string,
): Slot[] {
  if (!DATE_RE.test(date)) return []
  if (settings.holidays.includes(date)) return []
  const ranges = settings.hours[String(weekdayOf(date))] ?? []
  const step = Math.max(5, settings.slot_minutes)
  const slots: Slot[] = []
  const seen = new Set<string>()
  for (const range of ranges) {
    if (!Array.isArray(range) || !TIME_RE.test(range[0]) || !TIME_RE.test(range[1])) continue
    const open = minutesOf(range[0])
    const close = minutesOf(range[1])
    for (let m = open; m + step <= close; m += step) {
      const time = timeOf(m)
      if (seen.has(time)) continue
      seen.add(time)
      const startsAt = localToUtc(date, time, settings.timezone)
      slots.push({ date, time, startsAt, endsAt: new Date(startsAt.getTime() + step * 60_000) })
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/**
 * When to remind, or null for "do not".
 *
 * No reminder when reminders are off, when the booking is made on the
 * appointment day itself (the customer has just been told), or when the
 * reminder time would fall after the appointment or has already passed.
 */
export function reminderAt(
  settings: Pick<AppointmentSettings, 'reminder_mode' | 'reminder_time' | 'timezone'>,
  startsAt: Date,
  bookedAt: Date,
): Date | null {
  if (settings.reminder_mode === 'none') return null
  if (!TIME_RE.test(settings.reminder_time)) return null
  const apptDay = localParts(startsAt, settings.timezone).date
  const bookedDay = localParts(bookedAt, settings.timezone).date
  if (apptDay === bookedDay) return null
  const day = settings.reminder_mode === 'day_before' ? addDays(apptDay, -1) : apptDay
  const at = localToUtc(day, settings.reminder_time, settings.timezone)
  if (at.getTime() >= startsAt.getTime()) return null
  if (at.getTime() <= bookedAt.getTime()) return null
  return at
}

/** "Saturday, 21 November 2026" in the business's timezone. */
export function formatDay(at: Date, tz: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at)
}

/** "3:00 pm" in the business's timezone. */
export function formatTime(at: Date, tz: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at)
}

/** "10:00–13:00, 16:00–20:00" per day, for the model and the screen. */
export function describeHours(hours: Record<string, HoursRange[]>): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return names
    .map((name, i) => {
      const ranges = (hours[String(i)] ?? []).filter((r) => TIME_RE.test(r?.[0]) && TIME_RE.test(r?.[1]))
      return `${name}: ${ranges.length ? ranges.map((r) => `${r[0]}-${r[1]}`).join(', ') : 'closed'}`
    })
    .join('; ')
}

/**
 * Clean a settings payload from the browser. Returns the fields to
 * store, or a message saying what is wrong.
 */
export function parseSettingsInput(
  raw: Record<string, unknown>,
): { ok: true; value: Omit<AppointmentSettings, 'id' | 'account_id' | 'channel_id'> } | { ok: false; error: string } {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null)
  const int = (v: unknown, min: number, max: number, name: string): number | string => {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
    if (!Number.isInteger(n) || n < min || n > max) return `${name} must be a whole number from ${min} to ${max}`
    return n
  }

  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : ''
  if (!timezone || !isValidTimezone(timezone)) return { ok: false, error: 'Choose a valid timezone' }

  const slotMinutes = int(raw.slot_minutes, 5, 480, 'Slot length')
  if (typeof slotMinutes === 'string') return { ok: false, error: slotMinutes }
  const capacity = int(raw.slot_capacity, 1, 100, 'Customers per slot')
  if (typeof capacity === 'string') return { ok: false, error: capacity }
  const daysAhead = int(raw.days_ahead, 1, 365, 'Days ahead')
  if (typeof daysAhead === 'string') return { ok: false, error: daysAhead }

  const hours: Record<string, HoursRange[]> = {}
  const rawHours = (raw.hours && typeof raw.hours === 'object' ? raw.hours : {}) as Record<string, unknown>
  for (let day = 0; day <= 6; day++) {
    const list = rawHours[String(day)]
    if (!Array.isArray(list)) continue
    const ranges: HoursRange[] = []
    for (const r of list.slice(0, 4)) {
      if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') continue
      if (!TIME_RE.test(r[0]) || !TIME_RE.test(r[1])) return { ok: false, error: 'Working hours must be times like 10:00' }
      if (minutesOf(r[1]) <= minutesOf(r[0])) return { ok: false, error: 'A closing time must be after its opening time' }
      ranges.push([r[0], r[1]])
    }
    if (ranges.length > 0) hours[String(day)] = ranges
  }

  const holidays = Array.isArray(raw.holidays)
    ? [...new Set(raw.holidays.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d)))].sort().slice(0, 1500)
    : []

  const mode = raw.reminder_mode
  if (mode !== 'none' && mode !== 'same_day' && mode !== 'day_before') {
    return { ok: false, error: 'Choose when to remind' }
  }
  const reminderTime = typeof raw.reminder_time === 'string' ? raw.reminder_time : ''
  if (!TIME_RE.test(reminderTime)) return { ok: false, error: 'The reminder time must be like 09:00' }
  const language =
    typeof raw.reply_language === 'string' && raw.reply_language in REPLY_LANGUAGES ? raw.reply_language : 'auto'

  return {
    ok: true,
    value: {
      enabled: raw.enabled === true,
      business_name: text(raw.business_name, 120),
      address: text(raw.address, 500),
      timezone,
      slot_minutes: slotMinutes,
      slot_capacity: capacity,
      days_ahead: daysAhead,
      hours,
      holidays,
      reminder_mode: mode,
      reminder_time: reminderTime,
      reply_language: language,
      confirm_template: text(raw.confirm_template, 200),
      confirm_template_language: text(raw.confirm_template_language, 20),
      reminder_template: text(raw.reminder_template, 200),
      reminder_template_language: text(raw.reminder_template_language, 20),
    },
  }
}
