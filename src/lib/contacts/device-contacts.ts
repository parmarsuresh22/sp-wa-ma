// ============================================================
// Contacts taken straight from a phone: picked in the phone's own
// contact chooser, or read from a contacts file (.vcf) exported from
// it. Pure — used by the screen, the server and the tests.
// ============================================================

export interface RawDeviceContact {
  name: string | null
  phone: string
}

/**
 * A phone number as typed in an address book → digits with the country
 * code, or null when it cannot be one. A number saved without a country
 * code (10 digits, or with a leading 0) is taken to be in the country
 * of the business's own number.
 */
export function devicePhoneDigits(raw: string, countryDigits: string): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let digits = text.replace(/\D/g, '')
  const international = text.startsWith('+') || text.startsWith('00')
  if (text.startsWith('00')) digits = digits.slice(2)
  if (!international) {
    digits = digits.replace(/^0+/, '')
    if (digits.length === 10) digits = `${countryDigits}${digits}`
    else if (digits.length < 10) return null
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

/** The country code of a number like "+91 84337 01949" → "91". */
export function countryOf(ownNumber: string | null | undefined): string {
  const digits = (ownNumber ?? '').replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(0, digits.length - 10) : '91'
}

function decodeQuotedPrintable(value: string): string {
  try {
    const bytes: number[] = []
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16))
        i += 2
      } else bytes.push(value.charCodeAt(i) & 0xff)
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  } catch {
    return value
  }
}

/**
 * Every person with a phone number in a contacts file (vCard, any
 * version). A person with several numbers gives one entry per number.
 */
export function parseVcf(text: string): RawDeviceContact[] {
  // A long line is folded onto the next with a leading space or tab;
  // quoted-printable folds with a trailing "=".
  const lines = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/=\n/g, '')
    .replace(/\n[ \t]/g, '')
    .split('\n')
  const out: RawDeviceContact[] = []
  let name: string | null = null
  let structured: string | null = null
  let phones: string[] = []
  let inside = false

  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const head = line.slice(0, colon).toUpperCase()
    let value = line.slice(colon + 1).trim()
    // "item1.TEL;TYPE=CELL" → "TEL"
    const field = head.split(';')[0].replace(/^[^.]*\./, '')
    if (head.includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value)

    if (field === 'BEGIN' && value.toUpperCase() === 'VCARD') {
      inside = true
      name = null
      structured = null
      phones = []
    } else if (field === 'END' && value.toUpperCase() === 'VCARD') {
      if (inside) {
        const who = (name || structured || '').replace(/\\([,;])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 120) || null
        for (const phone of phones) out.push({ name: who, phone })
      }
      inside = false
    } else if (!inside) {
      continue
    } else if (field === 'FN') {
      name = value
    } else if (field === 'N') {
      // Family;Given;Middle;Prefix;Suffix
      const [family = '', given = '', middle = ''] = value.split(';')
      structured = [given, middle, family].map((p) => p.trim()).filter(Boolean).join(' ')
    } else if (field === 'TEL') {
      const phone = value.replace(/^tel:/i, '').trim()
      if (phone) phones.push(phone)
    }
  }
  return out
}
