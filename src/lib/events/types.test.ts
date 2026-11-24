import { describe, expect, it } from 'vitest'

import { parseProofReading } from './proof'
import {
  PASS_CODE_LENGTH,
  checkProof,
  isUpiId,
  money,
  parseEventInput,
  parsePassQr,
  passQrText,
  referenceInText,
  upiLink,
  type ProofReading,
} from './types'

const CODE = 'ABCDEFGHJKMNPQRSTUVW'

describe('pass QR', () => {
  it('round-trips a code and accepts it typed in lower case with spaces', () => {
    expect(CODE).toHaveLength(PASS_CODE_LENGTH)
    expect(parsePassQr(passQrText(CODE))).toBe(CODE)
    expect(parsePassQr(' abcde fghjk mnpqr stuvw ')).toBe(CODE)
  })

  it('rejects anything that is not one of our codes', () => {
    expect(parsePassQr('upi://pay?pa=a@b&am=10')).toBeNull()
    expect(parsePassQr('ATLASPASS:SHORT')).toBeNull()
    // 0, 1, I, L and O are never used in a code.
    expect(parsePassQr('ATLASPASS:ABCDEFGHJKMNPQRSTUV0')).toBeNull()
    expect(parsePassQr('')).toBeNull()
  })
})

describe('money and UPI', () => {
  it('writes rupees the Indian way', () => {
    expect(money(1000)).toBe('₹1,000')
    expect(money(499.5)).toBe('₹499.50')
    expect(money(150000)).toBe('₹1,50,000')
  })

  it('builds a UPI link with the amount and the order note', () => {
    const link = upiLink({ upiId: 'shop@okaxis', name: 'My Shop', amount: 1000, note: 'Order AB12CD' })
    expect(link.startsWith('upi://pay?')).toBe(true)
    const q = new URLSearchParams(link.slice('upi://pay?'.length))
    expect(q.get('pa')).toBe('shop@okaxis')
    expect(q.get('pn')).toBe('My Shop')
    expect(q.get('am')).toBe('1000.00')
    expect(q.get('cu')).toBe('INR')
    expect(q.get('tn')).toBe('Order AB12CD')
    expect(link).not.toContain('+')
  })

  it('knows what a UPI ID looks like', () => {
    expect(isUpiId('name@okaxis')).toBe(true)
    expect(isUpiId('9876543210@ybl')).toBe(true)
    expect(isUpiId('name')).toBe(false)
    expect(isUpiId('name@')).toBe(false)
    expect(isUpiId('a b@okaxis')).toBe(false)
  })

  it('finds a typed 12-digit reference number, and nothing shorter or longer', () => {
    expect(referenceInText('paid, ref 432112345678 thanks')).toBe('432112345678')
    expect(referenceInText('my number is 9876543210')).toBeNull()
    expect(referenceInText('1234567890123')).toBeNull()
  })
})

describe('checkProof', () => {
  const order = { amount: 1000, upiId: 'shop@okaxis', upiName: 'Parmar Clinic', today: '2026-11-24' }
  const good: ProofReading = {
    is_payment: true,
    status: 'success',
    amount: 1000,
    utr: '432112345678',
    payee_upi: 'shop@okaxis',
    payee_name: 'PARMAR CLINIC',
    paid_on: '2026-11-24',
  }

  it('passes a matching receipt, also one dated yesterday', () => {
    expect(checkProof(good, order)).toEqual([])
    expect(checkProof({ ...good, paid_on: '2026-11-23' }, order)).toEqual([])
  })

  it('needs a person when nothing could be read or it is not a receipt', () => {
    expect(checkProof(null, order)).toEqual(['unread'])
    expect(checkProof({ ...good, is_payment: false }, order)).toEqual(['not_payment'])
  })

  it('flags a wrong amount, a missing reference, an old date and a failed payment', () => {
    expect(checkProof({ ...good, amount: 100 }, order)).toEqual(['amount_mismatch'])
    expect(checkProof({ ...good, amount: null }, order)).toEqual(['amount_missing'])
    expect(checkProof({ ...good, utr: null }, order)).toEqual(['utr_missing'])
    expect(checkProof({ ...good, paid_on: '2026-11-20' }, order)).toEqual(['old_date'])
    expect(checkProof({ ...good, paid_on: null }, order)).toEqual(['date_missing'])
    expect(checkProof({ ...good, status: 'failed' }, order)).toEqual(['not_successful'])
  })

  it('flags a payment to someone else', () => {
    expect(checkProof({ ...good, payee_upi: 'other@ybl' }, order)).toEqual(['payee_mismatch'])
    expect(checkProof({ ...good, payee_upi: null, payee_name: 'Someone Else' }, order)).toEqual(['payee_mismatch'])
  })

  it('accepts the payee by name when the UPI ID is hidden or masked', () => {
    expect(checkProof({ ...good, payee_upi: null }, order)).toEqual([])
    expect(checkProof({ ...good, payee_upi: 'xxxxxx1234@okaxis' }, order)).toEqual([])
  })

  it('does not pass when who was paid cannot be told at all', () => {
    expect(checkProof({ ...good, payee_upi: null, payee_name: null }, order)).toEqual(['payee_unread'])
  })
})

