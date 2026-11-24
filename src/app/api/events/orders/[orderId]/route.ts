import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  EventError,
  approveOrder,
  closeOrder,
  loadEvent,
  loadOrder,
  passesOfOrder,
  rejectOrder,
  sendPasses,
  sendPaymentRequest,
} from '@/lib/events/service'

export const maxDuration = 120

/**
 * PATCH /api/events/orders/:orderId   (agent+)
 * Body: { action: 'approve' | 'reject' | 'cancel' | 'resend' }
 *
 *   approve  the payment is fine: issue the passes and send them
 *   reject   the payment could not be confirmed: tell the customer
 *   cancel   drop a request that was never paid (no message)
 *   resend   send the payment QR (unpaid) or the passes (issued) again
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent', 'events')
    const { orderId } = await params
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const action = typeof body?.action === 'string' ? body.action : ''

    const db = supabaseAdmin()
    const order = await loadOrder(db, accountId, orderId)
    if (!order) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    const event = await loadEvent(db, accountId, order.event_id)
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    const gone = () => NextResponse.json({ error: 'This request was already decided' }, { status: 409 })

    try {
      if (action === 'approve') {
        const done = await approveOrder(db, event, order, userId)
        if (!done) return gone()
        return NextResponse.json({ order: done.order, message_error: done.message_error })
      }
      if (action === 'reject') {
        const done = await rejectOrder(db, event, order, userId)
        if (!done) return gone()
        return NextResponse.json({ order: await loadOrder(db, accountId, orderId), message_error: done.message_error })
      }
      if (action === 'cancel') {
        if (!(await closeOrder(db, order, 'cancelled', userId))) return gone()
        return NextResponse.json({ order: await loadOrder(db, accountId, orderId), message_error: null })
      }
      if (action === 'resend') {
        let messageError: string | null
        if (order.status === 'issued') {
          const passes = (await passesOfOrder(db, order.id)).filter((p) => p.status !== 'cancelled')
          if (passes.length === 0) return NextResponse.json({ error: 'Every pass of this request was cancelled' }, { status: 400 })
          messageError = await sendPasses(db, event, order, passes, userId)
        } else if (order.status === 'awaiting_payment' && order.amount > 0) {
          messageError = await sendPaymentRequest(db, event, order, userId)
        } else {
          return NextResponse.json({ error: 'There is nothing to send for this request' }, { status: 400 })
        }
        return NextResponse.json({ order: await loadOrder(db, accountId, orderId), message_error: messageError })
      }
    } catch (err) {
      if (err instanceof EventError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      throw err
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
