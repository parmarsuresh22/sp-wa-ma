import { NextResponse, after } from 'next/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import {
  ackToStatus,
  bridgeMessagePayload,
  bridgeOwnPhone,
  normalizeBridgeAddressing,
  parseBridgeEnvelope,
  sessionStatusFromPayload,
  translateBridgeEcho,
  translateBridgeInbound,
  verifyBridgeSignature,
  type BridgeEnvelope,
} from '@/lib/whatsapp/bridge-webhook'
import {
  findOrCreateConversation,
  handleStatusUpdate,
  processInboundMessage,
  supabaseAdmin,
  type InboundMediaResolver,
} from '@/lib/whatsapp/inbound'
import { createWahaClient } from '@/lib/whatsapp/providers/waha'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { findExistingContact } from '@/lib/contacts/dedupe'
import type { ChannelRow } from '@/lib/whatsapp/channels'

// Same headroom as the Meta webhook: media mirroring + engine fan-out
// run inside `after()`.
export const maxDuration = 60

/**
 * POST /api/whatsapp/bridge/webhook/[channelId]
 *
 * Receiver for one WAHA (WhatsApp Web) channel. The bridge signs every
 * body with the per-channel HMAC key wacrm generated when the session
 * was created (`X-Webhook-Hmac`, sha512 hex). An unknown channel, a
 * missing key or a bad signature is refused with 401 so the bridge's
 * retry policy surfaces the misconfiguration instead of silently
 * dropping events.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const { channelId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 404 })
  }

  const rawBody = await readCappedBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const { data: channel, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('id', channelId)
    .eq('provider', 'waha')
    .maybeSingle()
  if (error || !channel) {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 404 })
  }
  const row = channel as ChannelRow

  let secret = ''
  try {
    secret = row.bridge_webhook_secret ? decrypt(row.bridge_webhook_secret) : ''
  } catch {
    secret = ''
  }
  if (
    !verifyBridgeSignature(
      rawBody,
      request.headers.get('x-webhook-hmac'),
      secret,
      request.headers.get('x-webhook-hmac-algorithm'),
    )
  ) {
    console.warn('[bridge-webhook] rejected request with invalid signature for channel', channelId)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const env = parseBridgeEnvelope(rawBody)
  if (!env) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (row.bridge_session && env.session !== row.bridge_session) {
    // Signed with our key but for another session on the same bridge —
    // a misconfigured webhook list. Acknowledge, do nothing.
    console.warn(
      `[bridge-webhook] event for session "${env.session}" arrived on channel ${channelId} (session "${row.bridge_session}"); ignored`,
    )
    return NextResponse.json({ status: 'ignored' })
  }

  after(async () => {
    try {
      await processBridgeEvent(row, env)
    } catch (err) {
      console.error('[bridge-webhook] processing failed:', err)
    }
  })

  return NextResponse.json({ status: 'received' })
}

async function processBridgeEvent(channel: ChannelRow, env: BridgeEnvelope) {
  switch (env.event) {
    case 'message':
    case 'message.any': {
      const raw = bridgeMessagePayload(env.payload)
      if (!raw) return
      // Linked-id chats (`@lid`) → phone chat ids, via the raw payload
      // or the bridge's lookup table.
      const payload = await normalizeBridgeAddressing(raw, lidResolver(channel))
      if (payload.fromMe) {
        // `message` never carries fromMe on most engines; `message.any`
        // does. Handle echoes once, from whichever event brings them.
        if (env.event === 'message.any') await recordEcho(channel, env, payload)
        return
      }
      // Customer messages arrive on both events — process on `message`
      // only; the upsert's unique index makes a stray duplicate a no-op.
      if (env.event !== 'message') return
      const translated = translateBridgeInbound(env, payload)
      if (!translated) return
      await processInboundMessage(translated.message, translated.contact, {
        accountId: channel.account_id,
        configOwnerUserId: channel.user_id,
        channelId: channel.id,
        resolveMedia: bridgeMediaResolver(channel, translated.message.timestamp),
        matchTypedInteractiveReplies: true,
      })
      return
    }
    case 'message.ack': {
      const ack = ackToStatus(env.payload)
      if (!ack) return
      const ts = typeof env.timestamp === 'number' ? Math.floor(env.timestamp / 1000) : Math.floor(Date.now() / 1000)
      await handleStatusUpdate(
        { id: ack.id, status: ack.status, timestamp: String(ts), recipient_id: '' },
        channel.account_id,
      )
      return
    }
    case 'session.status': {
      const status = sessionStatusFromPayload(env.payload)
      if (!status) return
      const ownPhone = bridgeOwnPhone(env)
      const patch: Record<string, unknown> = {
        bridge_status: status,
        status: status === 'WORKING' ? 'connected' : 'disconnected',
        updated_at: new Date().toISOString(),
      }
      if (status === 'WORKING') patch.connected_at = new Date().toISOString()
      if (ownPhone) patch.display_phone = ownPhone
      const { error } = await supabaseAdmin()
        .from('whatsapp_config')
        .update(patch)
        .eq('id', channel.id)
      if (error) console.error('[bridge-webhook] session status update failed:', error.message)
      return
    }
    default:
      return
  }
}

/** lid → `<digits>@c.us` through the bridge's lookup endpoint. */
function lidResolver(channel: ChannelRow) {
  return async (lid: string): Promise<string | null> => {
    if (!channel.bridge_base_url || !channel.bridge_session) return null
    let apiKey: string
    try {
      apiKey = decrypt(channel.access_token)
    } catch {
      return null
    }
    const client = createWahaClient({ baseUrl: channel.bridge_base_url, apiKey })
    return client.resolveLid(channel.bridge_session, lid)
  }
}

