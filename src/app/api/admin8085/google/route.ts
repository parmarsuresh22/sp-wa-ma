import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'
import { publicOrigin } from '@/lib/whatsapp/public-origin'
import { driveRedirectUri, loadGoogleClient, saveGoogleClient } from '@/lib/google/drive'

/**
 * GET /api/admin8085/google   (platform admin only)
 *
 * Whether a Google OAuth client is saved, and the redirect address that
 * must be registered for it in Google Cloud.
 */
export async function GET(request: Request) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const client = await loadGoogleClient(admin.db)
  return NextResponse.json({
    configured: !!client,
    client_id: client?.clientId ?? null,
    redirect_uri: driveRedirectUri(publicOrigin(request)),
  })
}

/**
 * PUT /api/admin8085/google   (platform admin only)
 *
 * Body: { client_id, client_secret }
 *
 * Save the Google OAuth client every account's "Connect Google Drive"
 * uses. The secret is encrypted at rest and never returned.
 */
export async function PUT(request: Request) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
  const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret.trim() : ''
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    return NextResponse.json(
      { error: 'The client ID should end with .apps.googleusercontent.com' },
      { status: 400 },
    )
  }
  if (clientSecret.length < 10) {
    return NextResponse.json({ error: 'The client secret is required' }, { status: 400 })
  }
  try {
    await saveGoogleClient(admin.db, { clientId, clientSecret })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not save' },
      { status: 500 },
    )
  }
  return NextResponse.json({ success: true })
}
