import { describe, expect, it } from 'vitest'
import {
  addDays,
  daySlots,
  describeHours,
  localParts,
  localToUtc,
  parseSettingsInput,
  reminderAt,
  weekdayOf,
} from './time'

const IST = 'Asia/Kolkata'

describe('timezone conversion', () => {
  it('turns a business wall-clock time into the right instant', () => {
    expect(localToUtc('2026-11-21', '15:00', IST).toISOString()).toBe('2026-11-21T09:30:00.000Z')
    expect(localToUtc('2026-11-21', '00:15', IST).toISOString()).toBe('2026-11-20T18:45:00.000Z')
  })
  it('round-trips, including across a daylight-saving change', () => {
    for (const [date, time, tz] of [
      ['2026-03-08', '09:00', 'America/New_York'],
      ['2026-11-01', '16:30', 'America/New_York'],
      ['2026-07-01', '23:45', 'Europe/London'],
      ['2026-01-01', '00:00', 'Asia/Kolkata'],
    ] as const) {
      const parts = localParts(localToUtc(date, time, tz), tz)
      expect(`${parts.date} ${parts.time}`).toBe(`${date} ${time}`)
    }
  })
  it('reads the local date, time and weekday of an instant', () => {
    // 20:00 UTC on Friday is already Saturday 01:30 in India.
    expect(localParts(new Date('2026-11-20T20:00:00Z'), IST)).toEqual({
      date: '2026-11-21',
      time: '01:30',
      weekday: 6,
    })
  })
  it('does calendar arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(weekdayOf('2026-11-21')).toBe(6)
  })
})

describe('daySlots', () => {
  const settings = {
    timezone: IST,
    slot_minutes: 30,
    holidays: ['2026-11-25'],
    hours: { '6': [['10:00', '12:00'], ['15:00', '16:00']] as [string, string][], '3': [['10:00', '11:00']] as [string, string][] },
  }
  it('makes slots inside each working range and none across the break', () => {
    expect(daySlots(settings, '2026-11-21').map((s) => s.time)).toEqual([
      '10:00', '10:30', '11:00', '11:30', '15:00', '15:30',
    ])
  })
  it('never makes a slot that would run past closing', () => {
    expect(daySlots({ ...settings, slot_minutes: 45 }, '2026-11-21').map((s) => s.time)).toEqual([
      '10:00', '10:45', '15:00',
    ])
  })
  it('is empty on a closed weekday and on a holiday', () => {
    expect(daySlots(settings, '2026-11-22')).toEqual([]) // Sunday
    expect(daySlots(settings, '2026-11-25')).toEqual([]) // Wednesday, but a holiday
  })
  it('stores each slot as the right instant', () => {
    const first = daySlots(settings, '2026-11-21')[0]
    expect(first.startsAt.toISOString()).toBe('2026-11-21T04:30:00.000Z')
    expect(first.endsAt.toISOString()).toBe('2026-11-21T05:00:00.000Z')
  })
})

describe('reminderAt', () => {
  const base = { timezone: IST, reminder_time: '09:00' }
  const appt = localToUtc('2026-11-25', '15:00', IST)
  const bookedEarlier = localToUtc('2026-11-21', '12:00', IST)
  it('reminds on the day of the appointment', () => {
    expect(reminderAt({ ...base, reminder_mode: 'same_day' }, appt, bookedEarlier)?.toISOString()).toBe(
      localToUtc('2026-11-25', '09:00', IST).toISOString(),
    )
  })
  it('reminds the day before', () => {
    expect(reminderAt({ ...base, reminder_mode: 'day_before' }, appt, bookedEarlier)?.toISOString()).toBe(
      localToUtc('2026-11-24', '09:00', IST).toISOString(),
    )
  })
  it('does not remind when booked on the appointment day', () => {
    const sameDay = localToUtc('2026-11-25', '07:00', IST)
    expect(reminderAt({ ...base, reminder_mode: 'same_day' }, appt, sameDay)).toBeNull()
    expect(reminderAt({ ...base, reminder_mode: 'day_before' }, appt, sameDay)).toBeNull()
  })
  it('does not remind when off, already past, or after the appointment', () => {
    expect(reminderAt({ ...base, reminder_mode: 'none' }, appt, bookedEarlier)).toBeNull()
    // Booked the evening before with "day before, 09:00": that time has gone.
    const eveningBefore = localToUtc('2026-11-24', '20:00', IST)
    expect(reminderAt({ ...base, reminder_mode: 'day_before' }, appt, eveningBefore)).toBeNull()
    // An 08:00 appointment with a 09:00 same-day reminder.
    const early = localToUtc('2026-11-25', '08:00', IST)
    expect(reminderAt({ ...base, reminder_mode: 'same_day' }, early, bookedEarlier)).toBeNull()
  })
})

describe('parseSettingsInput', () => {
  const good = {
    enabled: true,
    timezone: IST,
    slot_minutes: 30,
    slot_capacity: 1,
    days_ahead: 30,
    hours: { '1': [['10:00', '18:00']] },
    holidays: ['2026-12-25', 'nonsense', '2026-12-25'],
    reminder_mode: 'same_day',
    reminder_time: '09:00',
    business_name: '  Suresh Dental Clinic ',
  }
  it('accepts a good payload and tidies it', () => {
    const out = parseSettingsInput(good)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.business_name).toBe('Suresh Dental Clinic')
    expect(out.value.holidays).toEqual(['2026-12-25'])
    expect(out.value.hours).toEqual({ '1': [['10:00', '18:00']] })
  })
  it('rejects bad values', () => {
    expect(parseSettingsInput({ ...good, timezone: 'Mars/Phobos' }).ok).toBe(false)
    expect(parseSettingsInput({ ...good, slot_minutes: 2 }).ok).toBe(false)
    expect(parseSettingsInput({ ...good, hours: { '1': [['18:00', '10:00']] } }).ok).toBe(false)
    expect(parseSettingsInput({ ...good, reminder_mode: 'sometimes' }).ok).toBe(false)
    expect(parseSettingsInput({ ...good, reminder_time: '9am' }).ok).toBe(false)
  })
})

describe('describeHours', () => {
  it('names open and closed days', () => {
    const text = describeHours({ '1': [['10:00', '13:00'], ['16:00', '20:00']] })
    expect(text).toContain('Monday: 10:00-13:00, 16:00-20:00')
    expect(text).toContain('Sunday: closed')
  })
})
