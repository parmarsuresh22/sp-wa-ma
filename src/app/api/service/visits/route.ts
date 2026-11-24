import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ServiceError, requireWebChannel, saveServiceVisit } from '@/lib/service/service'

export const maxDuration = 60

/**
 * POST /api/service/visits   (agent+)   — "service-instance-save"
 *
 * Body: { channel_id, customerId? | customerPhone, customerName, area?,
 *         service, visitDate, nextVisit, comment?, images? }
 *
 * Saves the entry and sends the customer a WhatsApp confirmation.
 * Answers { ok, sent, visit, customer, message_error }: an entry whose
 * message could not be sent is still saved.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent', 'service')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const db = supabaseAdmin()
    const channel = await requireWebChannel(db, accountId, body?.channel_id)
    const saved = await saveServiceVisit(db, { accountId, channel, userId, body: body ?? {} })
    return NextResponse.json({ ok: true, ...saved }, { status: 201 })
  } catch (err) {
    if (err instanceof ServiceError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
