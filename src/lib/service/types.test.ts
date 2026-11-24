import { describe, expect, it } from 'vitest'

import {
  addDays,
  addMonths,
  indianDate,
  localDay,
  parseBusinessInput,
  parseVisitInput,
  reminderDue,
  serviceMessage,
} from './types'

describe('dates', () => {
  it('adds days and months, keeping the end of a short month', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addMonths('2026-11-25', 3)).toBe('2027-02-25')
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30')
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29')
  })

  it('writes a date the Indian way', () => {
    expect(indianDate('2026-11-25')).toBe('25/11/2026')
    expect(indianDate(null)).toBe('-')
  })

  it('knows the day and time in the business zone', () => {
    // 20:00 UTC is 01:30 the next day in India.
    expect(localDay(new Date('2026-11-24T20:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-11-25', minutes: 90 })
  })
})

describe('parseBusinessInput', () => {
  it('needs a name and an address, and defaults the rest', () => {
    expect(parseBusinessInput({ name: 'Sharma RO', address: '' }).ok).toBe(false)
    const parsed = parseBusinessInput({ name: ' Sharma RO ', address: 'Main Road' })
    expect(parsed).toEqual({
      ok: true,
      value: { business_name: 'Sharma RO', address: 'Main Road', language: 'en', reminder_time: '09:00' },
    })
    expect(parseBusinessInput({ name: 'A', address: 'B', reminder_time: '25:00' }).ok).toBe(false)
  })
})

describe('parseVisitInput', () => {
  const base = { customerName: 'Asha', service: 'RO filter changed', visitDate: '2026-11-24', nextVisit: '2027-02-24' }

  it('accepts a visit and keeps at most three https photos', () => {
    const parsed = parseVisitInput({ ...base, area: ' Gate 2 ', images: ['https://a/1', 'http://a/2', 'https://a/3', 'https://a/4', 'https://a/5'] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.area).toBe('Gate 2')
    expect(parsed.value.images).toEqual(['https://a/1', 'https://a/3', 'https://a/4'])
  })

  it('refuses a missing name, service or date, and a next visit before the visit', () => {
    expect(parseVisitInput({ ...base, customerName: ' ' }).ok).toBe(false)
    expect(parseVisitInput({ ...base, service: '' }).ok).toBe(false)
    expect(parseVisitInput({ ...base, nextVisit: '' }).ok).toBe(false)
    expect(parseVisitInput({ ...base, nextVisit: '2026-11-23' }).ok).toBe(false)
    expect(parseVisitInput({ ...base, nextVisit: '2026-11-24' }).ok).toBe(true)
  })
})

describe('serviceMessage', () => {
  const input = { customerName: 'Asha', service: 'RO filter', visitDate: '2026-11-24', nextVisit: '2027-02-24' }

  it('names the business, the service and the dates', () => {
    const msg = serviceMessage('saved', { business_name: 'Sharma RO', address: 'Main Road', language: 'en' }, input)
    expect(msg).toContain('*Sharma RO*')
    expect(msg).toContain('RO filter')
    expect(msg).toContain('*24/11/2026*')
    expect(msg).toContain('*24/02/2027*')
    expect(msg).toContain('Main Road')
  })

  it('says tomorrow or today, in English or Hindi', () => {
    const en = { business_name: 'Sharma RO', address: 'x', language: 'en' as const }
    const hi = { ...en, language: 'hi' as const }
    expect(serviceMessage('due_tomorrow', en, input)).toContain('*tomorrow*')
    expect(serviceMessage('due_today', en, input)).toContain('*today*')
    expect(serviceMessage('due_tomorrow', hi, input)).toContain('*कल*')
    expect(serviceMessage('due_today', hi, input)).toContain('*आज*')
  })
})

describe('reminderDue', () => {
  const visit = { next_visit: '2026-11-25', rem0_sent_for: null, rem1_sent_for: null, status: 'active' as const }

  it('reminds the day before and on the day, from the reminder time on', () => {
    expect(reminderDue(visit, { date: '2026-11-24', minutes: 9 * 60 }, '09:00')).toBe('due_tomorrow')
    expect(reminderDue(visit, { date: '2026-11-25', minutes: 10 * 60 }, '09:00')).toBe('due_today')
    expect(reminderDue(visit, { date: '2026-11-24', minutes: 8 * 60 + 59 }, '09:00')).toBeNull()
    expect(reminderDue(visit, { date: '2026-11-23', minutes: 12 * 60 }, '09:00')).toBeNull()
    expect(reminderDue(visit, { date: '2026-11-26', minutes: 12 * 60 }, '09:00')).toBeNull()
  })

  it('sends each reminder once, and again when the date is moved', () => {
    const at = { date: '2026-11-24', minutes: 600 }
    expect(reminderDue({ ...visit, rem1_sent_for: '2026-11-25' }, at, '09:00')).toBeNull()
    expect(reminderDue({ ...visit, rem1_sent_for: '2026-11-20' }, at, '09:00')).toBe('due_tomorrow')
    expect(reminderDue({ ...visit, rem0_sent_for: '2026-11-25' }, { date: '2026-11-25', minutes: 600 }, '09:00')).toBeNull()
  })

  it('never reminds for a removed visit', () => {
    expect(reminderDue({ ...visit, status: 'inactive' }, { date: '2026-11-25', minutes: 600 }, '09:00')).toBeNull()
  })
})
