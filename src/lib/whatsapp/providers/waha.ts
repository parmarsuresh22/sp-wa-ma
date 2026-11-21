// ============================================================
// WAHA (WhatsApp HTTP API) bridge client + sender.
//
// WAHA (https://waha.devlike.pro) runs a WhatsApp Web session in a
// container you host and exposes it over HTTP. One container serves
// many sessions; wacrm stores, per channel, the container's base URL,
// the session name, the API key (encrypted in `access_token`) and the
// HMAC key the container signs webhook bodies with.
//
// Wire format (verified against the WAHA docs, Nov 2026):
//   auth      X-Api-Key header
//   chat id   <digits>@c.us for a person (no leading +), @g.us groups
//   sends     POST /api/sendText | sendImage | sendFile | sendVideo |
//             sendVoice | reaction | sendSeen | startTyping
//   sessions  POST /api/sessions, GET/DELETE /api/sessions/{name},
//             POST /api/sessions/{name}/{start|stop|logout|restart},
//             GET /api/{name}/auth/qr?format=raw → { value }
//   webhooks  X-Webhook-Hmac (hex), X-Webhook-Hmac-Algorithm: sha512
//
// Message ids come back either as a string ("true_123@c.us_ABC") or,
// on the WEBJS engine, as an object with `_serialized`; `extractId`
// accepts both.
// ============================================================

import type { ChannelRow } from '@/lib/whatsapp/channels'
import {
  interactiveToText,
  UnsupportedOnChannelError,
  type ChannelSender,
  type SendInteractiveArgs,
  type SendMediaArgs,
  type SendReactionArgs,
  type SendResult,
  type SendTextArgs,
  type TypingArgs,
} from './types'

const REQUEST_TIMEOUT_MS = 30_000

export class WahaError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WahaError'
    this.status = status
  }
}

export interface WahaClientConfig {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

/** Normalise a user-typed base URL: https, no trailing slash. */
export function normalizeBridgeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

/** `+91 98765 43210` → `919876543210@c.us`. */
export function toWahaChatId(phoneOrChatId: string): string {
  if (phoneOrChatId.includes('@')) return phoneOrChatId
  const digits = phoneOrChatId.replace(/\D/g, '')
  return `${digits}@c.us`
}

/** `919876543210@c.us` → `+919876543210`; null for groups/other ids. */
export function chatIdToPhone(chatId: string | null | undefined): string | null {
  if (!chatId) return null
  const m = /^(\d{5,20})@(c\.us|s\.whatsapp\.net)$/.exec(chatId)
  return m ? `+${m[1]}` : null
}

export function isGroupChatId(chatId: string | null | undefined): boolean {
  return typeof chatId === 'string' && chatId.endsWith('@g.us')
}

/** WAHA returns `id` as a string or `{ _serialized }`; accept both. */
export function extractWahaMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const id = (body as { id?: unknown }).id
  if (typeof id === 'string' && id) return id
  if (id && typeof id === 'object') {
    const ser = (id as { _serialized?: unknown })._serialized
    if (typeof ser === 'string' && ser) return ser
    const inner = (id as { id?: unknown }).id
    if (typeof inner === 'string' && inner) return inner
  }
  return null
}

export interface WahaSessionInfo {
  name: string
  status: string
  me?: { id?: string; pushName?: string } | null
  engine?: { engine?: string } | null
  config?: { webhooks?: { url?: string; events?: string[] }[] | null } | null
}

export interface WahaWebhookConfig {
  url: string
  events: string[]
  hmacKey: string
}

