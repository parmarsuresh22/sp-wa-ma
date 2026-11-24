import { describe, expect, it } from 'vitest'

import { appointmentQrText, appointmentRef, drawable, judgeAppointmentScan, parseAppointmentQr } from './qr'

const ID = '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b'

describe('appointment QR', () => {
  it('round-trips an id, also typed bare, in capitals or with spaces around', () => {
    expect(parseAppointmentQr(appointmentQrText(ID))).toBe(ID)
    expect(parseAppointmentQr(ID)).toBe(ID)
    expect(parseAppointmentQr(`  atlasappt:${ID.toUpperCase()} `)).toBe(ID)
  })

  it('rejects an event pass, a payment QR and anything else', () => {
    expect(parseAppointmentQr('ATLASPASS:ABCDEFGHJKMNPQRSTUVW')).toBeNull()
    expect(parseAppointmentQr('upi://pay?pa=a@b&am=10')).toBeNull()
    expect(parseAppointmentQr('ATLASAPPT:not-an-id')).toBeNull()
    expect(parseAppointmentQr('')).toBeNull()
  })

  it('prints a short reference', () => {
    expect(appointmentRef(ID)).toBe('3F2B8C1E')
  })
})

describe('drawable', () => {
  it('lets Latin text on the card, with accents, digits and punctuation', () => {
    expect(drawable('Parmar Dental Care & Implant Centre')).toBe(true)
    expect(drawable('José Müller-O\u2019Brien')).toBe(true)
    expect(drawable('2nd Floor, Station Road, Udaipur 313001')).toBe(true)
  })

  it('keeps joined scripts off the card, and empty text', () => {
    expect(drawable('श्री गणेश क्लिनिक')).toBe(false)
    expect(drawable('પરમાર ક્લિનિક')).toBe(false)
    expect(drawable('Asha शर्मा')).toBe(false)
    expect(drawable('')).toBe(false)
    expect(drawable(null)).toBe(false)
  })
})

describe('judgeAppointmentScan', () => {
  const today = '2026-11-24'

  it('completes a booked visit on its own day, also one marked as not come', () => {
    expect(judgeAppointmentScan({ status: 'booked', apptDay: today, today })).toBe('ok')
    expect(judgeAppointmentScan({ status: 'no_show', apptDay: today, today })).toBe('ok')
  })

  it('does not complete a card for another day', () => {
    expect(judgeAppointmentScan({ status: 'booked', apptDay: '2026-11-25', today })).toBe('other_day')
    expect(judgeAppointmentScan({ status: 'booked', apptDay: '2026-11-23', today })).toBe('other_day')
  })

  it('says why for a visit that is done, cancelled or not yet confirmed', () => {
    expect(judgeAppointmentScan({ status: 'completed', apptDay: today, today })).toBe('already_completed')
    expect(judgeAppointmentScan({ status: 'cancelled', apptDay: today, today })).toBe('cancelled')
    expect(judgeAppointmentScan({ status: 'pending', apptDay: today, today })).toBe('pending')
  })
})
