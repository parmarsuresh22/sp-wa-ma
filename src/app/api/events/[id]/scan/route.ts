import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkIn } from '@/lib/events/service'
import { parsePassQr } from '@/lib/events/types'

/**
 * POST /api/events/:id/scan   (agent+)
 * Body: { code }  — the text of the scanned QR (or a typed pass code)
 *
 * Admits the pass once. `result`:
 *   ok           valid — let them in (now marked used)
 *   used         already admitted, with the time of the first scan
 *   cancelled    the business cancelled this pass
 *   wrong_event  a real pass, but for another event
 *   unknown      not a pass of this business
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent', 'events')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null
    const scanned = typeof body?.code === 'string' ? body.code : ''
    const db = supabaseAdmin()

    const { data: event } = await db.from('events').select('id').eq('account_id', accountId).eq('id', id).maybeSingle()
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

    const code = parsePassQr(scanned)
    if (!code) {
      await db.from('event_scans').insert({
        account_id: accountId,
        event_id: id,
        code: scanned.slice(0, 80),
        result: 'unknown',
        scanned_by: userId,
      })
      return NextResponse.json({ result: 'unknown' })
    }
    return NextResponse.json(await checkIn(db, accountId, id, code, userId))
  } catch (err) {
    return toErrorResponse(err)
  }
}
