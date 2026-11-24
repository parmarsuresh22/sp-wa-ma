import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { resolveOrderContact } from '@/lib/events/contact'
import {
  EventError,
  issueOrder,
  loadEvent,
  reserveOrder,
  sendPasses,
  sendPaymentRequest,
} from '@/lib/events/service'

export const maxDuration = 120

const STATUSES = ['awaiting_payment', 'review', 'issued', 'rejected', 'cancelled']

/** Characters that would break a PostgREST `or` filter. */
function searchTerm(raw: string | null): string {
  return (raw ?? '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 60)
}

/**
 * GET /api/events/:id/orders?status=&q=&page=&size=   (viewer+)
 * The requests for one event, newest first.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('viewer', 'events')
    const { id } = await params
    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? ''
    const q = searchTerm(url.searchParams.get('q'))
    const size = Math.min(50, Math.max(1, Number(url.searchParams.get('size')) || 20))
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0)

    const db = supabaseAdmin()
    let query = db
      .from('event_orders')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .eq('event_id', id)
    if (STATUSES.includes(status)) query = query.eq('status', status)
    // "closed" = refused or given up.
    else if (status === 'closed') query = query.in('status', ['rejected', 'cancelled'])
    if (q) {
      query = query.or(
        `customer_name.ilike.%${q}%,phone_key.ilike.%${q}%,code.ilike.%${q}%,payment_ref.ilike.%${q}%`,
      )
    }
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(page * size, page * size + size - 1)
    if (error) throw error
    return NextResponse.json({ rows: data ?? [], total: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/events/:id/orders   (agent+)
 *
 * Issue passes from the portal.
 * Body: { pass_type_id, quantity, payment: 'free' | 'paid' | 'request',
 *         and one of contact_id | new_contact: { name, phone } }
 *
 *   free     a complimentary pass: issued and sent now
 *   paid     the money was already collected: issued and sent now
 *   request  send the customer the payment QR in the chat; the pass is
 *            issued when their screenshot is approved
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent', 'events')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const passTypeId = typeof body?.pass_type_id === 'string' ? body.pass_type_id : ''
    const quantity = Number(body?.quantity)
    const payment = body?.payment === 'paid' || body?.payment === 'request' ? body.payment : 'free'
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return NextResponse.json({ error: 'Choose how many passes (1 to 50)' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const event = await loadEvent(db, accountId, id)
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    const type = event.pass_types.find((t) => t.id === passTypeId)
    if (!type) return NextResponse.json({ error: 'Choose a pass type' }, { status: 400 })
    if (payment === 'request' && type.price <= 0) {
      return NextResponse.json({ error: 'This pass type is free, there is nothing to pay' }, { status: 400 })
    }
    if (payment === 'request' && !event.upi_id) {
      return NextResponse.json({ error: 'Add a UPI ID to the event first' }, { status: 400 })
    }
    const channel = await loadChannel(db, accountId, event.channel_id)
    if (!channel) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })

    try {
      const contact = await resolveOrderContact(db, accountId, channel, {
        contactId: body?.contact_id,
        fresh: body?.new_contact,
      })
      const order = await reserveOrder(db, {
        event,
        passTypeId: type.id,
        contactId: contact.id,
        conversationId: contact.conversationId,
        phoneKey: contact.phoneKey,
        customerName: contact.name,
        quantity,
        source: 'portal',
        createdBy: userId,
        amount: payment === 'free' ? 0 : null,
      })
      if (payment === 'request') {
        const messageError = await sendPaymentRequest(db, event, order, userId)
        return NextResponse.json({ order, message_error: messageError }, { status: 201 })
      }
      const done = await issueOrder(db, order, { decidedBy: userId })
      if (!done) return NextResponse.json({ error: 'Could not issue the passes, please try again' }, { status: 500 })
      const messageError = await sendPasses(db, event, done.order, done.passes, userId)
      return NextResponse.json({ order: done.order, message_error: messageError }, { status: 201 })
    } catch (err) {
      if (err instanceof EventError) {
        return NextResponse.json({ error: err.message, code: err.code, detail: err.detail }, { status: err.status })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
