import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { createEvent, listEvents, loadStats } from '@/lib/events/service'
import { parseEventInput } from '@/lib/events/types'

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/events?channel_id=…   (viewer+)
 * The events of one WhatsApp number with their pass types and counts.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer', 'events')
    const channelId = new URL(request.url).searchParams.get('channel_id') ?? ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    const db = supabaseAdmin()
    const events = await listEvents(db, accountId, channelId)
    const stats = await loadStats(db, accountId, events.map((e) => e.id))
    return NextResponse.json({ events, stats })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/events   (admin+)
 * Body: { channel_id, name, date, time, pass_types: [...], … }
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin', 'events')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const channelId = typeof body?.channel_id === 'string' ? body.channel_id : ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    const parsed = parseEventInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const db = supabaseAdmin()
    if (!(await loadChannel(db, accountId, channelId))) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }
    const event = await createEvent(db, accountId, channelId, parsed.value, userId)
    return NextResponse.json({ event }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
