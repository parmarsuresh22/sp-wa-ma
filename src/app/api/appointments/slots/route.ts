import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { loadAppointmentSettings, slotsForDate } from '@/lib/appointments/service'
import { DATE_RE } from '@/lib/appointments/time'

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/appointments/slots?channel_id=&date=YYYY-MM-DD[&ignore=<id>]   (agent+)
 *
 * The slots of one day with the places left in each. `ignore` leaves
 * one appointment out of the count, for moving it.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const params = new URL(request.url).searchParams
    const channelId = params.get('channel_id') ?? ''
    const date = params.get('date') ?? ''
    const ignore = params.get('ignore')
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    if (!DATE_RE.test(date)) return NextResponse.json({ error: 'Choose a date' }, { status: 400 })

    const db = supabaseAdmin()
    if (!(await loadChannel(db, accountId, channelId))) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }
    const settings = await loadAppointmentSettings(db, accountId, channelId)
    const slots = await slotsForDate(db, settings, date, new Date(), ignore && UUID.test(ignore) ? ignore : null)
    return NextResponse.json({
      slots: slots.map((s) => ({ time: s.time, starts_at: s.startsAt.toISOString(), left: s.left, free: s.free })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
