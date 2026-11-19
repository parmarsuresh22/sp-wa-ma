import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  toPublicRequest,
  webNumberUsage,
  type WebNumberRequestRow,
} from '@/lib/whatsapp/web-number-requests'

/**
 * GET /api/whatsapp/web-number-requests
 *
 * The account's open WhatsApp Web number requests (pending, plus
 * rejected ones so the person learns the outcome) and how much of its
 * limit is used. Any member may read.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('web_number_requests')
      .select('*')
      .eq('account_id', accountId)
      .in('status', ['pending', 'rejected', 'approved'])
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const usage = await webNumberUsage(supabaseAdmin(), accountId)
    return NextResponse.json({
      requests: ((data ?? []) as WebNumberRequestRow[]).map(toPublicRequest),
      usage,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/web-number-requests   (admin+)
 *
 * Body: { label?: string }
 *
 * Ask the platform for a WhatsApp Web number. Nothing is created on the
 * bridge yet — the request waits for approval, after which the channel
 * appears in the account's number list with a QR code to scan.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const label =
      body && typeof body.label === 'string' ? body.label.trim().slice(0, 80) || null : null

    const db = supabaseAdmin()
    const usage = await webNumberUsage(db, accountId)
    if (usage.linked + usage.pending >= usage.limit) {
      return NextResponse.json(
        {
          error: `This account can have ${usage.limit} WhatsApp Web number(s), counting requests awaiting approval.`,
          code: 'web_number_limit',
          usage,
        },
        { status: 409 },
      )
    }

    const { data, error } = await db
      .from('web_number_requests')
      .insert({ account_id: accountId, requested_by: userId, label, status: 'pending' })
      .select('*')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Could not save the request' }, { status: 500 })
    }

    return NextResponse.json(
      { request: toPublicRequest(data as WebNumberRequestRow) },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
