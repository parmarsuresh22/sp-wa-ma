import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { phoneKey } from '@/lib/data-tables/lookup'
import { ContactError, findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
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
 * Body: { channel_id, date: 'YYYY-MM-DD', time: 'HH:MM', and one of
 *         contact_id                       a contact of this number
 *         new_contact: { name, phone }     a number not saved yet }
 *
 * Book an appointment from the portal and send the customer the
 * confirmation straight away. A new number is saved as a contact of
 * this WhatsApp number first (or matched to the existing contact with
 * that phone), so it is there for next time. The
 * booking stands even if the message could not be delivered; the
 * response says so in `message_error`.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent', 'appointments')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const channelId = typeof body?.channel_id === 'string' ? body.channel_id : ''
    const contactId = typeof body?.contact_id === 'string' ? body.contact_id : ''
    const date = typeof body?.date === 'string' ? body.date : ''
    const time = typeof body?.time === 'string' ? body.time : ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    const fresh =
      body?.new_contact && typeof body.new_contact === 'object'
        ? (body.new_contact as { name?: unknown; phone?: unknown })
        : null
    if (!fresh && !UUID.test(contactId)) return NextResponse.json({ error: 'Choose a contact' }, { status: 400 })
    if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
      return NextResponse.json({ error: 'Choose a date and a time' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, channelId)
    if (!channel) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }

    let row: { id: string; name: string | null; phone: string | null; conversations?: { id: string }[] } | null
    if (fresh) {
      // A 10-digit number is taken to be in the same country as the
      // business's own number; anything longer must carry its country code.
      const typed = typeof fresh.phone === 'string' ? fresh.phone.trim() : ''
      const digits = typed.replace(/\D/g, '')
      const ownDigits = (channel.display_phone ?? '').replace(/\D/g, '')
      const countryCode = ownDigits.length > 10 ? ownDigits.slice(0, ownDigits.length - 10) : '91'
      const phone = typed.startsWith('+')
        ? `+${digits}`
        : digits.length === 10
          ? `+${countryCode}${digits}`
          : digits.length > 10
            ? `+${digits}`
            : ''
      if (!phone) {
        return NextResponse.json({ error: 'Enter a mobile number with at least 10 digits' }, { status: 400 })
      }
      const name = typeof fresh.name === 'string' ? fresh.name.trim().slice(0, 120) : ''
      try {
        const auditUserId = await resolveAuditUserId(db, accountId)
        const made = await findOrCreateContact(db, accountId, auditUserId, { phone, name: name || null })
        // A chat on this number makes them a contact of this number.
        const conversation = await findOrCreateConversationRow(db, accountId, made.id, auditUserId, channelId)
        const { data: saved } = await db
          .from('contacts')
          .select('id, name, phone')
          .eq('id', made.id)
          .eq('account_id', accountId)
          .maybeSingle()
        row = saved ? { ...(saved as { id: string; name: string | null; phone: string | null }), conversations: [{ id: conversation.id }] } : null
      } catch (err) {
        if (err instanceof ContactError) {
          return NextResponse.json({ error: 'That mobile number is not valid' }, { status: 400 })
        }
        throw err
      }
      if (!row) return NextResponse.json({ error: 'Could not save the contact' }, { status: 500 })
    } else {
      // Only a contact of this number: someone with a chat on it.
      const { data: contact } = await db
        .from('contacts')
        .select('id, name, phone, conversations!inner(id, channel_id)')
        .eq('account_id', accountId)
        .eq('id', contactId)
        .eq('conversations.channel_id', channelId)
        .maybeSingle()
      row = contact as typeof row
      if (!row) {
        return NextResponse.json({ error: 'That contact does not belong to this WhatsApp number' }, { status: 400 })
      }
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
