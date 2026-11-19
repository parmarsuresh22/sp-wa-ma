import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'
import { publicOrigin } from '@/lib/whatsapp/public-origin'
import {
  approveWebNumberRequest,
  rejectWebNumberRequest,
  WebNumberRequestError,
} from '@/lib/whatsapp/web-number-requests'

// Approval creates the session on the bridge, which can take a while.
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/admin8085/requests/[id]   (platform admin only)
 *
 * Body: { action: 'approve' | 'reject', note?: string }
 *
 * Approve creates the WhatsApp Web channel for the requesting account
 * on the platform bridge; the account then sees a QR code to scan.
 */
export async function POST(request: Request, { params }: Params) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = body?.action

  try {
    if (action === 'approve') {
      const { channel } = await approveWebNumberRequest(admin.db, id, {
        decidedBy: admin.userId,
        origin: publicOrigin(request),
      })
      return NextResponse.json({ success: true, channel_id: channel.id })
    }
    if (action === 'reject') {
      await rejectWebNumberRequest(admin.db, id, {
        decidedBy: admin.userId,
        note: typeof body?.note === 'string' ? body.note : null,
      })
      return NextResponse.json({ success: true })
    }
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
  } catch (err) {
    if (err instanceof WebNumberRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[admin] request decision failed:', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