export function createWahaClient(cfg: WahaClientConfig) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const fetchImpl = cfg.fetchImpl ?? fetch

  async function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { accept?: string } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'X-Api-Key': cfg.apiKey,
          Accept: opts.accept ?? 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch (err) {
      throw new WahaError(
        `Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
        502,
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : typeof parsed === 'string' && parsed
            ? parsed.slice(0, 200)
            : `HTTP ${res.status}`
      throw new WahaError(`Bridge error ${res.status}: ${msg}`, res.status)
    }
    return parsed as T
  }

  return {
    // ---- sessions -------------------------------------------
    async getSession(name: string): Promise<WahaSessionInfo> {
      return call<WahaSessionInfo>('GET', `/api/sessions/${encodeURIComponent(name)}`)
    },
    async listSessions(): Promise<WahaSessionInfo[]> {
      return call<WahaSessionInfo[]>('GET', '/api/sessions?all=true')
    },
    async createSession(name: string, webhook: WahaWebhookConfig): Promise<WahaSessionInfo> {
      return call<WahaSessionInfo>('POST', '/api/sessions', {
        name,
        start: true,
        config: {
          webhooks: [
            {
              url: webhook.url,
              events: webhook.events,
              hmac: { key: webhook.hmacKey },
              retries: { policy: 'linear', delaySeconds: 2, attempts: 5 },
            },
          ],
        },
      })
    },
    async updateSessionWebhook(name: string, webhook: WahaWebhookConfig): Promise<unknown> {
      return call('PUT', `/api/sessions/${encodeURIComponent(name)}`, {
        config: {
          webhooks: [
            {
              url: webhook.url,
              events: webhook.events,
              hmac: { key: webhook.hmacKey },
              retries: { policy: 'linear', delaySeconds: 2, attempts: 5 },
            },
          ],
        },
      })
    },
    async startSession(name: string): Promise<unknown> {
      return call('POST', `/api/sessions/${encodeURIComponent(name)}/start`)
    },
    async stopSession(name: string): Promise<unknown> {
      return call('POST', `/api/sessions/${encodeURIComponent(name)}/stop`)
    },
    async restartSession(name: string): Promise<unknown> {
      return call('POST', `/api/sessions/${encodeURIComponent(name)}/restart`)
    },
    async logoutSession(name: string): Promise<unknown> {
      return call('POST', `/api/sessions/${encodeURIComponent(name)}/logout`)
    },
    async deleteSession(name: string): Promise<unknown> {
      return call('DELETE', `/api/sessions/${encodeURIComponent(name)}`)
    },
    /** Raw QR payload to render client-side; null while not in SCAN_QR_CODE. */
    async getQrValue(name: string): Promise<string | null> {
      try {
        const r = await call<{ value?: string }>(
          'GET',
          `/api/${encodeURIComponent(name)}/auth/qr?format=raw`,
        )
        return typeof r?.value === 'string' && r.value ? r.value : null
      } catch (err) {
        if (err instanceof WahaError && (err.status === 422 || err.status === 404)) return null
        throw err
      }
    },
    /** QR as a data: URL (PNG) to drop into an <img>; null while not pairing. */
    async getQrImage(name: string): Promise<string | null> {
      try {
        const r = await call<{ mimetype?: string; data?: string }>(
          'GET',
          `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
          undefined,
          { accept: 'application/json' },
        )
        if (r && typeof r.data === 'string' && r.data) {
          return `data:${r.mimetype || 'image/png'};base64,${r.data}`
        }
        return null
      } catch (err) {
        if (err instanceof WahaError && (err.status === 422 || err.status === 404)) return null
        throw err
      }
    },
    /** Pairing code for "link with phone number" (no QR). */
    async requestPairingCode(name: string, phoneNumber: string): Promise<string | null> {
      const r = await call<{ code?: string }>(
        'POST',
        `/api/${encodeURIComponent(name)}/auth/request-code`,
        { phoneNumber: phoneNumber.replace(/\D/g, '') },
      )
      return typeof r?.code === 'string' ? r.code : null
    },
    // ---- messages -------------------------------------------
    async sendText(session: string, chatId: string, text: string, replyTo?: string) {
      const r = await call('POST', '/api/sendText', {
        session,
        chatId,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      })
      return extractWahaMessageId(r)
    },
    async sendFile(
      session: string,
      chatId: string,
      kind: 'image' | 'video' | 'document' | 'audio',
      file: { url: string; mimetype?: string; filename?: string },
      caption?: string,
      replyTo?: string,
    ) {
      const path =
        kind === 'image'
          ? '/api/sendImage'
          : kind === 'video'
            ? '/api/sendVideo'
            : kind === 'audio'
              ? '/api/sendVoice'
              : '/api/sendFile'
      const body: Record<string, unknown> = {
        session,
        chatId,
        file: {
          url: file.url,
          ...(file.mimetype ? { mimetype: file.mimetype } : {}),
          ...(file.filename ? { filename: file.filename } : {}),
        },
        ...(replyTo ? { reply_to: replyTo } : {}),
      }
      if (kind !== 'audio' && caption) body.caption = caption
      if (kind === 'audio' || kind === 'video') body.convert = true
      const r = await call('POST', path, body)
      return extractWahaMessageId(r)
    },
    async sendReaction(session: string, messageId: string, reaction: string) {
      await call('PUT', '/api/reaction', { session, messageId, reaction })
    },
    async sendSeen(session: string, chatId: string, messageId?: string) {
      await call('POST', '/api/sendSeen', {
        session,
        chatId,
        ...(messageId ? { messageIds: [messageId] } : {}),
      })
    },
    // ---- status (stories) -----------------------------------
    // POST /api/{session}/status/text | /status/image. Seen by people
    // who have the number saved. `contacts: null` = the default
    // audience of the account.
    async sendStatusText(session: string, text: string) {
      await call('POST', `/api/${encodeURIComponent(session)}/status/text`, {
        text,
        backgroundColor: '#128C7E',
        font: 0,
        contacts: null,
      })
    },
    async sendStatusImage(
      session: string,
      file: { url: string; mimetype?: string; filename?: string },
      caption?: string,
    ) {
      await call('POST', `/api/${encodeURIComponent(session)}/status/image`, {
        file: {
          url: file.url,
          mimetype: file.mimetype || 'image/jpeg',
          ...(file.filename ? { filename: file.filename } : {}),
        },
        ...(caption ? { caption } : {}),
        contacts: null,
      })
    },
    async startTyping(session: string, chatId: string) {
      await call('POST', '/api/startTyping', { session, chatId })
    },
    /**
     * Resolve a WhatsApp "linked id" (`<digits>@lid`) to the phone chat
     * id (`<digits>@c.us`). Null when the bridge does not know it.
     */
    async resolveLid(session: string, lid: string): Promise<string | null> {
      try {
        const r = await call<{ pn?: string | null }>(
          'GET',
          `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
        )
        return typeof r?.pn === 'string' && r.pn ? r.pn : null
      } catch (err) {
        if (err instanceof WahaError && err.status === 404) return null
        throw err
      }
    },
    /**
     * The address of a chat's WhatsApp profile photo, or null when there
     * is none (or it is hidden by the person's privacy settings).
     */
    async profilePictureUrl(session: string, chatId: string): Promise<string | null> {
      try {
        const r = await call<Record<string, unknown>>(
          'GET',
          `/api/contacts/profile-picture?contactId=${encodeURIComponent(chatId)}&session=${encodeURIComponent(session)}`,
        )
        for (const key of ['profilePictureURL', 'profilePictureUrl', 'url']) {
          const v = r?.[key]
          if (typeof v === 'string' && /^https:\/\//.test(v)) return v
        }
        return null
      } catch {
        return null
      }
    },
    /**
     * A group's name (its "subject"), or null when the bridge will not
     * say. Engines differ in the field they use, so try the known ones.
     */
    async groupName(session: string, groupId: string): Promise<string | null> {
      try {
        const r = await call<Record<string, unknown>>(
          'GET',
          `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}`,
        )
        const info = (r?.groupMetadata ?? r) as Record<string, unknown> | null
        for (const key of ['subject', 'Subject', 'name', 'Name']) {
          const v = info?.[key]
          if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
        }
        return null
      } catch {
        return null
      }
    },
    /** Download a media file the bridge stored (payload.media.url). */
    async downloadMedia(url: string): Promise<{ buffer: Buffer; contentType: string | null }> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetchImpl(url, {
          headers: { 'X-Api-Key': cfg.apiKey },
          signal: controller.signal,
        })
        if (!res.ok) throw new WahaError(`Media download failed: HTTP ${res.status}`, res.status)
        const buffer = Buffer.from(await res.arrayBuffer())
        return { buffer, contentType: res.headers.get('content-type') }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export type WahaClient = ReturnType<typeof createWahaClient>

/** Guess a MIME type from a public URL's extension (WAHA wants one). */
export function guessMimeFromUrl(url: string, kind: SendMediaArgs['kind']): string {
  const ext = (() => {
    try {
      const p = new URL(url).pathname.toLowerCase()
      const i = p.lastIndexOf('.')
      return i >= 0 ? p.slice(i + 1) : ''
    } catch {
      return ''
    }
  })()
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg; codecs=opus',
    opus: 'audio/ogg; codecs=opus',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    zip: 'application/zip',
  }
  if (table[ext]) return table[ext]
  return kind === 'image'
    ? 'image/jpeg'
    : kind === 'video'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/ogg; codecs=opus'
        : 'application/octet-stream'
}

export interface WahaSenderConfig {
  channelId: string
  baseUrl: string
  session: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export function createWahaSender(cfg: WahaSenderConfig): ChannelSender {
  const client = createWahaClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    fetchImpl: cfg.fetchImpl,
  })
  const session = cfg.session

  const requireId = (id: string | null): SendResult => {
    if (!id) throw new WahaError('Bridge accepted the message but returned no id', 502)
    return { messageId: id }
  }

  return {
    provider: 'waha',
    channelId: cfg.channelId,
    capabilities: {
      templates: false,
      interactive: false,
      reactions: true,
      typing: true,
      variantRetry: false,
    },
    async sendText(args: SendTextArgs): Promise<SendResult> {
      return requireId(
        await client.sendText(session, toWahaChatId(args.to), args.text, args.contextMessageId),
      )
    },
    async sendMedia(args: SendMediaArgs): Promise<SendResult> {
      return requireId(
        await client.sendFile(
          session,
          toWahaChatId(args.to),
          args.kind,
          {
            url: args.link,
            mimetype: guessMimeFromUrl(args.link, args.kind),
            filename: args.filename,
          },
          args.caption,
          args.contextMessageId,
        ),
      )
    },
    async sendInteractive(args: SendInteractiveArgs): Promise<SendResult> {
      // No native buttons over WhatsApp Web for business → consumer
      // chats; render as a numbered list the inbound side can match.
      return requireId(
        await client.sendText(
          session,
          toWahaChatId(args.to),
          interactiveToText(args.payload),
          args.contextMessageId,
        ),
      )
    },
    async sendTemplate(): Promise<SendResult> {
      throw new UnsupportedOnChannelError(
        'Message templates are a WhatsApp Business API feature and cannot be sent from a WhatsApp Web channel',
      )
    },
    async sendReaction(args: SendReactionArgs): Promise<void> {
      await client.sendReaction(session, args.targetMessageId, args.emoji)
    },
    async markReadAndTyping(args: TypingArgs): Promise<void> {
      const chatId = toWahaChatId(args.to)
      await client.sendSeen(session, chatId, args.inboundMessageId)
      await client.startTyping(session, chatId)
    },
    async markRead(args: TypingArgs): Promise<void> {
      await client.sendSeen(session, toWahaChatId(args.to), args.inboundMessageId)
    },
  }
}

/** Build a WAHA sender from a channel row (token already decrypted). */
export function wahaSenderFromChannel(
  channel: Pick<ChannelRow, 'id' | 'bridge_base_url' | 'bridge_session'>,
  apiKey: string,
): ChannelSender {
  if (!channel.bridge_base_url || !channel.bridge_session) {
    throw new WahaError('Bridge channel is missing its base URL or session name', 500)
  }
  return createWahaSender({
    channelId: channel.id,
    baseUrl: channel.bridge_base_url,
    session: channel.bridge_session,
    apiKey,
  })
}
