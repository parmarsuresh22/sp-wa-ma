import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit } from '@/lib/rate-limit'
import { EventError, approveOrder, loadEvent, loadOrderByToken, rejectOrder } from '@/lib/events/service'

export const maxDuration = 120

/**
 * POST /api/events/review/:token
 * Body: { action: 'approve' | 'reject' }
 *
 * The one-tap approval sent to the event's approval number. There is no
 * sign-in: the long random token in the link is the permission, and it
 * only ever decides this one order. (Opening the link does nothing by
 * itself — link previews fetch pages — the decision needs this POST.)
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const limit = checkRateLimit(`event-review:${token.slice(0, 16)}`, { limit: 20, windowMs: 60_000 })
  if (!limit.success) return NextResponse.json({ error: 'Too many tries, wait a minute' }, { status: 429 })

  try {
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const db = supabaseAdmin()
    const order = await loadOrderByToken(db, token)
    if (!order) return NextResponse.json({ error: 'This link is not valid' }, { status: 404 })
    const event = await loadEvent(db, order.account_id, order.event_id)
    if (!event) return NextResponse.json({ error: 'This link is not valid' }, { status: 404 })
    if (order.status !== 'review' && order.status !== 'awaiting_payment') {
      return NextResponse.json({ error: 'This payment was already decided', status: order.status }, { status: 409 })
    }

    if (body?.action === 'approve') {
      const done = await approveOrder(db, event, order, null)
      if (!done) return NextResponse.json({ error: 'This payment was already decided' }, { status: 409 })
      return NextResponse.json({ status: 'issued', message_error: done.message_error })
    }
    if (body?.action === 'reject') {
      const done = await rejectOrder(db, event, order, null)
      if (!done) return NextResponse.json({ error: 'This payment was already decided' }, { status: 409 })
      return NextResponse.json({ status: 'rejected', message_error: done.message_error })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    if (err instanceof EventError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[events] review link failed:', err)
    return NextResponse.json({ error: 'Something went wrong, please try again' }, { status: 500 })
  }
}
