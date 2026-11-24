import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ServiceError, loadServiceData, requireWebChannel } from '@/lib/service/service'

/**
 * GET /api/service?channel_id=   (viewer+)   — "service-get"
 *
 * Everything the Service Today page shows for one WhatsApp Web number:
 * { business, customers, visits, today }. `business` is null until the
 * name and address have been saved.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer', 'service')
    const db = supabaseAdmin()
    const channel = await requireWebChannel(db, accountId, new URL(request.url).searchParams.get('channel_id'))
    return NextResponse.json({ ok: true, ...(await loadServiceData(db, accountId, channel.id)) })
  } catch (err) {
    if (err instanceof ServiceError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
