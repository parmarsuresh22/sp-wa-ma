import { afterEach, describe, expect, it, vi } from 'vitest'

// The module imports the SSR client (next/headers); stub it so the pure
// allow-list helpers can be tested without a request scope.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { isSuperAdminEmail, superAdminEmails } from './super-admin'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('platform admin allow-list', () => {
  it('defaults to the platform owner', () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', '')
    expect(superAdminEmails()).toEqual(['parmar.suresh22@gmail.com'])
    expect(isSuperAdminEmail('parmar.suresh22@gmail.com')).toBe(true)
  })

  it('ignores case and surrounding spaces', () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', '')
    expect(isSuperAdminEmail('  Parmar.Suresh22@Gmail.com ')).toBe(true)
  })

  it('refuses everyone else, including look-alikes and empty values', () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', '')
    expect(isSuperAdminEmail('parmar.suresh22@live.com')).toBe(false)
    expect(isSuperAdminEmail('parmar.suresh22@gmail.com.evil.test')).toBe(false)
    expect(isSuperAdminEmail('xparmar.suresh22@gmail.com')).toBe(false)
    expect(isSuperAdminEmail('')).toBe(false)
    expect(isSuperAdminEmail(null)).toBe(false)
    expect(isSuperAdminEmail(undefined)).toBe(false)
  })

  it('takes the list from SUPER_ADMIN_EMAILS when set', () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', 'One@example.com, two@example.com ,')
    expect(superAdminEmails()).toEqual(['one@example.com', 'two@example.com'])
    expect(isSuperAdminEmail('two@example.com')).toBe(true)
    expect(isSuperAdminEmail('parmar.suresh22@gmail.com')).toBe(false)
  })
})
