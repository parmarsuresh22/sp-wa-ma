// ============================================================
// WAHA bridge webhook: signature check + payload translation.
//
// Pure functions so the route stays thin and this stays testable
// without a database. The route verifies the HMAC, parses the
// envelope, and hands each event to the shared inbound pipeline in
// `@/lib/whatsapp/inbound` after translating it into the Meta shape
// that pipeline already understands.
//
// Wire format verified against the WAHA docs (Nov 2026):
//   headers  X-Webhook-Hmac: <hex>, X-Webhook-Hmac-Algorithm: sha512
//   envelope { id, timestamp(ms), event, session, me?, payload, engine }
//   message  { id, timestamp(s), from, fromMe, to, body, hasMedia,
//              media?: { url, mimetype, filename }, replyTo?: { id } }
//   ack      { id, from, fromMe, ack: -1..4, ackName }
//   status   { status: STOPPED|STARTING|SCAN_QR_CODE|WORKING|FAILED }
// ============================================================

import crypto from 'node:crypto'
import type { WhatsAppMessage } from '@/lib/whatsapp/inbound'
import type { WaContactPayload } from '@/lib/whatsapp/wa-identity'
import { chatIdToPhone, isGroupChatId } from '@/lib/whatsapp/providers/waha'

/** Events a channel subscribes to when its session is created. */
export const BRIDGE_WEBHOOK_EVENTS = ['message', 'message.any', 'message.ack', 'session.status'] as const

export function verifyBridgeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  algorithm: string | null = 'sha512',
): boolean {
  if (!signatureHeader || !secret) return false
  const algo = (algorithm || 'sha512').toLowerCase()
  if (algo !== 'sha512' && algo !== 'sha256') return false
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest('hex')
  const a = Buffer.from(signatureHeader.trim().toLowerCase())
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface BridgeEnvelope {
  id?: string
  timestamp?: number
  event: string
  session: string
  me?: { id?: string; pushName?: string } | null
  payload: unknown
  engine?: string
}

export function parseBridgeEnvelope(raw: string): BridgeEnvelope | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.event !== 'string' || typeof b.session !== 'string') return null
  return {
    id: typeof b.id === 'string' ? b.id : undefined,
    timestamp: typeof b.timestamp === 'number' ? b.timestamp : undefined,
    event: b.event,
    session: b.session,
    me: (b.me as BridgeEnvelope['me']) ?? null,
    payload: b.payload,
    engine: typeof b.engine === 'string' ? b.engine : undefined,
  }
}

export interface BridgeMessagePayload {
  id: string
  timestamp?: number
  from?: string
  fromMe?: boolean
  to?: string
  body?: string
  hasMedia?: boolean
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null
  replyTo?: { id?: string } | null
  participant?: string | null
  source?: string
  /**
   * Set by `normalizeBridgeAddressing` when the message belongs to a
   * group: the group's chat id and who in the group wrote it.
   */
  group?: { id: string; senderId: string | null } | null
  _data?: {
    pushName?: string
    notifyName?: string
    Info?: {
      PushName?: string
      /** GOWS: the chat's id, possibly a `@lid`. */
      Chat?: string
      Sender?: string
      /** GOWS: the sender's phone JID when `Sender` is a `@lid`. */
      SenderAlt?: string
      /** GOWS: the recipient's phone JID when the chat is a `@lid`. */
      RecipientAlt?: string
    }
  } | null
}

export function isLidChatId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.endsWith('@lid')
}

/** Asks the bridge which phone a `@lid` belongs to; null if unknown. */
export type LidResolver = (lid: string) => Promise<string | null>

/**
 * WhatsApp now addresses many chats by a "linked id" (`<digits>@lid`)
 * instead of the phone number, and the GOWS engine passes that through:
 * `from` is the lid and `to` is null. The phone is still knowable — the
 * raw payload carries `SenderAlt` / `RecipientAlt`, and the bridge keeps
 * a lid→phone table — so rewrite `from` / `to` to `<digits>@c.us` before
 * translation. Anything that cannot be resolved is left as is and the
 * translators skip it.
 */
