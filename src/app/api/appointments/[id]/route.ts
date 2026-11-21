import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  AppointmentError,
  bookAppointment,
  cancelAppointment,
  loadAppointmentSettings,
  sendAppointmentMessage,
  ATTACHMENT_MIMES,
  MAX_ATTACHMENTS,
  type AppointmentAttachment,
  type AppointmentRow,
} from '@/lib/appointments/service'
import { isAccountMediaUrl } from '@/lib/posts/post'
import { DATE_RE, TIME_RE, reminderAt } from '@/lib/appointments/time'

type Params = { params: Promise<{ id: string }> }

export const maxDuration = 60

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null)

/**
 * PATCH /api/appointments/[id]   (agent+)
 *
 * Body, one of:
 *   { action: 'reschedule', date, time }   move it; the customer is told
 *   { action: 'cancel' }                   cancel it; the customer is told
 *   { action: 'confirm', date?, time? }    approve a request (optionally at another time); the customer is told
 *   { action: 'decline' }                  turn a request down; the customer is told
 *   { action: 'complete' }                 close a visit
 *   { action: 'no_show' }                  the customer did not come; they are told
 *   { action: 'reopen' }                   back to booked (undo)
 *   { action: 'notes', treatment, medicine, notes }
 *
 * `complete` and `notes` also accept treatment / medicine / notes and
 * `attachments` (up to five images or PDFs this account uploaded).
 * `complete` also accepts `next_date` + `next_time`: the next visit is
 * booked for the same customer and they are told at once.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent', 'appointments')
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const action = typeof body?.action === 'string' ? body.action : ''

    const db = supabaseAdmin()
    const { data: found } = await db
      .from('appointments')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const current = found as AppointmentRow | null
    if (!current) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })

    const settings = await loadAppointmentSettings(db, accountId, current.channel_id)
    const now = new Date().toISOString()
    let appointment: AppointmentRow | null = null
    let messageError: string | null = null
    let nextAppointment: AppointmentRow | null = null
    let nextError: string | null = null
    const tell = async (
      kind: 'rescheduled' | 'cancelled' | 'confirmed' | 'confirmed_new_time' | 'declined' | 'no_show',
      appt: AppointmentRow,
    ) => {
      try {
        await sendAppointmentMessage(db, kind, appt, settings, userId)
      } catch (err) {
        messageError = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      }
    }
    const update = async (patch: Record<string, unknown>, onlyStatus?: string[]) => {
      let q = db.from('appointments').update({ ...patch, updated_at: now }).eq('id', id).eq('account_id', accountId)
      if (onlyStatus) q = q.in('status', onlyStatus)
      const { data, error } = await q.select('*')
      if (error) throw new Error(error.message)
      return ((data ?? [])[0] as AppointmentRow | undefined) ?? null
    }
    const noteFields = () => {
      const patch: Record<string, unknown> = {}
      if (body && 'treatment' in body) patch.treatment = clean(body.treatment, 2000)
      if (body && 'medicine' in body) patch.medicine = clean(body.medicine, 2000)
      if (body && 'notes' in body) patch.notes = clean(body.notes, 2000)
      if (body && Array.isArray(body.attachments)) {
        const files: AppointmentAttachment[] = []
        for (const raw of body.attachments as unknown[]) {
          const f = raw as { url?: unknown; name?: unknown; mime?: unknown } | null
          if (!f || typeof f.url !== 'string' || typeof f.mime !== 'string') continue
          // Only files this account uploaded to its own folder.
          if (!isAccountMediaUrl(f.url, process.env.NEXT_PUBLIC_SUPABASE_URL, accountId)) continue
          if (!ATTACHMENT_MIMES.includes(f.mime)) continue
          files.push({
            url: f.url,
            mime: f.mime,
            name: (typeof f.name === 'string' ? f.name : 'file').slice(0, 120),
          })
        }
        if (files.length > MAX_ATTACHMENTS) throw new TooManyFiles()
        patch.attachments = files
      }
      return patch
    }

    if (action === 'reschedule') {
      const date = typeof body?.date === 'string' ? body.date : ''
      const time = typeof body?.time === 'string' ? body.time : ''
      if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
        return NextResponse.json({ error: 'Choose a date and a time' }, { status: 400 })
      }
      if (current.status !== 'booked' && current.status !== 'pending') {
        return NextResponse.json({ error: 'Only a booked appointment can be moved' }, { status: 400 })
      }
      try {
        appointment = await bookAppointment(db, {
          settings,
          contactId: current.contact_id,
          conversationId: current.conversation_id,
          phoneKey: current.phone_key,
          customerName: current.customer_name,
          date,
          time,
          source: 'portal',
          createdBy: userId,
          replaceId: current.id,
          // A request moved by the business stays a request until it is
          // confirmed; a confirmed booking stays confirmed.
          status: current.status === 'pending' ? 'pending' : 'booked',
        })
      } catch (err) {
        if (err instanceof AppointmentError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
        }
        throw err
      }
      if (appointment.status === 'booked') await tell('rescheduled', appointment)
    } else if (action === 'confirm') {
      // Approve a request waiting for confirmation — as asked, or at a
      // different date and time the business picks.
      if (current.status !== 'pending') {
        return NextResponse.json({ error: 'This appointment is not waiting for confirmation' }, { status: 400 })
      }
      const date = typeof body?.date === 'string' ? body.date : ''
      const time = typeof body?.time === 'string' ? body.time : ''
      const moved = !!date || !!time
      if (moved && (!DATE_RE.test(date) || !TIME_RE.test(time))) {
        return NextResponse.json({ error: 'Choose a date and a time' }, { status: 400 })
      }
      if (moved) {
        try {
          appointment = await bookAppointment(db, {
            settings,
            contactId: current.contact_id,
            conversationId: current.conversation_id,
            phoneKey: current.phone_key,
            customerName: current.customer_name,
            date,
            time,
            source: 'portal',
            createdBy: userId,
            replaceId: current.id,
            status: 'booked',
          })
        } catch (err) {
          if (err instanceof AppointmentError) {
            return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
          }
          throw err
        }
        await tell('confirmed_new_time', appointment)
      } else {
        const startsAt = new Date(current.starts_at)
        appointment = await update(
          { status: 'booked', reminder_at: reminderAt(settings, startsAt, new Date())?.toISOString() ?? null },
          ['pending'],
        )
        if (appointment) await tell('confirmed', appointment)
      }
    } else if (action === 'decline') {
      appointment = await update({ status: 'cancelled', cancelled_at: now }, ['pending'])
      if (appointment) await tell('declined', appointment)
    } else if (action === 'cancel') {
      appointment = await cancelAppointment(db, accountId, id)
      if (!appointment) return NextResponse.json({ error: 'Only a booked appointment can be cancelled' }, { status: 400 })
      // Nobody needs telling that a visit already in the past was cancelled.
      if (Date.parse(appointment.starts_at) > Date.now()) await tell('cancelled', appointment)
    } else if (action === 'complete') {
      const nextDate = typeof body?.next_date === 'string' ? body.next_date : ''
      const nextTime = typeof body?.next_time === 'string' ? body.next_time : ''
      const wantsNext = !!nextDate || !!nextTime
      if (wantsNext && (!DATE_RE.test(nextDate) || !TIME_RE.test(nextTime))) {
        return NextResponse.json({ error: 'Choose a date and a time for the next visit' }, { status: 400 })
      }
      appointment = await update({ status: 'completed', completed_at: now, ...noteFields() }, ['booked', 'no_show'])
      // The visit is closed first, so it no longer counts as this
      // customer's upcoming appointment; then the next one is booked.
      if (appointment && wantsNext) {
        try {
          nextAppointment = await bookAppointment(db, {
            settings,
            contactId: current.contact_id,
            conversationId: current.conversation_id,
            phoneKey: current.phone_key,
            customerName: current.customer_name,
            date: nextDate,
            time: nextTime,
            source: 'portal',
            createdBy: userId,
          })
          await tell('confirmed', nextAppointment)
        } catch (err) {
          nextError = err instanceof AppointmentError ? err.message : 'Could not book the next visit'
        }
      }
    } else if (action === 'no_show') {
      appointment = await update({ status: 'no_show' }, ['booked', 'completed'])
      // A short, kind note in the language chosen in the settings, with
      // an invitation to book again.
      if (appointment) await tell('no_show', appointment)
    } else if (action === 'reopen') {
      appointment = await update({ status: 'booked', completed_at: null, cancelled_at: null }, ['completed', 'no_show'])
    } else if (action === 'notes') {
      appointment = await update(noteFields())
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    if (!appointment) {
      return NextResponse.json({ error: 'That change is not possible for this appointment' }, { status: 400 })
    }
    return NextResponse.json({
      appointment,
      message_error: messageError,
      next_appointment: nextAppointment,
      next_error: nextError,
    })
  } catch (err) {
    if (err instanceof TooManyFiles) {
      return NextResponse.json({ error: `An appointment can hold at most ${MAX_ATTACHMENTS} files` }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}

class TooManyFiles extends Error {}
