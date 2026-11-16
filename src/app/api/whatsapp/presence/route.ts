import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resolveSendChannel } from '@/lib/whatsapp/channels'
import { senderForChannel } from '@/lib/whatsapp/providers'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'

/**
 * POST /api/whatsapp/presence
 *
 * Body: { conversation_id: string, action: 'seen' | 'typing' }
 *
 * What a human at the phone would do without thinking: `seen` marks
 * the customer's latest message read (blue ticks on their side) when an
 * agent opens the thread; `typing` shows "typing…" while the agent
 * composes. Both are best-effort and go through the thread's channel —
 * Meta needs the latest inbound wamid, a WhatsApp Web bridge needs the
 * chat id; the provider sender takes both.
 *
 * Never fails loudly: a provider error answers 200 `{ ok: false }` so
 * the inbox never surfaces a toast for cosmetics.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`presence:${userId}`, RATE_LIMITS.presence)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      conversation_id?: unknown
      action?: unknown
    } | null
    const conversationId =
      typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    const action = body?.action
    if (!conversationId || (action !== 'seen' && action !== 'typing')) {
      return NextResponse.json(
        { error: "conversation_id and action ('seen' | 'typing') are required" },
        { status: 400 },
      )
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, channel_id, contact:contacts(phone, wa_user_id)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact
    const target = resolveContactSendTarget(contact)
    if (!target) return NextResponse.json({ ok: false, reason: 'no_address' })

    const channel = await resolveSendChannel(supabase, accountId, {
      conversationChannelId:
        (conversation as { channel_id?: string | null }).channel_id ?? null,
    })
    if (!channel) return NextResponse.json({ ok: false, reason: 'no_channel' })

    // Latest customer message — Meta's read/typing calls are keyed on it.
    const { data: inbound } = await supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
    const inboundMessageId =
      (inbound as { message_id?: string }[] | null)?.[0]?.message_id ?? ''
    if (!inboundMessageId) return NextResponse.json({ ok: false, reason: 'no_inbound' })

    const sender = senderForChannel(channel)
    try {
      if (action === 'seen') {
        await sender.markRead({ to: target.target, inboundMessageId })
      } else {
        await sender.markReadAndTyping({ to: target.target, inboundMessageId })
      }
    } catch (err) {
      console.warn(
        `[whatsapp/presence] ${action} failed (ignored):`,
        err instanceof Error ? err.message : err,
      )
      return NextResponse.json({ ok: false, reason: 'provider_error' })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