export async function normalizeBridgeAddressing(
  payload: BridgeMessagePayload,
  resolveLid: LidResolver,
): Promise<BridgeMessagePayload> {
  const info = payload._data?.Info
  const toCus = (jid: string | null | undefined): string | null =>
    chatIdToPhone(jid ?? null) ? `${chatIdToPhone(jid ?? null)!.slice(1)}@c.us` : null

  // A group message must stay a group message. On some engines `from`
  // is the member who wrote it (often as a linked id) and only the raw
  // payload names the group — rewriting `from` to that member's phone
  // would file every group message under the member's private chat.
  const groupId = [payload.from, payload.to, info?.Chat].find((id) => isGroupChatId(id)) ?? null
  if (groupId) {
    const senderId =
      [payload.participant, info?.SenderAlt, info?.Sender, payload.from].find(
        (id) => typeof id === 'string' && !!id && !isGroupChatId(id),
      ) ?? null
    return {
      ...payload,
      from: payload.fromMe ? payload.from : groupId,
      to: payload.fromMe ? groupId : payload.to,
      group: { id: groupId, senderId },
    }
  }

  const out: BridgeMessagePayload = { ...payload }
  const chatLid = isLidChatId(payload.from)
    ? payload.from!
    : isLidChatId(info?.Chat)
      ? info!.Chat!
      : null

  if (payload.fromMe) {
    // Our own message: the customer is the recipient. `to` is null on
    // GOWS for lid chats; RecipientAlt or the chat's lid names them.
    if (!toCus(out.to)) {
      const alt = toCus(info?.RecipientAlt)
      if (alt) out.to = alt
      else if (chatLid) {
        const resolved = await resolveLid(chatLid).catch(() => null)
        if (resolved) out.to = resolved
      }
    }
    return out
  }

  // Customer message: `from` must become the phone chat id.
  if (!toCus(out.from)) {
    const alt = toCus(info?.SenderAlt)
    if (alt) out.from = alt
    else if (chatLid) {
      const resolved = await resolveLid(chatLid).catch(() => null)
      if (resolved) out.from = resolved
    }
  }
  return out
}

/** Pick the message payload out of the envelope, or null if malformed. */
export function bridgeMessagePayload(p: unknown): BridgeMessagePayload | null {
  if (!p || typeof p !== 'object') return null
  const m = p as BridgeMessagePayload
  if (typeof m.id !== 'string' || !m.id) return null
  return m
}

/** Seconds-since-epoch as the string Meta uses. */
function toMetaTimestamp(ts: number | undefined, fallbackMs: number | undefined): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // WAHA sends message timestamps in seconds; guard against ms anyway.
    return String(ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts))
  }
  return String(Math.floor((fallbackMs ?? Date.now()) / 1000))
}

function mediaKindFromMime(mime: string | null | undefined): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  const m = (mime || '').toLowerCase()
  if (m === 'image/webp') return 'sticker'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

export interface TranslatedInbound {
  message: WhatsAppMessage
  contact: WaContactPayload
  /** `+<digits>` of the customer; '' for a group. */
  phone: string
  /** True when this is a message in a WhatsApp group. */
  isGroup?: boolean
}

/** A group chat id from whichever field carries it, or null. */
export function groupIdOf(payload: BridgeMessagePayload): string | null {
  if (payload.group?.id) return payload.group.id
  return [payload.from, payload.to, payload._data?.Info?.Chat].find((id) => isGroupChatId(id)) ?? null
}

/**
 * Translate a WAHA `message` (customer → business) into the Meta
 * webhook shape. Returns null for anything the pipeline should skip:
 * channels/newsletters, status broadcasts, our own sends (`fromMe`),
 * and payloads with no usable sender.
 *
 * A message in a WhatsApp group becomes a message in ONE chat for that
 * group (the group is the "contact", addressed by its chat id), with
 * the member's name in front of the text. `isGroup` tells the pipeline
 * that no flow, automation or AI may answer it.
 *
 * Media: the "media id" handed to the pipeline is the bridge's download
 * URL — the WAHA media resolver in the route fetches it with the API
 * key and mirrors it into storage.
 */
