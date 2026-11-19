// ============================================================
// WhatsApp Web number requests (migration 071).
//
// An account no longer links a WhatsApp Web number by itself: it asks
// for one, the platform admin approves, and approval creates the
// channel on the platform's bridge. These helpers hold the rules both
// sides share — the per-account limit and the approval itself.
//
// Every function takes the service-role client; the routes own auth.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadPlatformBridge } from '@/lib/admin/super-admin'
import { BridgeChannelError, createBridgeChannel } from '@/lib/whatsapp/bridge-channel'
import type { ChannelRow } from '@/lib/whatsapp/channels'

export const DEFAULT_WEB_NUMBER_LIMIT = 2

export type WebNumberRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface WebNumberRequestRow {
  id: string
  account_id: string
  requested_by: string
  label: string | null
  status: WebNumberRequestStatus
  channel_id: string | null
  note: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

/** What the requesting account may see of a request. */
export type PublicWebNumberRequest = Pick<
  WebNumberRequestRow,
  'id' | 'label' | 'status' | 'channel_id' | 'note' | 'created_at' | 'decided_at'
>

export function toPublicRequest(row: WebNumberRequestRow): PublicWebNumberRequest {
  const { id, label, status, channel_id, note, created_at, decided_at } = row
  return { id, label, status, channel_id, note, created_at, decided_at }
}

export interface WebNumberUsage {
  /** WhatsApp Web numbers the account has linked. */
  linked: number
  /** Requests still waiting for a decision. */
  pending: number
  limit: number
}

/** Linked + pending WhatsApp Web numbers against the account's limit. */
export async function webNumberUsage(db: SupabaseClient, accountId: string): Promise<WebNumberUsage> {
  const [{ count: linked }, { count: pending }, { data: account }] = await Promise.all([
    db
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('provider', 'waha'),
    db
      .from('web_number_requests')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'pending'),
    db.from('accounts').select('web_number_limit').eq('id', accountId).maybeSingle(),
  ])
  const raw = (account as { web_number_limit?: number | null } | null)?.web_number_limit
  return {
    linked: linked ?? 0,
    pending: pending ?? 0,
    limit: typeof raw === 'number' ? raw : DEFAULT_WEB_NUMBER_LIMIT,
  }
}

export class WebNumberRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WebNumberRequestError'
    this.status = status
  }
}

/**
 * Approve a pending request: create the channel on the platform bridge
 * (the account scans its QR code next) and mark the request approved.
 *
 * The request is claimed first (`pending → approved` in one guarded
 * update) so two clicks cannot create two sessions; if the bridge then
 * refuses, the claim is released back to pending.
 */
export async function approveWebNumberRequest(
  db: SupabaseClient,
  requestId: string,
  opts: { decidedBy: string; origin: string },
): Promise<{ request: WebNumberRequestRow; channel: ChannelRow }> {
  const { data: found } = await db
    .from('web_number_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle()
  const request = found as WebNumberRequestRow | null
  if (!request) throw new WebNumberRequestError('Request not found', 404)
  if (request.status !== 'pending') {
    throw new WebNumberRequestError(`This request is already ${request.status}`, 409)
  }

  const usage = await webNumberUsage(db, request.account_id)
  if (usage.linked >= usage.limit) {
    throw new WebNumberRequestError(
      `This account already has ${usage.linked} WhatsApp Web number(s); its limit is ${usage.limit}. Raise the limit first.`,
      409,
    )
  }

  const bridge = await loadPlatformBridge(db)
  if (!bridge) {
    throw new WebNumberRequestError(
      'No platform bridge is set. Save the bridge URL and API key first.',
      400,
    )
  }

  const decidedAt = new Date().toISOString()
  const { data: claimed } = await db
    .from('web_number_requests')
    .update({ status: 'approved', decided_by: opts.decidedBy, decided_at: decidedAt })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
  if (!claimed || claimed.length === 0) {
    throw new WebNumberRequestError('This request was just decided elsewhere', 409)
  }

  let channel: ChannelRow
  try {
    channel = await createBridgeChannel(db, {
      accountId: request.account_id,
      userId: request.requested_by,
      label: request.label,
      baseUrl: bridge.baseUrl,
      apiKey: bridge.apiKey,
      sessionName: null,
      origin: opts.origin,
    })
  } catch (err) {
    await db
      .from('web_number_requests')
      .update({ status: 'pending', decided_by: null, decided_at: null })
      .eq('id', requestId)
    if (err instanceof BridgeChannelError) {
      throw new WebNumberRequestError(err.message, err.status >= 500 ? 502 : 400)
    }
    throw err
  }

  await db.from('web_number_requests').update({ channel_id: channel.id }).eq('id', requestId)

  return {
    request: {
      ...request,
      status: 'approved',
      channel_id: channel.id,
      decided_by: opts.decidedBy,
      decided_at: decidedAt,
    },
    channel,
  }
}

/** Reject a pending request, with an optional note the account sees. */
export async function rejectWebNumberRequest(
  db: SupabaseClient,
  requestId: string,
  opts: { decidedBy: string; note?: string | null },
): Promise<void> {
  const { data: updated, error } = await db
    .from('web_number_requests')
    .update({
      status: 'rejected',
      decided_by: opts.decidedBy,
      decided_at: new Date().toISOString(),
      note: opts.note?.trim().slice(0, 300) || null,
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new WebNumberRequestError(error.message, 500)
  if (!updated || updated.length === 0) {
    throw new WebNumberRequestError('Request not found or already decided', 409)
  }
}
