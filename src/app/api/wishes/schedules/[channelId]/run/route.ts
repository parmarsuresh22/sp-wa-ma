import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadChannel } from '@/lib/whatsapp/channels'
import {
  DEFAULT_WISH_SCHEDULE,
  runWishSchedule,
  type WishScheduleRow,
} from '@/lib/wishes/run'

// Sends are paced one a second, so a run can take a while.
export const maxDuration = 300

type Params = { params: Promise<{ channelId: string }> }

/**
 * POST /api/wishes/schedules/[channelId]/run
 *
 * "Run now" (admin): send this number's due wishes immediately — the
 * same check the scheduler makes, whether or not the schedule is
 * switched on. Wishes already sent this year are not repeated.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { channelId } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`wishes-run:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const channel = await loadChannel(supabase, accountId, channelId)
    if (!channel) {
      return NextResponse.json({ error: 'Number not found' }, { status: 404 })
    }

    // The run itself uses the service-role client, like the cron: it
    // opens conversations and writes messages on the account's behalf.
    const admin = supabaseAdmin()
    const load = () =>
      admin
        .from('wish_schedules')
        .select('*')
        .eq('account_id', accountId)
        .eq('channel_id', channel.id)
        .maybeSingle()

    let { data: schedule } = await load()
    if (!schedule) {
      // Never saved: create the (switched-off) default so the run has a
      // row to record its result on.
      const { error } = await admin.from('wish_schedules').upsert(
        {
          account_id: accountId,
          channel_id: channel.id,
          ...DEFAULT_WISH_SCHEDULE,
        },
        { onConflict: 'channel_id', ignoreDuplicates: true },
      )
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      ;({ data: schedule } = await load())
    }
    if (!schedule) {
      return NextResponse.json({ error: 'Schedule could not be loaded' }, { status: 500 })
    }

    const result = await runWishSchedule(admin, schedule as WishScheduleRow, {
      manual: true,
      deadline: Date.now() + 240_000,
    })
    const { data: updated } = await load()
    return NextResponse.json({ result, schedule: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