export function translateBridgeInbound(
  env: BridgeEnvelope,
  payload: BridgeMessagePayload,
  opts: { groupName?: string | null } = {},
): TranslatedInbound | null {
  if (payload.fromMe) return null
  const groupId = groupIdOf(payload)
  const chatId = groupId ?? payload.from ?? ''
  if (!chatId) return null
  if (chatId.endsWith('@newsletter') || chatId === 'status@broadcast') return null
  const phone = groupId ? '' : (chatIdToPhone(chatId) ?? '')
  if (!groupId && !phone) return null
  const digits = phone.slice(1)

  const pushName =
    payload._data?.pushName ||
    payload._data?.notifyName ||
    payload._data?.Info?.PushName ||
    undefined

  const timestamp = toMetaTimestamp(payload.timestamp, env.timestamp)
  const base: WhatsAppMessage = groupId
    ? {
        id: payload.id,
        // No phone: the group's chat id is the identity (see wa-identity).
        from_user_id: groupId,
        timestamp,
        type: 'text',
        ...(payload.replyTo?.id ? { context: { id: payload.replyTo.id } } : {}),
      }
    : {
        id: payload.id,
        from: digits,
        timestamp,
        type: 'text',
        ...(payload.replyTo?.id ? { context: { id: payload.replyTo.id } } : {}),
      }

  const contact: WaContactPayload = groupId
    ? { user_id: groupId, profile: { name: opts.groupName?.trim() || 'WhatsApp group' } }
    : { wa_id: digits, profile: { name: pushName } }

  // In a group, say who wrote it.
  const memberPhone = groupId ? chatIdToPhone(payload.group?.senderId ?? null) : null
  const member = groupId ? pushName || memberPhone || 'Member' : ''
  const withMember = (text: string | undefined) =>
    groupId ? (text ? `${member}: ${text}` : `${member}:`) : text
  const isGroup = !!groupId

  const mediaUrl = payload.media?.url ?? null
  if (payload.hasMedia && mediaUrl) {
    const mime = payload.media?.mimetype ?? null
    const kind = mediaKindFromMime(mime)
    const caption = withMember(payload.body?.trim() || undefined)
    const ref = { id: mediaUrl, mime_type: mime || 'application/octet-stream' }
    switch (kind) {
      case 'image':
        return { message: { ...base, type: 'image', image: { ...ref, caption } }, contact, phone, isGroup }
      case 'video':
        return { message: { ...base, type: 'video', video: { ...ref, caption } }, contact, phone, isGroup }
      case 'audio':
        return { message: { ...base, type: 'audio', audio: ref }, contact, phone, isGroup }
      case 'sticker':
        return { message: { ...base, type: 'sticker', sticker: ref }, contact, phone, isGroup }
      default:
        return {
          message: {
            ...base,
            type: 'document',
            document: { ...ref, filename: payload.media?.filename ?? undefined, caption },
          },
          contact,
          phone,
          isGroup,
        }
    }
  }

  const text = payload.body ?? ''
  if (!text.trim() && payload.hasMedia) {
    // Media the bridge did not download (WAHA_EVENTS_DOWNLOAD_MEDIA off).
    return {
      message: { ...base, type: 'text', text: { body: '[attachment not downloaded by bridge]' } },
      contact,
      phone,
      isGroup,
    }
  }
  if (!text) return null
  return { message: { ...base, type: 'text', text: { body: withMember(text) ?? text } }, contact, phone, isGroup }
}

export interface TranslatedEcho {
  /** WAHA message id — stored as `messages.message_id`. */
  id: string
  /** `+<digits>` of the customer the owner wrote to. */
  phone: string
  text: string | null
  timestampIso: string
  hasMedia: boolean
  mediaUrl: string | null
  mimeType: string | null
  filename: string | null
}

