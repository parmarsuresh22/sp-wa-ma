import { NextResponse } from 'next/server'
import { getSuperAdmin, savePlatformBridge } from '@/lib/admin/super-admin'
import { createWahaClient, normalizeBridgeBaseUrl, WahaError } from '@/lib/whatsapp/providers/waha'

/**
 * PUT /api/admin8085/bridge   (platform admin only)
 *
 * Body: { url: string, api_key: string }
 *
 * Set the WAHA bridge approved WhatsApp Web numbers are created on.
 * The bridge is contacted first, so a wrong address or key is refused
 * here rather than at the next approval. Existing numbers keep the
 * bridge they were created on.
 */
export async function PUT(request: Request) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const baseUrl = normalizeBridgeBaseUrl(typeof body?.url === 'string' ? body.url : '')
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  if (!baseUrl) {
    return NextResponse.json({ error: 'Bridge URL must be a valid http(s) URL' }, { status: 400 })
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'Bridge API key is required' }, { status: 400 })
  }

  try {
    await createWahaClient({ baseUrl, apiKey }).listSessions()
  } catch (err) {
    const status = err instanceof WahaError ? err.status : 502
    return NextResponse.json(
      {
        error:
          status === 401 || status === 403
            ? 'The bridge rejected the API key'
            : `Could not reach the bridge: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 },
    )
  }

  try {
    await savePlatformBridge(admin.db, { baseUrl, apiKey })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not save' },
      { status: 500 },
    )
  }
  return NextResponse.json({ success: true, url: baseUrl })
}
