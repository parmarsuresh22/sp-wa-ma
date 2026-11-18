import { describe, expect, it } from 'vitest'
import {
  computeNextRun,
  daysInMonth,
  runWindow,
  wishDueYear,
  zonedParts,
  zonedToUtc,
} from './schedule'

const IST = 'Asia/Kolkata'

describe('zoned helpers', () => {
  it('converts wall-clock time in a zone to the right instant and back', () => {
    const d = zonedToUtc(2026, 11, 18, 9, 0, IST)
    expect(d.toISOString()).toBe('2026-11-18T03:30:00.000Z')
    expect(zonedParts(d, IST)).toMatchObject({ year: 2026, month: 11, day: 18, hour: 9, minute: 0, weekday: 3 })
  })
  it('knows month lengths including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})

describe('computeNextRun', () => {
  it('daily: today at the time if still ahead, else tomorrow', () => {
    const s = { frequency: 'daily' as const, timezone: IST, time_of_day: '09:00' }
    expect(computeNextRun(s, new Date('2026-11-18T02:00:00Z')).toISOString()).toBe('2026-11-18T03:30:00.000Z')
    expect(computeNextRun(s, new Date('2026-11-18T03:30:00Z')).toISOString()).toBe('2026-11-19T03:30:00.000Z')
  })
  it('hourly: the next minute mark', () => {
    const s = { frequency: 'hourly' as const, timezone: 'UTC', time_of_day: '00:15' }
    expect(computeNextRun(s, new Date('2026-11-18T10:10:00Z')).toISOString()).toBe('2026-11-18T10:15:00.000Z')
    expect(computeNextRun(s, new Date('2026-11-18T10:15:00Z')).toISOString()).toBe('2026-11-18T11:15:00.000Z')
  })
  it('weekly: the chosen weekday', () => {
    // 18 Nov 2026 is a Wednesday; ask for Monday 08:00 IST.
    const s = { frequency: 'weekly' as const, timezone: IST, time_of_day: '08:00', day_of_week: 1 }
    expect(computeNextRun(s, new Date('2026-11-18T00:00:00Z')).toISOString()).toBe('2026-11-23T02:30:00.000Z')
  })
  it('monthly: clamps 31 to the month length', () => {
    const s = { frequency: 'monthly' as const, timezone: 'UTC', time_of_day: '06:00', day_of_month: 31 }
    expect(computeNextRun(s, new Date('2026-02-01T00:00:00Z')).toISOString()).toBe('2026-02-28T06:00:00.000Z')
  })
  it('yearly: the chosen month and day, next year when passed', () => {
    const s = { frequency: 'yearly' as const, timezone: 'UTC', time_of_day: '07:00', month: 1, day_of_month: 1 }
    expect(computeNextRun(s, new Date('2026-11-18T00:00:00Z')).toISOString()).toBe('2027-01-01T07:00:00.000Z')
  })
})

describe('wishDueYear', () => {
  it('is due when the date falls after the previous run and up to now', () => {
    const from = new Date('2026-11-17T03:30:00Z') // 09:00 IST on the 17th
    const to = new Date('2026-11-18T03:30:00Z') // 09:00 IST on the 18th
    expect(wishDueYear({ month: 11, day: 18 }, from, to, IST)).toBe(2026)
    expect(wishDueYear({ month: 11, day: 17 }, from, to, IST)).toBeNull()
    expect(wishDueYear({ month: 11, day: 19 }, from, to, IST)).toBeNull()
  })
  it('catches a mid-week birthday on a weekly run and crosses a year boundary', () => {
    const from = new Date('2026-12-28T03:30:00Z')
    const to = new Date('2027-01-04T03:30:00Z')
    expect(wishDueYear({ month: 12, day: 31 }, from, to, IST)).toBe(2026)
    expect(wishDueYear({ month: 1, day: 2 }, from, to, IST)).toBe(2027)
  })
  it('wishes a 29 February contact on 28 February in a non-leap year', () => {
    const from = new Date('2026-02-27T03:30:00Z')
    const to = new Date('2026-02-28T03:30:00Z')
    expect(wishDueYear({ month: 2, day: 29 }, from, to, IST)).toBe(2026)
  })
})

describe('runWindow', () => {
  it('starts at the previous run, or at most seven days back', () => {
    const now = new Date('2026-11-18T03:30:00Z')
    expect(runWindow(new Date('2026-11-17T03:30:00Z'), now).from.toISOString()).toBe('2026-11-17T03:30:00.000Z')
    expect(runWindow(null, now).from.toISOString()).toBe('2026-11-11T03:30:00.000Z')
    expect(runWindow(new Date('2026-01-01T00:00:00Z'), now).from.toISOString()).toBe('2026-11-11T03:30:00.000Z')
  })
})
