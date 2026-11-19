import { NextResponse } from 'next/server'
import { requireRole, ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { publicOrigin } from '@/lib/whatsapp/public-origin'
import {
  DRIVE_STATE_COOKIE,
  driveAuthUrl,
  loadGoogleClient,
  newOAuthState,
} from '@/lib/google/drive'

/**
 * GET /api/google/drive/connect   (admin+)
 *
 * Starts "Connect Google Drive": sends the browser to Google's consent
 * screen. A random `state` goes out in the URL and into an httpOnly
 * cookie; the callback only accepts a reply that carries the same one,
 * so a link crafted by someone else cannot attach their Drive here.
 */
export async function GET(request: Request) {
  const origin = publicOrigin(request)
  const back = (reason: string) =>
    NextResponse.redirect(`${origin}/posts?drive=${encodeURIComponent(reason)}`)
  try {
    await requireRole('admin')
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.redirect(`${origin}/login`)
    if (err instanceof ForbiddenError) return back('forbidden')
    return back('error')
  }

  const client = await loadGoogleClient(supabaseAdmin())
  if (!client) return back('not_configured')

  const state = newOAuthState()
  const res = NextResponse.redirect(driveAuthUrl(client, origin, state))
  res.cookies.set(DRIVE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith('https://'),
    sameSite: 'lax',
    path: '/api/google/drive',
    maxAge: 600,
  })
  return res
}