/**
 * A `fromMe` message is something the business sent — either through
 * wacrm (already persisted, deduped by message id) or by a human typing
 * on the phone itself. Translating it lets the inbox show the latter.
 */
export function translateBridgeEcho(
  env: BridgeEnvelope,
  payload: BridgeMessagePayload,
): TranslatedEcho | null {
  if (!payload.fromMe) return null
  const chatId = payload.to ?? ''
  if (!chatId || isGroupChatId(chatId)) return null
  const phone = chatIdToPhone(chatId)
  if (!phone) return null
  const seconds = Number.parseInt(toMetaTimestamp(payload.timestamp, env.timestamp), 10)
  return {
    id: payload.id,
    phone,
    text: payload.body?.trim() ? payload.body : null,
    timestampIso: new Date(seconds * 1000).toISOString(),
    hasMedia: !!payload.hasMedia,
    mediaUrl: payload.media?.url ?? null,
    mimeType: payload.media?.mimetype ?? null,
    filename: payload.media?.filename ?? null,
  }
}

export interface BridgeAckPayload {
  id?: string
  ack?: number
  ackName?: string
  fromMe?: boolean
}

/** WAHA ack → Meta status word, or null for states we do not track. */
export function ackToStatus(payload: unknown): { id: string; status: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as BridgeAckPayload
  if (typeof p.id !== 'string' || !p.id) return null
  const name = (p.ackName || '').toUpperCase()
  const code = typeof p.ack === 'number' ? p.ack : null
  if (name === 'ERROR' || code === -1) return { id: p.id, status: 'failed' }
  if (name === 'SERVER' || code === 1) return { id: p.id, status: 'sent' }
  if (name === 'DEVICE' || code === 2) return { id: p.id, status: 'delivered' }
  if (name === 'READ' || name === 'PLAYED' || code === 3 || code === 4) {
    return { id: p.id, status: 'read' }
  }
  return null
}

export type BridgeSessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'PASSKEY_REQUIRED'
  | 'PASSKEY_CONFIRMATION_REQUIRED'
  | 'WORKING'
  | 'FAILED'

export function sessionStatusFromPayload(payload: unknown): BridgeSessionStatus | null {
  if (!payload || typeof payload !== 'object') return null
  const s = (payload as { status?: unknown }).status
  if (typeof s !== 'string') return null
  const up = s.toUpperCase()
  const known: BridgeSessionStatus[] = [
    'STOPPED',
    'STARTING',
    'SCAN_QR_CODE',
    'PASSKEY_REQUIRED',
    'PASSKEY_CONFIRMATION_REQUIRED',
    'WORKING',
    'FAILED',
  ]
  return (known as string[]).includes(up) ? (up as BridgeSessionStatus) : null
}

/** The `+<digits>` the session is logged in as, from the envelope's `me`. */
export function bridgeOwnPhone(env: BridgeEnvelope): string | null {
  return chatIdToPhone(env.me?.id ?? null)
}

/**
 * WAHA message ids are `<fromMe>_<chat>_<id>`. On a linked-id chat the
 * bridge acks with the `@lid` chat while the id it returned for our own
 * send carried the `@c.us` chat, so a read receipt never matched the
 * stored row. Parse the id so the route can try both spellings.
 */
export function parseBridgeMessageId(
  id: string,
): { fromMe: boolean; chat: string; rest: string } | null {
  const m = /^(true|false)_([^_]+)_(.+)$/.exec(id)
  if (!m) return null
  return { fromMe: m[1] === 'true', chat: m[2], rest: m[3] }
}

/** The same message id addressed to another chat id. */
export function bridgeMessageIdWithChat(id: string, chat: string): string | null {
  const p = parseBridgeMessageId(id)
  if (!p) return null
  return `${p.fromMe ? 'true' : 'false'}_${chat}_${p.rest}`
}
