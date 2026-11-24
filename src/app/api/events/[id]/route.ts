import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadEvent, loadStats, updateEvent } from '@/lib/events/service'
import { parseEventInput } from '@/lib/events/types'

/** GET /api/events/:id   (viewer+) — one event with its counts. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('viewer', 'events')
    const { id } = await params
    const db = supabaseAdmin()
    const event = await loadEvent(db, accountId, id)
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    return NextResponse.json({ event, stats: await loadStats(db, accountId, [event.id]) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PATCH /api/events/:id   (admin+) — change the event and its pass types. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin', 'events')
    const { id } = await params
    const db = supabaseAdmin()
    const current = await loadEvent(db, accountId, id)
    if (!current) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    const parsed = parseEventInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const event = await updateEvent(db, current, parsed.value)
    return NextResponse.json({ event, stats: await loadStats(db, accountId, [event.id]) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
