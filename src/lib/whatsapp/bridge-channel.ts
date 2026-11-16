// ============================================================
// Create / inspect / tear down a WAHA bridge channel.
//
// Server-side helpers shared by the channel API routes. Each takes a
// Supabase client (RLS-scoped admin session or service role) and does
// the bridge round-trips; the routes own auth and response shapes.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { listChannels, type ChannelRow } from '@/lib/whatsapp/channels'
import {
  createWahaClient,
  normalizeBridgeBaseUrl,
  WahaError,
  chatIdToPhone,
  type WahaSessionInfo,
} from '@/lib/whatsapp/providers/waha'
import { BRIDGE_WEBHOOK_EVENTS } from '@/lib/whatsapp/bridge-webhook'
import { bridgeWebhookUrl } from '@/lib/whatsapp/public-origin'

export class BridgeChannelError extends Error {
  readonly status: number
  readonly field?: string
  constructor(message: string, status: number, field?: string) {
    super(message)
    this.name = 'BridgeChannelError'
    this.status = status
    this.field = field
  }
}

export interface CreateBridgeChannelInput {
  accountId: string
  userId: string
  label: string | null
  baseUrl: string
  apiKey: string
  /** Optional: reuse an existing session on the bridge. */
  sessionName?: string | null
  /** Public origin of this deployment, for the webhook URL. */
  origin: string
}

function newSessionName(): string {
  return `wacrm-${crypto.randomBytes(4).toString('hex')}`
}

/**
 * Insert the channel row, then create (or re-point) the WAHA session
 * with a webhook back to this deployment. The row goes first because
 * the webhook URL carries the channel id; on a bridge failure the row
 * is removed again so a typo never leaves a dead channel behind.
 */
