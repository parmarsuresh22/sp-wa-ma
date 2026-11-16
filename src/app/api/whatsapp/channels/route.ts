import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listChannels, toPublicChannel } from '@/lib/whatsapp/channels'
import {
  BridgeChannelError,
  createBridgeChannel,
} from '@/lib/whatsapp/bridge-channel'
import { publicOrigin } from '@/lib/whatsapp/public-origin'

/**
 * GET /api/whatsapp/channels
 *
 * Every WhatsApp number on the caller's account, default first. Any
 * member may read this — the inbox dropdown needs it. Secrets are
 * stripped (`toPublicChannel`).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const channels = await listChannels(supabase, accountId)
    return NextResponse.json({ channels: channels.map(toPublicChannel) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/channels
 *
 * Add a WhatsApp Web (WAHA bridge) channel:
 *   { provider: 'waha', label?, bridge_base_url, bridge_api_key, session_name? }
 *
 * Meta numbers are added through POST /api/whatsapp/config, which owns
 * the Meta verification + registration dance.
 *
 * Creates the row, then the bridge session with a webhook pointing back
 * at `/api/whatsapp/bridge/webhook/<channel id>`. Returns the channel;
 * the client then polls GET /api/whatsapp/channels/<id>/bridge for the
 * QR code until the session reports WORKING.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }
    if (body.provider !== 'waha') {
      return NextResponse.json(
        {
          error:
            "provider must be 'waha'. Meta Cloud API numbers are added via POST /api/whatsapp/config.",
          field: 'provider',
        },
        { status: 400 },
      )
    }

    const channel = await createBridgeChannel(supabase, {
      accountId,
      userId,
      label: typeof body.label === 'string' ? body.label : null,
      baseUrl: typeof body.bridge_base_url === 'string' ? body.bridge_base_url : '',
      apiKey: typeof body.bridge_api_key === 'string' ? body.bridge_api_key : '',
      sessionName: typeof body.session_name === 'string' ? body.session_name : null,
      origin: publicOrigin(request),
    })

    return NextResponse.json({ channel: toPublicChannel(channel) }, { status: 201 })
  } catch (err) {
    if (err instanceof BridgeChannelError) {
      return NextResponse.json(
        { error: err.message, ...(err.field ? { field: err.field } : {}) },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
