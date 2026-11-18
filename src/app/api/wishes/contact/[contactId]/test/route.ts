import { NextResponse } from 'next/server'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadChannel } from '@/lib/whatsapp/channels'
import { sendWish, type ContactWishRow } from '@/lib/wishes/run'

type Params = { params: Promise<{ contactId: string }> }

/**
 * POST /api/wishes/contact/[contactId]/test
 *
 * Send the contact's saved wish to them right now, exactly as the
 * scheduler would — to check the wording and that the number can send.
 * It works whether or not the wish is switched on and does not count
 * as this year's wish.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { contactId } = await params
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: wish } = await supabase
      .from('contact_wishes')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (!wish) {
      return NextResponse.json({ error: 'Save the wish first' }, { status: 400 })
    }
    const row = wish as ContactWishRow

    const channel = row.channel_id ? await loadChannel(supabase, accountId, row.channel_id) : null
    if (!channel) {
      return NextResponse.json(
        { error: 'The number this wish was saved on no longer exists' },
        { status: 400 },
      )
    }
    if (channel.status !== 'connected') {
      return NextResponse.json({ error: 'Number is not connected' }, { status: 400 })
    }

    try {
      const auditUserId = await resolveAuditUserId(supabase, accountId)
      await sendWish(supabase, channel, row, auditUserId, userId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: message }, { status: 502 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
