import { describe, expect, it } from 'vitest'
import {
  OVERRIDE_URL_MAX_LENGTH,
  resolveOverrideCallbackUrl,
} from './webhook-override'

describe('resolveOverrideCallbackUrl', () => {
  it('returns null when unset or blank', () => {
    expect(resolveOverrideCallbackUrl(undefined)).toBeNull()
    expect(resolveOverrideCallbackUrl('')).toBeNull()
    expect(resolveOverrideCallbackUrl('   ')).toBeNull()
  })

  it('accepts a public https URL and trims whitespace', () => {
    expect(
      resolveOverrideCallbackUrl('  https://sp-crm-pi.vercel.app/api/whatsapp/webhook  ')
    ).toBe('https://sp-crm-pi.vercel.app/api/whatsapp/webhook')
  })

  it('rejects non-https schemes', () => {
    expect(resolveOverrideCallbackUrl('http://example.com/hook')).toBeNull()
    expect(resolveOverrideCallbackUrl('ftp://example.com/hook')).toBeNull()
  })

  it('rejects malformed values', () => {
    expect(resolveOverrideCallbackUrl('not a url')).toBeNull()
    expect(resolveOverrideCallbackUrl('https://')).toBeNull()
  })

  it('rejects embedded credentials', () => {
    expect(resolveOverrideCallbackUrl('https://user:pw@example.com/hook')).toBeNull()
  })

  it('rejects hosts Meta could never reach', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'crm.local',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.3',
      '172.31.255.1',
      '169.254.169.254',
    ]) {
      expect(resolveOverrideCallbackUrl(`https://${host}/api/whatsapp/webhook`)).toBeNull()
    }
    // 172.32.x is public — must pass.
    expect(resolveOverrideCallbackUrl('https://172.32.0.1/hook')).toBe('https://172.32.0.1/hook')
  })

  it("rejects URLs longer than Meta's limit", () => {
    const base = 'https://example.com/'
    const ok = base + 'a'.repeat(OVERRIDE_URL_MAX_LENGTH - base.length)
    const tooLong = ok + 'a'
    expect(resolveOverrideCallbackUrl(ok)).toBe(ok)
    expect(resolveOverrideCallbackUrl(tooLong)).toBeNull()
  })
})
