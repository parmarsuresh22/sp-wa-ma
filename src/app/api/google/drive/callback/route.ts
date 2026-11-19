import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { safeEqual } from '@/lib/cron-auth'
import { encrypt } from '@/lib/whatsapp/encryption'
import { publicOrigin } from '@/lib/whatsapp/public-origin'
import {
  DRIVE_STATE_COOKIE,
  driveUserEmail,
  exchangeDriveCode,
  loadGoogleClient,
} from '@/lib/google/drive'

/**
 * GET /api/google/drive/callback
 *
 * Where Google sends the person back to. Checks the `state` against the
 * cookie set by /connect, trades the code for tokens and stores the
 * refresh token (encrypted) for the signed-in admin's account. Always
 * ends with a redirect to the Posts page carrying the outcome.
 */
export async function GET(request: Request) {
  const origin = publicOrigin(request)
  const done = (outcome: string) => {
    const res = NextResponse.redirect(`${origin}/posts?drive=${encodeURIComponent(outcome)}`)
    res.cookies.set(DRIVE_STATE_COOKIE, '', { path: '/api/google/drive', maxAge: 0 })
    return res
  }

  const url = new URL(request.url)
  if (url.searchParams.get('error')) return done('denied')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expected = (await cookies()).get(DRIVE_STATE_COOKIE)?.value
  if (!code || !state || !expected || !safeEqual(state, expected)) return done('error')

  let accountId: string
  let userId: string
  try {
    const ctx = await requireRole('admin')
    accountId = ctx.accountId
    userId = ctx.userId
  } catch {
    return done('forbidden')
  }

  try {
    const db = supabaseAdmin()
    const client = await loadGoogleClient(db)
    if (!client) return done('not_configured')
    const tokens = await exchangeDriveCode(client, origin, code)
    const email = await driveUserEmail(tokens.accessToken)
    const { error } = await db.from('google_drive_connections').upsert(
      {
        account_id: accountId,
        refresh_token: encrypt(tokens.refreshToken),
        email,
        folder_id: null,
        connected_by: userId,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (error) throw new Error(error.message)
    return done('connected')
  } catch (err) {
    console.error('[drive] connect failed:', err instanceof Error ? err.message : err)
    return done('error')
  }
}
