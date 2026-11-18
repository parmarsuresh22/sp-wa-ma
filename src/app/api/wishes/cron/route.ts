import { NextResponse } from 'next/server'

import { cronAuthState } from '@/lib/cron-auth'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runWishSchedule, type WishRunResult, type WishScheduleRow } from '@/lib/wishes/run'

// Sends are paced one a second, so a run can take a while.
export const maxDuration = 300

/** Leave headroom under `maxDuration` for the final bookkeeping writes. */
const RUN_BUDGET_MS = 240_000

/**
 * GET /api/wishes/cron
 *
 * Runs every enabled wish schedule whose `next_run_at` has passed.
 * Call it hourly (an n8n Schedule node, or any pinger) with
 * `x-cron-secret: <AUTOMATION_CRON_SECRET>`; Vercel Cron's
 * `Authorization: Bearer <CRON_SECRET>` is accepted too. A schedule
 * fires at the first call after its chosen time, so the calling
 * interval is the precision.
 */
export async function GET(request: Request) {
  const auth = cronAuthState(request)
  if (auth === 'unconfigured') {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (auth !== 'ok') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()
  const deadline = Date.now() + RUN_BUDGET_MS

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
  const runs: ({ channel_id: string } & WishRunResult)[] = []
  let pending = 0
  for (const schedule of schedules) {
    if (Date.now() > deadline) {
      pending += 1 // still due; the next call picks it up
      continue
    }
    try {
      const result = await runWishSchedule(admin, schedule, { now, deadline })
      runs.push({ channel_id: schedule.channel_id, ...result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[wishes-cron] schedule ${schedule.id} threw:`, message)
      runs.push({
        channel_id: schedule.channel_id,
        at: now.toISOString(),
        manual: false,
        due: 0,
        sent: 0,
        failed: 0,
        truncated: false,
        error: message,
      })
    }
  }

  return NextResponse.json({
    ran: runs.length,
    pending,
    sent: runs.reduce((n, r) => n + r.sent, 0),
    failed: runs.reduce((n, r) => n + r.failed, 0),
    runs,
  })
}
