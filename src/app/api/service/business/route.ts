import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ServiceError, requireWebChannel, saveServiceBusiness } from '@/lib/service/service'

/**
 * POST /api/service/business   (admin+)   — "service-business-save"
 *
 * Body: { channel_id, name, address, language?, reminder_time? }
 * The first save sets Service Today up for the number; later saves
 * change what customers see in their messages.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin', 'service')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const db = supabaseAdmin()
    const channel = await requireWebChannel(db, accountId, body?.channel_id)
    const business = await saveServiceBusiness(db, accountId, channel.id, body)
    return NextResponse.json({ ok: true, business })
  } catch (err) {
    if (err instanceof ServiceError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