describe('parseProofReading', () => {
  it('reads the model answer, even wrapped in a code fence', () => {
    const answer =
      '```json\n{"is_payment": true, "status": "success", "amount": "₹1,000.00", "utr": "4321 1234 5678", "payee_upi": "Shop@OkAxis", "payee_name": "My Shop", "paid_on": "2026-11-24"}\n```'
    expect(parseProofReading(answer)).toEqual({
      is_payment: true,
      status: 'success',
      amount: 1000,
      utr: '432112345678',
      payee_upi: 'shop@okaxis',
      payee_name: 'My Shop',
      paid_on: '2026-11-24',
    })
  })

  it('drops values that are not what they should be', () => {
    const reading = parseProofReading('{"is_payment": "yes", "status": "done", "amount": -5, "utr": "12345", "paid_on": "24 Nov"}')
    expect(reading).toEqual({
      is_payment: false,
      status: 'unknown',
      amount: null,
      utr: null,
      payee_upi: null,
      payee_name: null,
      paid_on: null,
    })
    expect(parseProofReading('sorry, I cannot read this')).toBeNull()
  })
})

describe('parseEventInput', () => {
  const base = {
    name: 'Dandiya Night',
    date: '2026-12-05',
    time: '19:00',
    pass_types: [
      { name: 'General', price: 0, capacity: 200 },
      { name: 'VIP', price: 500, capacity: 50 },
    ],
    upi_id: 'Shop@OkAxis',
  }

  it('accepts a full event and turns the local time into UTC', () => {
    const parsed = parseEventInput(base)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // 19:00 in India is 13:30 UTC.
    expect(parsed.value.starts_at).toBe('2026-12-05T13:30:00.000Z')
    expect(parsed.value.upi_id).toBe('shop@okaxis')
    expect(parsed.value.pass_types).toHaveLength(2)
    expect(parsed.value.max_per_phone).toBe(5)
    expect(parsed.value.auto_issue).toBe(false)
  })

  it('needs a UPI ID only when a pass costs money', () => {
    expect(parseEventInput({ ...base, upi_id: '' }).ok).toBe(false)
    expect(parseEventInput({ ...base, upi_id: '', pass_types: [{ name: 'General', price: 0, capacity: 10 }] }).ok).toBe(true)
  })

  it('refuses an event without a name, a date, a pass type or places', () => {
    expect(parseEventInput({ ...base, name: ' ' }).ok).toBe(false)
    expect(parseEventInput({ ...base, date: '05-12-2026' }).ok).toBe(false)
    expect(parseEventInput({ ...base, pass_types: [] }).ok).toBe(false)
    expect(parseEventInput({ ...base, pass_types: [{ name: 'General', price: 0, capacity: 0 }] }).ok).toBe(false)
    expect(parseEventInput({ ...base, pass_types: [{ name: 'A', price: 0, capacity: 5 }, { name: 'a', price: 0, capacity: 5 }] }).ok).toBe(false)
    expect(parseEventInput({ ...base, upi_id: 'not a upi id' }).ok).toBe(false)
  })

  it('keeps the last date to apply before the start', () => {
    expect(parseEventInput({ ...base, apply_until_date: '2026-12-06' }).ok).toBe(false)
    const parsed = parseEventInput({ ...base, apply_until_date: '2026-12-04' })
    expect(parsed.ok && parsed.value.apply_until).toBe('2026-12-04T18:29:00.000Z')
  })
})
