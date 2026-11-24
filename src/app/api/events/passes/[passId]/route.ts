import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkIn } from '@/lib/events/service'

/**
 * PATCH /api/events/passes/:passId   (agent+)
 * Body: { action: 'checkin' | 'undo' | 'cancel' | 'restore' }
 *
 *   checkin  admit the holder without scanning (found by name or phone)
 *   undo     a scan by mistake: the pass is valid again
 *   cancel   the pass shows red at the gate (payment turned out fake…)
 *   restore  a cancelled pass is valid again
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ passId: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent', 'events')
    const { passId } = await params
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const action = typeof body?.action === 'string' ? body.action : ''

    const db = supabaseAdmin()
    const { data: pass } = await db
      .from('event_passes')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', passId)
      .maybeSingle()
    if (!pass) return NextResponse.json({ error: 'Pass not found' }, { status: 404 })
    const row = pass as { id: string; event_id: string; code: string }

    if (action === 'checkin') {
      // The same guarded step the scanner uses, so it is logged and
      // cannot admit a pass twice.
      const scan = await checkIn(db, accountId, row.event_id, row.code, userId)
      const { data: fresh } = await db.from('event_passes').select('*').eq('id', passId).maybeSingle()
      return NextResponse.json({ pass: fresh, scan })
    }

    const change =
      action === 'undo'
        ? { from: 'used', to: { status: 'valid', used_at: null, used_by: null } }
        : action === 'cancel'
          ? { from: 'valid', to: { status: 'cancelled' } }
          : action === 'restore'
            ? { from: 'cancelled', to: { status: 'valid' } }
            : null
    if (!change) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const { data: updated } = await db
      .from('event_passes')
      .update(change.to)
      .eq('id', passId)
      .eq('status', change.from)
      .select('*')
    const fresh = (updated ?? [])[0]
    if (!fresh) return NextResponse.json({ error: 'The pass changed meanwhile, please refresh' }, { status: 409 })
    await db.from('event_scans').insert({
      account_id: accountId,
      event_id: row.event_id,
      pass_id: row.id,
      code: row.code,
      result: `manual_${action}`,
      scanned_by: userId,
    })
    return NextResponse.json({ pass: fresh })
  } catch (err) {
    return toErrorResponse(err)
  }
}
