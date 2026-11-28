import { describe, expect, it } from 'vitest'

import { countryOf, devicePhoneDigits, parseVcf } from './device-contacts'

describe('devicePhoneDigits', () => {
  it('keeps a number that carries its country code', () => {
    expect(devicePhoneDigits('+91 98765 43210', '91')).toBe('919876543210')
    expect(devicePhoneDigits('0044 20 7946 0958', '91')).toBe('442079460958')
    expect(devicePhoneDigits('+1 (415) 555-0123', '91')).toBe('14155550123')
  })

  it('gives a local number the country of the business', () => {
    expect(devicePhoneDigits('98765 43210', '91')).toBe('919876543210')
    expect(devicePhoneDigits('098765-43210', '91')).toBe('919876543210')
    expect(devicePhoneDigits('919876543210', '91')).toBe('919876543210')
  })

  it('refuses what cannot be a mobile number', () => {
    expect(devicePhoneDigits('12345', '91')).toBeNull()
    expect(devicePhoneDigits('', '91')).toBeNull()
    expect(devicePhoneDigits('*121#', '91')).toBeNull()
  })

  it('reads the country from the business number', () => {
    expect(countryOf('+91 84337 01949')).toBe('91')
    expect(countryOf('+14155550123')).toBe('1')
    expect(countryOf(null)).toBe('91')
  })
})

describe('parseVcf', () => {
  it('reads names and every number of each card', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Sharma;Asha;;;',
      'FN:Asha Sharma',
      'TEL;TYPE=CELL:+91 98765 43210',
      'item1.TEL;type=HOME:02974-222333',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Singh;Vikram',
      'TEL;CELL:9812345678',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:No Number',
      'END:VCARD',
    ].join('\r\n')
    expect(parseVcf(vcf)).toEqual([
      { name: 'Asha Sharma', phone: '+91 98765 43210' },
      { name: 'Asha Sharma', phone: '02974-222333' },
      { name: 'Vikram Singh', phone: '9812345678' },
    ])
  })

  it('unfolds long lines and reads names an old phone wrote in quoted-printable', () => {
    const vcf = [
      'BEGIN:VCARD',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=86=E0=A4=B6=E0=A4=BE=',
      '=20=E0=A4=B6=E0=A4=B0=E0=A5=8D=E0=A4=AE=E0=A4=BE',
      'TEL:+9198765',
      ' 43210',
      'END:VCARD',
    ].join('\n')
    expect(parseVcf(vcf)).toEqual([{ name: 'आशा शर्मा', phone: '+919876543210' }])
  })

  it('gives nothing for a file that is not a contacts file', () => {
    expect(parseVcf('name,phone\nAsha,98765')).toEqual([])
    expect(parseVcf('')).toEqual([])
  })
})