/**
 * Media on a bridge: `mediaId` is the bridge's download URL. Fetch it
 * with the API key and mirror into `chat-media`; without a mirror the
 * URL is useless to the browser (it needs the key), so return null and
 * let the message land as a text placeholder.
 */
function bridgeMediaResolver(channel: ChannelRow, messageTimestamp: string): InboundMediaResolver {
  return async (mediaUrl, fileName, mimeType) => {
    if (!channel.bridge_base_url) return null
    let apiKey: string
    try {
      apiKey = decrypt(channel.access_token)
    } catch {
      return null
    }
    const client = createWahaClient({ baseUrl: channel.bridge_base_url, apiKey })
    // WAHA stores files as /api/files/<random>.<ext>; that random name is
    // a fine, stable object id for the mirror path.
    const mediaId =
      mediaUrl.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '') ||
      `bridge-${Date.now()}`
    try {
      const mirrored = await mirrorInboundMedia({
        storage: supabaseAdmin().storage,
        accountId: channel.account_id,
        mediaId,
        downloadUrl: mediaUrl,
        accessToken: apiKey,
        mimeType,
        fileName,
        messageTimestamp,
        download: async () => {
          const r = await client.downloadMedia(mediaUrl)
          return {
            buffer: r.buffer,
            contentType: r.contentType ?? mimeType ?? 'application/octet-stream',
          }
        },
      })
      return mirrored
    } catch (err) {
      console.error('[bridge-webhook] media mirror failed:', err instanceof Error ? err.message : err)
      return null
    }
  }
}

/**
 * A message the business sent from the phone itself (not via wacrm).
 * Stored as an agent message with no sender so the inbox shows the
 * thread as the customer sees it. Sends made through wacrm already have
 * a row with this id; the unique index turns them into a no-op.
 */
async function recordEcho(
  channel: ChannelRow,
  env: BridgeEnvelope,
  payload: NonNullable<ReturnType<typeof bridgeMessagePayload>>,
) {
  const echo = translateBridgeEcho(env, payload)
  if (!echo) return
  const db = supabaseAdmin()

  const contact = await findExistingContact(db, channel.account_id, echo.phone)
  let contactId = contact?.id as string | undefined
  if (!contactId) {
    const { data: created, error } = await db
      .from('contacts')
      .insert({
        account_id: channel.account_id,
        user_id: channel.user_id,
        phone: echo.phone,
        name: echo.phone,
      })
      .select('id')
      .single()
    if (error || !created) {
      const raced = await findExistingContact(db, channel.account_id, echo.phone)
      if (!raced) return
      contactId = raced.id as string
    } else {
      contactId = created.id as string
    }
  }

  const conv = await findOrCreateConversation(
    channel.account_id,
    channel.user_id,
    contactId,
    channel.id,
  )
  if (!conv) return

  let mediaUrl: string | null = null
  if (echo.hasMedia && echo.mediaUrl) {
    mediaUrl = await bridgeMediaResolver(channel, String(Math.floor(Date.parse(echo.timestampIso) / 1000)))(
      echo.mediaUrl,
      echo.filename,
      echo.mimeType,
    )
  }
  const kind = echo.hasMedia
    ? (echo.mimeType || '').startsWith('image/')
      ? 'image'
      : (echo.mimeType || '').startsWith('video/')
        ? 'video'
        : (echo.mimeType || '').startsWith('audio/')
          ? 'audio'
          : 'document'
    : 'text'

  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conv.conversation.id,
        sender_type: 'agent',
        sender_id: null,
        content_type: kind,
        content_text: echo.text,
        media_url: mediaUrl,
        media_type: echo.mimeType,
        message_id: echo.id,
        status: 'sent',
        created_at: echo.timestampIso,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[bridge-webhook] echo insert failed:', error.message)
    return
  }
  if (!inserted || inserted.length === 0) return // our own send, already stored

  await db
    .from('conversations')
    .update({
      last_message_text: echo.text || `[${kind}]`,
      last_message_at: echo.timestampIso,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conv.conversation.id)
}
