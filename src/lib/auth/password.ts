// What a new password must have. One list, used by sign-up, password
// reset and the password form in Settings.

export const MIN_PASSWORD_LENGTH = 8

export const PASSWORD_RULES = ['length', 'lower', 'upper', 'number', 'symbol'] as const
export type PasswordRule = (typeof PASSWORD_RULES)[number]

/** Passwords people pick first; refused even when they tick every box. */
const TOO_COMMON = ['password', 'qwerty', '12345', 'abc123', 'letmein', 'welcome', 'iloveyou', 'admin']

export function passwordChecks(password: string): Record<PasswordRule, boolean> {
  return {
    length: password.length >= MIN_PASSWORD_LENGTH,
    lower: /\p{Ll}/u.test(password),
    upper: /\p{Lu}/u.test(password),
    number: /\d/.test(password),
    symbol: /[^\p{L}\p{N}\s]/u.test(password),
  }
}

/** The rules a password still misses, in display order. */
export function missingPasswordRules(password: string): PasswordRule[] {
  const checks = passwordChecks(password)
  return PASSWORD_RULES.filter((rule) => !checks[rule])
}

/**
 * True when the password is built around a very common one ("Password@1")
 * or around the person's own email name ("Asha.sharma@1").
 */
export function passwordTooGuessable(password: string, email?: string | null): boolean {
  const plain = password.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (TOO_COMMON.some((word) => plain.includes(word))) return true
  const local = (email ?? '').split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
  return local.length >= 4 && plain.includes(local)
}

export function passwordStrong(password: string, email?: string | null): boolean {
  return missingPasswordRules(password).length === 0 && !passwordTooGuessable(password, email)
}
