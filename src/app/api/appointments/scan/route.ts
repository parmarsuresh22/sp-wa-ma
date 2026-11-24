import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { appointmentWhen, loadAppointmentSettings, type AppointmentRow } from '@/lib/appointments/service'
import { localParts } from '@/lib/appointments/time'
import { judgeAppointmentScan, parseAppointmentQr, type AppointmentScanResult } from '@/lib/appointments/qr'

/**
 * POST /api/appointments/scan   (agent+)
 *
 * Body: { code }   the text of the QR on an appointment card
 *
 * Marks the visit as completed when the card is for a confirmed
 * appointment of this account, today (on the business's own calendar).
 * Anything else changes nothing and says why:
 *
 *   ok                 completed now
 *   already_completed  scanned or closed before
 *   cancelled          the appointment was cancelled
 *   pending            still waiting for the business to confirm
 *   other_day          the card is for another day
 *   unknown            not an appointment card of this account
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent', 'appointments')
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null
    const id = parseAppointmentQr(typeof body?.code === 'string' ? body.code.slice(0, 200) : '')
    if (!id) return NextResponse.json({ result: 'unknown' satisfies AppointmentScanResult })

    const db = supabaseAdmin()
    const { data: found } = await db
      .from('appointments')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const appt = found as AppointmentRow | null
    if (!appt) return NextResponse.json({ result: 'unknown' satisfies AppointmentScanResult })

    const settings = await loadAppointmentSettings(db, accountId, appt.channel_id)
    const view = (row: AppointmentRow) => ({
      id: row.id,
      channel_id: row.channel_id,
      customer_name: row.customer_name,
      phone_key: row.phone_key,
      status: row.status,
      completed_at: row.completed_at,
      ...appointmentWhen(row, settings),
    })

    const now = new Date()
    let result = judgeAppointmentScan({
      status: appt.status,
      apptDay: localParts(new Date(appt.starts_at), settings.timezone).date,
      today: localParts(now, settings.timezone).date,
    })
    if (result !== 'ok') return NextResponse.json({ result, appointment: view(appt) })

    // One conditional write: two phones scanning the same card at once
    // cannot both complete it.
    const stamp = now.toISOString()
    const { data: done, error } = await db
      .from('appointments')
      .update({ status: 'completed', completed_at: stamp, updated_at: stamp })
      .eq('id', appt.id)
      .eq('account_id', accountId)
      .in('status', ['booked', 'no_show'])
      .select('*')
    if (error) throw new Error(error.message)
    const row = ((done ?? [])[0] as AppointmentRow | undefined) ?? null
    if (!row) {
      const { data: again } = await db.from('appointments').select('*').eq('id', appt.id).maybeSingle()
      const latest = (again as AppointmentRow | null) ?? appt
      result = latest.status === 'completed' ? 'already_completed' : latest.status === 'cancelled' ? 'cancelled' : 'unknown'
      return NextResponse.json({ result, appointment: view(latest) })
    }
    return NextResponse.json({ result, appointment: view(row) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
