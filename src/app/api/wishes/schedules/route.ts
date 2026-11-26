import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { assertPlanFeature } from '@/lib/plans/server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listChannels, loadChannel } from '@/lib/whatsapp/channels'
import { DEFAULT_WISH_SCHEDULE, type WishScheduleRow } from '@/lib/wishes/run'
import {
  computeNextRun,
  isValidTimeZone,
  WISH_FREQUENCIES,
  type WishFrequency,
} from '@/lib/wishes/schedule'

/**
 * GET /api/wishes/schedules
 *
 * One entry per WhatsApp number on the account: its saved schedule (or
 * the defaults when none was saved yet) and how many wishes are
 * switched on for it. Any member may read.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const channels = await listChannels(supabase, accountId)

    const [{ data: rows, error }, { data: wishRows }] = await Promise.all([
      supabase.from('wish_schedules').select('*').eq('account_id', accountId),
      supabase
        .from('contact_wishes')
        .select('channel_id')
        .eq('account_id', accountId)
        .eq('enabled', true)
        .limit(10_000),
    ])
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const byChannel = new Map<string, WishScheduleRow>()
    for (const row of (rows ?? []) as WishScheduleRow[]) byChannel.set(row.channel_id, row)
    const wishCount = new Map<string, number>()
    for (const w of (wishRows ?? []) as { channel_id: string | null }[]) {
      if (w.channel_id) wishCount.set(w.channel_id, (wishCount.get(w.channel_id) ?? 0) + 1)
    }

    return NextResponse.json({
      schedules: channels.map((ch) => {
        const row = byChannel.get(ch.id)
        return {
          channel_id: ch.id,
          saved: !!row,
          enabled: row?.enabled ?? DEFAULT_WISH_SCHEDULE.enabled,
          frequency: row?.frequency ?? DEFAULT_WISH_SCHEDULE.frequency,
          timezone: row?.timezone ?? DEFAULT_WISH_SCHEDULE.timezone,
          time_of_day: row?.time_of_day ?? DEFAULT_WISH_SCHEDULE.time_of_day,
          day_of_week: row?.day_of_week ?? null,
          day_of_month: row?.day_of_month ?? null,
          month: row?.month ?? null,
          last_run_at: row?.last_run_at ?? null,
          next_run_at: row?.next_run_at ?? null,
          last_result: row?.last_result ?? null,
          wish_count: wishCount.get(ch.id) ?? 0,
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

/**
 * PUT /api/wishes/schedules
 *
 * Body: { channel_id, enabled, frequency, timezone, time_of_day,
 *         day_of_week?, day_of_month?, month? }
 *
 * Saves the schedule of one number (admin) and books its next run.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    await assertPlanFeature(supabase, accountId, 'wishes')
    const limit = checkRateLimit(`wishes-admin:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const channelId = typeof body.channel_id === 'string' ? body.channel_id : ''
    const channel = channelId ? await loadChannel(supabase, accountId, channelId) : null
    if (!channel) {
      return NextResponse.json({ error: 'Number not found' }, { status: 404 })
    }

    const frequency = body.frequency as WishFrequency
    if (!WISH_FREQUENCIES.includes(frequency)) {
      return NextResponse.json({ error: 'Unknown frequency' }, { status: 400 })
    }
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : ''
    if (!timezone || !isValidTimeZone(timezone)) {
      return NextResponse.json({ error: 'Unknown time zone' }, { status: 400 })
    }
    const time = typeof body.time_of_day === 'string' ? body.time_of_day.trim() : ''
    const m = /^(\d{1,2}):(\d{2})$/.exec(time)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      return NextResponse.json({ error: 'Time must be HH:mm' }, { status: 400 })
    }
    const timeOfDay = `${m[1].padStart(2, '0')}:${m[2]}`

    const dayOfWeek = frequency === 'weekly' ? intIn(body.day_of_week, 0, 6) : null
    const dayOfMonth =
      frequency === 'monthly' || frequency === 'yearly' ? intIn(body.day_of_month, 1, 31) : null
    const month = frequency === 'yearly' ? intIn(body.month, 1, 12) : null
    if (frequency === 'weekly' && dayOfWeek === null) {
      return NextResponse.json({ error: 'Pick a day of the week' }, { status: 400 })
    }
    if ((frequency === 'monthly' || frequency === 'yearly') && dayOfMonth === null) {
      return NextResponse.json({ error: 'Pick a day of the month' }, { status: 400 })
    }
    if (frequency === 'yearly' && month === null) {
      return NextResponse.json({ error: 'Pick a month' }, { status: 400 })
    }

    const enabled = body.enabled === true
    const input = {
      frequency,
      timezone,
      time_of_day: timeOfDay,
      day_of_week: dayOfWeek,
      day_of_month: dayOfMonth,
      month,
    }

    const { data, error } = await supabase
      .from('wish_schedules')
      .upsert(
        {
          account_id: accountId,
          channel_id: channel.id,
          enabled,
          ...input,
          next_run_at: enabled ? computeNextRun(input).toISOString() : null,
        },
        { onConflict: 'channel_id' },
      )
      .select('*')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ schedule: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
