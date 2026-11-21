import { describe, expect, it } from 'vitest'
import {
  accountMediaPath,
  cleanIdList,
  isAccountMediaUrl,
  parseAudience,
  waMeLink,
  withWhatsAppLink,
} from './post'

const SB = 'https://proj.supabase.co'
const ACC = '11111111-1111-4111-8111-111111111111'
const ID_A = '22222222-2222-4222-8222-222222222222'
const ID_B = '33333333-3333-4333-8333-333333333333'

describe('waMeLink', () => {
  it('keeps digits only', () => {
    expect(waMeLink('+91 98765 43210')).toBe('https://wa.me/919876543210')
  })
  it('refuses numbers that cannot be real', () => {
    expect(waMeLink('12345')).toBeNull()
    expect(waMeLink('')).toBeNull()
    expect(waMeLink(null)).toBeNull()
    expect(waMeLink('1234567890123456')).toBeNull()
  })
})

describe('withWhatsAppLink', () => {
  it('adds the contact line under the caption', () => {
    expect(withWhatsAppLink('New stock in!', '+919876543210')).toBe(
      'New stock in!\n\nChat with us on WhatsApp: https://wa.me/919876543210',
    )
  })
  it('is only the contact line when there is no caption', () => {
    expect(withWhatsAppLink('  ', '919876543210')).toBe(
      'Chat with us on WhatsApp: https://wa.me/919876543210',
    )
  })
  it('leaves the caption alone without a usable number', () => {
    expect(withWhatsAppLink('Hello', null)).toBe('Hello')
  })
  it('does not add the link twice (a reused post)', () => {
    const once = withWhatsAppLink('Hello', '919876543210')
    expect(withWhatsAppLink(once, '919876543210')).toBe(once)
  })
})

describe('isAccountMediaUrl', () => {
  const ok = `${SB}/storage/v1/object/public/chat-media/account-${ACC}/1-pic.jpg`
  it('accepts the account\'s own chat-media object', () => {
    expect(isAccountMediaUrl(ok, SB, ACC)).toBe(true)
    expect(isAccountMediaUrl(ok, `${SB}/`, ACC)).toBe(true)
  })
  it('refuses another account, another host, another bucket', () => {
    expect(isAccountMediaUrl(ok.replace(ACC, ID_A), SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(ok.replace('proj.', 'evil.'), SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(ok.replace('chat-media', 'other'), SB, ACC)).toBe(false)
    expect(isAccountMediaUrl('https://example.com/x.jpg', SB, ACC)).toBe(false)
  })
  it('refuses path tricks and empty values', () => {
    expect(isAccountMediaUrl(`${ok}/../../account-${ID_A}/x.jpg`, SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(`${ok}?x=1`, SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(ok.slice(0, ok.lastIndexOf('/') + 1), SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(null, SB, ACC)).toBe(false)
    expect(isAccountMediaUrl(ok, undefined, ACC)).toBe(false)
  })
  it('gives back the storage path', () => {
    expect(accountMediaPath(ok, SB, ACC)).toBe(`account-${ACC}/1-pic.jpg`)
    expect(accountMediaPath('https://example.com/x.jpg', SB, ACC)).toBeNull()
  })
})

describe('cleanIdList', () => {
  it('keeps unique UUIDs and caps the list', () => {
    expect(cleanIdList([ID_A, ID_A, 'nope', 5, ID_B], 10)).toEqual([ID_A, ID_B])
    expect(cleanIdList([ID_A, ID_B], 1)).toEqual([ID_A])
    expect(cleanIdList('x', 10)).toEqual([])
  })
})

describe('parseAudience', () => {
  it('accepts every contact from one number', () => {
    expect(parseAudience({ mode: 'all', channel_id: ID_A })).toEqual({
      mode: 'all',
      tag_ids: [],
      contact_ids: [],
      channel_id: ID_A,
    })
  })
  it('needs tags for tag mode and contacts for contact mode', () => {
    expect(parseAudience({ mode: 'tags', channel_id: ID_A, tag_ids: [] })).toBeNull()
    expect(parseAudience({ mode: 'contacts', channel_id: ID_A })).toBeNull()
    expect(parseAudience({ mode: 'tags', channel_id: ID_A, tag_ids: [ID_B] })?.tag_ids).toEqual([ID_B])
  })
  it('refuses a missing number or an unknown mode', () => {
    expect(parseAudience({ mode: 'all' })).toBeNull()
    expect(parseAudience({ mode: 'everyone', channel_id: ID_A })).toBeNull()
    expect(parseAudience(null)).toBeNull()
  })
})

describe('mobile numbers from an uploaded file', () => {
  it('keeps only 10-digit mobiles, without country code or leading zero', async () => {
    const { toTenDigitMobile } = await import('./post')
    expect(toTenDigitMobile('9782048273')).toBe('9782048273')
    expect(toTenDigitMobile('+91 97820 48273')).toBe('9782048273')
    expect(toTenDigitMobile('919782048273')).toBe('9782048273')
    expect(toTenDigitMobile('09782048273')).toBe('9782048273')
    expect(toTenDigitMobile('(97820) 48-273')).toBe('9782048273')
    // Not a mobile: too short, too long, landline-style, text, empty.
    for (const bad of ['978204827', '97820482731', '0141-2345678', '1234567890', 'Ravi', '', 'abc9782048273', null]) {
      expect(toTenDigitMobile(bad)).toBeNull()
    }
  })
  it('drops duplicates and reports what was left out', async () => {
    const { extractMobileNumbers } = await import('./post')
    const out = extractMobileNumbers(['9782048273', '+919782048273', 'Name', '8433701949', '', '12345', '8433701949'])
    expect(out.numbers).toEqual(['9782048273', '8433701949'])
    expect(out.read).toBe(6)
    expect(out.rejected).toBe(2)
    expect(out.duplicates).toBe(2)
  })
})

describe('how long a broadcast takes', () => {
  it('grows with the number of people and stays under an hour at the cap', async () => {
    const { estimateBroadcastSeconds, MAX_BROADCAST_RECIPIENTS } = await import('./post')
    expect(estimateBroadcastSeconds(0)).toBe(0)
    expect(estimateBroadcastSeconds(5)).toBe(15)
    expect(estimateBroadcastSeconds(6)).toBe(38)
    const full = estimateBroadcastSeconds(MAX_BROADCAST_RECIPIENTS)
    expect(full).toBe(3480)
    expect(estimateBroadcastSeconds(100000)).toBe(full)
  })
  it('accepts an audience that is a saved list', async () => {
    const { parseAudience } = await import('./post')
    const channel = '11111111-1111-4111-8111-111111111111'
    const list = '22222222-2222-4222-8222-222222222222'
    expect(parseAudience({ mode: 'list', channel_id: channel, list_id: list })).toEqual({
      mode: 'list',
      tag_ids: [],
      contact_ids: [],
      channel_id: channel,
      list_id: list,
    })
    expect(parseAudience({ mode: 'list', channel_id: channel })).toBeNull()
  })
})
