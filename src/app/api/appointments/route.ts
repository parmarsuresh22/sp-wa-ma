import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { phoneKey } from '@/lib/data-tables/lookup'
import {
  AppointmentError,
  bookAppointment,
  loadAppointmentSettings,
  sendAppointmentMessage,
} from '@/lib/appointments/service'
import { DATE_RE, TIME_RE } from '@/lib/appointments/time'

const UUID = /^[0-9a-f-]{36}$/i

export const maxDuration = 60

/**
 * POST /api/appointments   (agent+)
 *
 * Body: { channel_id, contact_id, date: 'YYYY-MM-DD', time: 'HH:MM' }
 *
 * Book an appointment from the portal for a contact of that WhatsApp
 * number, and send the customer the confirmation straight away. The
 * booking stands even if the message could not be delivered; the
 * response says so in `message_error`.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const channelId = typeof body?.channel_id === 'string' ? body.channel_id : ''
    const contactId = typeof body?.contact_id === 'string' ? body.contact_id : ''
    const date = typeof body?.date === 'string' ? body.date : ''
    const time = typeof body?.time === 'string' ? body.time : ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    if (!UUID.test(contactId)) return NextResponse.json({ error: 'Choose a contact' }, { status: 400 })
    if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
      return NextResponse.json({ error: 'Choose a date and a time' }, { status: 400 })
    }

    const db = supabaseAdmin()
    if (!(await loadChannel(db, accountId, channelId))) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }

    // Only a contact of this number: someone with a chat on it.
    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone, conversations!inner(id, channel_id)')
      .eq('account_id', accountId)
      .eq('id', contactId)
      .eq('conversations.channel_id', channelId)
      .maybeSingle()
    const row = contact as { id: string; name: string | null; phone: string | null; conversations?: { id: string }[] } | null
    if (!row) {
      return NextResponse.json({ error: 'That contact does not belong to this WhatsApp number' }, { status: 400 })
    }
    const key = phoneKey(row.phone)
    if (!key) return NextResponse.json({ error: 'That contact has no phone number' }, { status: 400 })

    const settings = await loadAppointmentSettings(db, accountId, channelId)
    if (!settings.id) {
      return NextResponse.json({ error: 'Save the appointment settings for this number first' }, { status: 400 })
    }

    let appointment
    try {
      appointment = await bookAppointment(db, {
        settings,
        contactId: row.id,
        conversationId: row.conversations?.[0]?.id ?? null,
        phoneKey: key,
        customerName: row.name,
        date,
        time,
        source: 'portal',
        createdBy: userId,
      })
    } catch (err) {
      if (err instanceof AppointmentError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      throw err
    }

    let messageError: string | null = null
    try {
      await sendAppointmentMessage(db, 'confirmed', appointment, settings, userId)
    } catch (err) {
      messageError = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    }
    return NextResponse.json({ appointment, message_error: messageError }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
