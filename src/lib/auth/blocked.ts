// A blocked account (migration 085): what its people are told, and how
// the sign-in service's answer for a blocked user is recognised.

/** Where a blocked customer asks to be reactivated. */
export const SUPPORT_EMAIL = 'llc.sirohi.in@gmail.com'

/** Server-side wording (API answers); the screens use their own text. */
export const ACCOUNT_BLOCKED_MESSAGE = `This account is blocked. Write to ${SUPPORT_EMAIL} to ask for it to be reactivated.`

/** True when a failed sign-in was refused because the user is blocked. */
export function isBlockedSignIn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'user_banned' || /\bbanned\b/i.test(error.message ?? '')
}

/**
 * How long the sign-in service keeps a blocked user out. It has no
 * "forever", so a century stands in for it; 'none' lifts it.
 */
export const BLOCK_DURATION = '876000h'
