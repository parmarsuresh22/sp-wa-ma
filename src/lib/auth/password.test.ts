import { describe, expect, it } from 'vitest'

import { missingPasswordRules, passwordStrong, passwordTooGuessable } from './password'
import { isBlockedSignIn } from './blocked'

describe('password rules', () => {
  it('names what a weak password still misses', () => {
    expect(missingPasswordRules('abc')).toEqual(['length', 'upper', 'number', 'symbol'])
    expect(missingPasswordRules('abcdefgh')).toEqual(['upper', 'number', 'symbol'])
    expect(missingPasswordRules('Abcdefg1')).toEqual(['symbol'])
    expect(missingPasswordRules('12345678')).toEqual(['lower', 'upper', 'symbol'])
  })

  it('accepts a password with every kind of character', () => {
    expect(missingPasswordRules('Tulsi#Garden42')).toEqual([])
    expect(passwordStrong('Tulsi#Garden42', 'asha@example.com')).toBe(true)
  })

  it('refuses a common password or the email name dressed up', () => {
    expect(passwordTooGuessable('Password@1')).toBe(true)
    expect(passwordStrong('Password@1')).toBe(false)
    expect(passwordStrong('Qwerty#2024')).toBe(false)
    expect(passwordStrong('Asha.Sharma@1', 'asha.sharma@example.com')).toBe(false)
    // A short email name is not held against the password.
    expect(passwordStrong('Tulsi#Garden42', 'tu@example.com')).toBe(true)
  })
})

describe('isBlockedSignIn', () => {
  it('recognises the sign-in service refusing a blocked user', () => {
    expect(isBlockedSignIn({ code: 'user_banned', message: 'User is banned' })).toBe(true)
    expect(isBlockedSignIn({ message: 'User is banned' })).toBe(true)
    expect(isBlockedSignIn({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false)
    expect(isBlockedSignIn(null)).toBe(false)
  })
})
