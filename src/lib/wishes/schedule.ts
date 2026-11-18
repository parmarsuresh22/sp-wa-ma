// ============================================================
// Wish scheduling — pure date math, no I/O.
//
// A schedule says when a number's wishes are *checked*; a wish says
// which day of the year a contact is wished. A run covers the window
// (previous run, now] in the schedule's time zone and sends every wish
// whose date falls inside it, once per year.
// ============================================================

export type WishFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export const WISH_FREQUENCIES: readonly WishFrequency[] = ['hourly', 'daily', 'weekly', 'monthly', 'yearly']

export interface WishScheduleInput {
  frequency: WishFrequency
  timezone: string
  /** `HH:mm`, local to `timezone`. */
  time_of_day: string
  /** 0 = Sunday … 6 = Saturday (weekly). */
  day_of_week?: number | null
  /** 1–31 (monthly, yearly); clamped to the month's length. */
  day_of_month?: number | null
  /** 1–12 (yearly). */
  month?: number | null
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Wall-clock parts of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  }
}

/** The instant at which `tz` shows the given wall-clock time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute)
  // Two passes handle a DST edge the first guess lands on.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const diff = Date.UTC(year, month - 1, day, hour, minute) - asUtc
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return { hour: 9, minute: 0 }
  const hour = Math.min(23, Math.max(0, Number(m[1])))
  const minute = Math.min(59, Math.max(0, Number(m[2])))
  return { hour, minute }
}

/**
 * The next instant strictly after `from` at which the schedule fires.
 * Hourly: the next `:mm` boundary. Others: the next matching local
 * day at `time_of_day`.
 */
export function computeNextRun(s: WishScheduleInput, from: Date = new Date()): Date {
  const tz = isValidTimeZone(s.timezone) ? s.timezone : 'UTC'
  const { hour, minute } = parseTimeOfDay(s.time_of_day)
  const now = zonedParts(from, tz)

  if (s.frequency === 'hourly') {
    let candidate = zonedToUtc(now.year, now.month, now.day, now.hour, minute, tz)
    if (candidate.getTime() <= from.getTime()) candidate = new Date(candidate.getTime() + 3_600_000)
    return candidate
  }

  const matches = (y: number, m: number, d: number, weekday: number): boolean => {
    switch (s.frequency) {
      case 'daily':
        return true
      case 'weekly':
        return weekday === (s.day_of_week ?? 1)
      case 'monthly':
        return d === Math.min(s.day_of_month ?? 1, daysInMonth(y, m))
      case 'yearly':
        return m === (s.month ?? 1) && d === Math.min(s.day_of_month ?? 1, daysInMonth(y, m))
      default:
        return true
    }
  }

  // Walk forward day by day from today (local); first match whose
  // instant is after `from` wins. 400 days covers a yearly schedule
  // whose date just passed.
  let y = now.year
  let m = now.month
  let d = now.day
  let weekday = now.weekday
  for (let i = 0; i < 400; i++) {
    if (matches(y, m, d, weekday)) {
      const candidate = zonedToUtc(y, m, d, hour, minute, tz)
      if (candidate.getTime() > from.getTime()) return candidate
    }
    d += 1
    weekday = (weekday + 1) % 7
    if (d > daysInMonth(y, m)) {
      d = 1
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
  }
  return new Date(from.getTime() + 86_400_000)
}

export interface WishDate {
  month: number
  day: number
}

/**
 * The occurrence of a (month, day) in `year`, as the local date in
 * `tz` at 00:00. 29 February becomes 28 February in a non-leap year.
 */
export function wishOccurrence(w: WishDate, year: number, tz: string): Date {
  const day = Math.min(w.day, daysInMonth(year, w.month))
  return zonedToUtc(year, w.month, day, 0, 0, tz)
}

/**
 * Whether a wish's date fell inside (from, to] in `tz`, and for which
 * year. The window is compared at day granularity: a wish is due when
 * its calendar day in `tz` is after `from`'s calendar day and no later
 * than `to`'s. Returns the matching year or null.
 */
export function wishDueYear(w: WishDate, from: Date, to: Date, tz: string): number | null {
  const fromP = zonedParts(from, tz)
  const toP = zonedParts(to, tz)
  const fromKey = fromP.year * 10_000 + fromP.month * 100 + fromP.day
  const toKey = toP.year * 10_000 + toP.month * 100 + toP.day
  for (const year of [fromP.year, toP.year]) {
    const day = Math.min(w.day, daysInMonth(year, w.month))
    const key = year * 10_000 + w.month * 100 + day
    if (key > fromKey && key <= toKey) return year
  }
  return null
}

/**
 * The window a run covers. The previous run bounds it; a first run (or
 * one after a long gap) looks back at most `maxLookbackDays` so a new
 * schedule never fires a year of old wishes at once.
 */
export function runWindow(
  lastRunAt: Date | null,
  now: Date,
  maxLookbackDays = 7,
): { from: Date; to: Date } {
  const floor = new Date(now.getTime() - maxLookbackDays * 86_400_000)
  const from = lastRunAt && lastRunAt.getTime() > floor.getTime() ? lastRunAt : floor
  return { from, to: now }
}
