import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadChannel, toPublicChannel } from '@/lib/whatsapp/channels'
import { publicOrigin } from '@/lib/whatsapp/public-origin'
import {
  BridgeChannelError,
  inspectBridgeChannel,
  runBridgeAction,
  type BridgeAction,
} from '@/lib/whatsapp/bridge-channel'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/whatsapp/channels/[id]/bridge
 *
 * Live session state from the WAHA bridge, plus the QR payload while
 * the session is waiting to be scanned. The settings page polls this
 * every few seconds during pairing. Also syncs the row's status.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`whatsapp-health:${userId}`, RATE_LIMITS.whatsappHealth)
    if (!limit.success) return rateLimitResponse(limit)

    const channel = await loadChannel(supabase, accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }
    const state = await inspectBridgeChannel(supabase, channel, publicOrigin(request))
    const refreshed = await loadChannel(supabase, accountId, id)
    return NextResponse.json(
      { ...state, channel: refreshed ? toPublicChannel(refreshed) : toPublicChannel(channel) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    if (err instanceof BridgeChannelError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/channels/[id]/bridge
 *
 * Body: { action: 'start' | 'stop' | 'restart' | 'logout' | 'repair_webhook' }
 * `logout` unlinks the phone and immediately restarts the session so a
 * fresh QR code is available. `repair_webhook` re-points the bridge
 * session at this deployment (GET reports `webhookOk: false` when it
 * is needed).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const action = body?.action
    const ACTIONS: BridgeAction[] = ['start', 'stop', 'restart', 'logout', 'repair_webhook']
    if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) {
      return NextResponse.json(
        { error: `action must be one of ${ACTIONS.map((a) => `'${a}'`).join(', ')}` },
        { status: 400 },
      )
    }

    const channel = await loadChannel(supabase, accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }
    await runBridgeAction(supabase, channel, action as BridgeAction, publicOrigin(request))
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof BridgeChannelError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
