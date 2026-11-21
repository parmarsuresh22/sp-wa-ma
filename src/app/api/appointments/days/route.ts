import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { loadAppointmentSettings, monthAvailability } from '@/lib/appointments/service'
import { localParts } from '@/lib/appointments/time'

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/appointments/days?channel_id=&month=YYYY-MM[&ignore=<id>]   (agent+)
 *
 * For each day of the month: is the business open, and how many slots
 * can still be booked. Drives the date picker, which offers only days
 * that have a free slot.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const params = new URL(request.url).searchParams
    const channelId = params.get('channel_id') ?? ''
    const month = params.get('month') ?? ''
    const ignore = params.get('ignore')
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: 'Choose a month' }, { status: 400 })

    const db = supabaseAdmin()
    if (!(await loadChannel(db, accountId, channelId))) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }
    const settings = await loadAppointmentSettings(db, accountId, channelId)
    const now = new Date()
    const days = await monthAvailability(db, settings, month, now, ignore && UUID.test(ignore) ? ignore : null)
    return NextResponse.json({ days, today: localParts(now, settings.timezone).date })
  } catch (err) {
    return toErrorResponse(err)
  }
}