export async function createBridgeChannel(
  db: SupabaseClient,
  input: CreateBridgeChannelInput,
): Promise<ChannelRow> {
  const baseUrl = normalizeBridgeBaseUrl(input.baseUrl)
  if (!baseUrl) {
    throw new BridgeChannelError('Bridge URL must be a valid http(s) URL', 400, 'bridge_base_url')
  }
  const apiKey = input.apiKey.trim()
  if (!apiKey) {
    throw new BridgeChannelError('Bridge API key is required', 400, 'bridge_api_key')
  }
  const sessionName = (input.sessionName?.trim() || newSessionName()).replace(/[^A-Za-z0-9_-]/g, '')
  if (!sessionName) {
    throw new BridgeChannelError('Session name may only contain letters, digits, - and _', 400, 'session_name')
  }

  // Reachability + key check before writing anything.
  const client = createWahaClient({ baseUrl, apiKey })
  try {
    await client.listSessions()
  } catch (err) {
    const status = err instanceof WahaError ? err.status : 502
    throw new BridgeChannelError(
      status === 401 || status === 403
        ? 'The bridge rejected the API key'
        : `Could not reach the bridge: ${err instanceof Error ? err.message : String(err)}`,
      status === 401 || status === 403 ? 400 : 502,
      status === 401 || status === 403 ? 'bridge_api_key' : 'bridge_base_url',
    )
  }

  const existing = await listChannels(db, input.accountId)
  const hmacKey = crypto.randomBytes(32).toString('hex')

  const { data: inserted, error: insertError } = await db
    .from('whatsapp_config')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      provider: 'waha',
      label: input.label?.trim() || null,
      is_default: existing.length === 0,
      status: 'disconnected',
      access_token: encrypt(apiKey),
      bridge_base_url: baseUrl,
      bridge_session: sessionName,
      bridge_webhook_secret: encrypt(hmacKey),
      bridge_status: 'STARTING',
    })
    .select('*')
    .single()
  if (insertError || !inserted) {
    const msg = insertError?.message ?? 'insert failed'
    if (/idx_whatsapp_config_bridge_session|duplicate/i.test(msg)) {
      throw new BridgeChannelError(
        'That bridge session is already connected to a channel',
        409,
        'session_name',
      )
    }
    throw new BridgeChannelError(`Could not save the channel: ${msg}`, 500)
  }
  const row = inserted as ChannelRow

  const webhook = {
    url: bridgeWebhookUrl(input.origin, row.id),
    events: [...BRIDGE_WEBHOOK_EVENTS],
    hmacKey,
  }

  try {
    let info: WahaSessionInfo | null = null
    try {
      info = await client.createSession(sessionName, webhook)
    } catch (err) {
      // Session already exists on the bridge (422 on WAHA): re-point its
      // webhook at us and make sure it is running.
      if (err instanceof WahaError && (err.status === 422 || err.status === 409)) {
        await client.updateSessionWebhook(sessionName, webhook)
        await client.startSession(sessionName).catch(() => undefined)
        info = await client.getSession(sessionName).catch(() => null)
      } else {
        throw err
      }
    }
    const patch = sessionPatch(info)
    if (Object.keys(patch).length > 0) {
      await db.from('whatsapp_config').update(patch).eq('id', row.id)
      Object.assign(row, patch)
    }
  } catch (err) {
    await db.from('whatsapp_config').delete().eq('id', row.id)
    throw new BridgeChannelError(
      `The bridge refused to create the session: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  return row
}

/** Row patch derived from a bridge session report. */
export function sessionPatch(info: WahaSessionInfo | null): Record<string, unknown> {
  if (!info) return {}
  const status = (info.status || '').toUpperCase()
  const patch: Record<string, unknown> = {
    bridge_status: status || null,
    status: status === 'WORKING' ? 'connected' : 'disconnected',
    updated_at: new Date().toISOString(),
  }
  if (status === 'WORKING') patch.connected_at = new Date().toISOString()
  const phone = chatIdToPhone(info.me?.id ?? null)
  if (phone) patch.display_phone = phone
  return patch
}

export interface BridgeState {
  status: string | null
  phone: string | null
  pushName: string | null
  /** Raw QR payload to render while the session waits for a scan. */
  qr: string | null
  /** The same QR as a PNG data URL, straight into an <img>. */
  qrImage: string | null
  error: string | null
}

/** Ask the bridge how a channel's session is doing; sync the row. */
export async function inspectBridgeChannel(
  db: SupabaseClient,
  channel: ChannelRow,
): Promise<BridgeState> {
  if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) {
    throw new BridgeChannelError('Not a bridge channel', 400)
  }
  const client = createWahaClient({
    baseUrl: channel.bridge_base_url,
    apiKey: decrypt(channel.access_token),
  })
  let info: WahaSessionInfo | null = null
  try {
    info = await client.getSession(channel.bridge_session)
  } catch (err) {
    if (err instanceof WahaError && err.status === 404) {
      await db
        .from('whatsapp_config')
        .update({ bridge_status: 'STOPPED', status: 'disconnected' })
        .eq('id', channel.id)
      return {
        status: 'MISSING',
        phone: null,
        pushName: null,
        qr: null,
        qrImage: null,
        error: 'Session not found on the bridge',
      }
    }
    return {
      status: channel.bridge_status,
      phone: channel.display_phone,
      pushName: null,
      qr: null,
      qrImage: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const patch = sessionPatch(info)
  await db.from('whatsapp_config').update(patch).eq('id', channel.id)

  const status = (info.status || '').toUpperCase()
  let qr: string | null = null
  let qrImage: string | null = null
  if (status === 'SCAN_QR_CODE') {
    qrImage = await client.getQrImage(channel.bridge_session).catch(() => null)
    if (!qrImage) qr = await client.getQrValue(channel.bridge_session).catch(() => null)
  }
  return {
    status,
    phone: chatIdToPhone(info.me?.id ?? null) ?? channel.display_phone,
    pushName: info.me?.pushName ?? null,
    qr,
    qrImage,
    error: null,
  }
}

export type BridgeAction = 'start' | 'stop' | 'restart' | 'logout'

export async function runBridgeAction(
  db: SupabaseClient,
  channel: ChannelRow,
  action: BridgeAction,
): Promise<void> {
  if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) {
    throw new BridgeChannelError('Not a bridge channel', 400)
  }
  const client = createWahaClient({
    baseUrl: channel.bridge_base_url,
    apiKey: decrypt(channel.access_token),
  })
  const name = channel.bridge_session
  try {
    if (action === 'start') await client.startSession(name)
    else if (action === 'stop') await client.stopSession(name)
    else if (action === 'restart') await client.restartSession(name)
    else if (action === 'logout') {
      await client.logoutSession(name)
      await client.startSession(name).catch(() => undefined)
    }
  } catch (err) {
    throw new BridgeChannelError(
      `Bridge ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof WahaError && err.status >= 400 && err.status < 500 ? 400 : 502,
    )
  }
  await db
    .from('whatsapp_config')
    .update({
      status: 'disconnected',
      bridge_status: action === 'stop' ? 'STOPPED' : 'STARTING',
      updated_at: new Date().toISOString(),
    })
    .eq('id', channel.id)
}

/** Best-effort: log the session out and delete it from the bridge. */
export async function teardownBridgeSession(channel: ChannelRow): Promise<void> {
  if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) return
  try {
    const client = createWahaClient({
      baseUrl: channel.bridge_base_url,
      apiKey: decrypt(channel.access_token),
    })
    await client.logoutSession(channel.bridge_session).catch(() => undefined)
    await client.deleteSession(channel.bridge_session).catch(() => undefined)
  } catch (err) {
    console.warn('[bridge-channel] teardown failed (continuing):', err instanceof Error ? err.message : err)
  }
}
