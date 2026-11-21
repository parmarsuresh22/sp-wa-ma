import { NextResponse, after } from 'next/server'

import { cronAuthState, safeEqual } from '@/lib/cron-auth'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runWishSchedule, type WishScheduleRow } from '@/lib/wishes/run'
import { runAppointmentReminders } from '@/lib/appointments/service'

// Sends are paced one a second, so a run can take a while.
export const maxDuration = 300

/** Leave headroom under `maxDuration` for the final bookkeeping writes. */
const RUN_BUDGET_MS = 240_000

/**
 * The secret the database's own pinger sends (migration 069). It lives
 * in `internal_settings`, readable by the service role only, so the
 * scheduler works without any env var on the host.
 */
async function databaseSecretState(request: Request): Promise<'ok' | 'unauthorized' | 'unconfigured'> {
  const { data, error } = await supabaseAdmin()
    .from('internal_settings')
    .select('value')
    .eq('key', 'wish_cron_secret')
    .maybeSingle()
  const expected = error ? '' : ((data as { value?: string } | null)?.value ?? '')
  if (!expected) return 'unconfigured'
  const supplied = request.headers.get('x-cron-secret') ?? ''
  return supplied && safeEqual(supplied, expected) ? 'ok' : 'unauthorized'
}

/**
 * GET /api/wishes/cron
 *
 * Runs every enabled wish schedule whose `next_run_at` has passed. The
 * database calls it every 15 minutes (pg_cron + pg_net, migration 069)
 * with its own secret; an outside pinger may also call it with
 * `x-cron-secret: <AUTOMATION_CRON_SECRET>`, or Vercel Cron with
 * `Authorization: Bearer <CRON_SECRET>`. A schedule fires at the first
 * call after its chosen time, so the calling interval is the precision.
 *
 * The response returns at once with the number of schedules that were
 * due; the sending happens after it (`after`), because the caller does
 * not wait minutes for a paced run. Results land on each schedule's
 * `last_result`.
 */
export async function GET(request: Request) {
  let auth = cronAuthState(request)
  if (auth !== 'ok') {
    const fromDatabase = await databaseSecretState(request)
    if (fromDatabase === 'ok') auth = 'ok'
    else if (fromDatabase === 'unauthorized') auth = 'unauthorized'
  }
  if (auth === 'unconfigured') {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (auth !== 'ok') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Appointment reminders (migration 073) share this 15-minute call.
  after(async () => {
    try {
      const r = await runAppointmentReminders(admin, now)
      if (r.due > 0) console.log(`[appointments] reminders: due ${r.due}, sent ${r.sent}, failed ${r.failed}`)
    } catch (err) {
      console.error('[appointments] reminder run failed:', err instanceof Error ? err.message : err)
    }
  })

  const { data, error } = await admin
    .from('wish_schedules')
    .select('*')
    .eq('enabled', true)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .limit(200)
  if (error) {
    console.error('[wishes-cron] schedule scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const schedules = (data ?? []) as WishScheduleRow[]
  if (schedules.length > 0) {
    after(async () => {
      const deadline = Date.now() + RUN_BUDGET_MS
      for (const schedule of schedules) {
        if (Date.now() > deadline) break // still due; the next call picks it up
        try {
          const result = await runWishSchedule(admin, schedule, { now, deadline })
          console.log(
            `[wishes-cron] ${schedule.channel_id}: due ${result.due}, sent ${result.sent}, failed ${result.failed}` +
              (result.error ? `, error: ${result.error}` : ''),
          )
        } catch (err) {
          console.error(
            `[wishes-cron] schedule ${schedule.id} threw:`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    })
  }

  return NextResponse.json({ due: schedules.length })
}
