import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  listChannels,
  loadChannel,
  toPublicChannel,
} from '@/lib/whatsapp/channels'
import { teardownBridgeSession } from '@/lib/whatsapp/bridge-channel'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/whatsapp/channels/[id]
 *
 * Body: { label?: string | null, is_default?: true, mirror_inbound_media?: boolean }
 *
 * `is_default: true` makes this the channel used when a send names
 * none; the previous default is cleared first so the partial unique
 * index never sees two. `false` is not accepted — there is always
 * exactly one default while any channel exists.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const channel = await loadChannel(supabase, accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if ('label' in body) {
      if (body.label !== null && typeof body.label !== 'string') {
        return NextResponse.json({ error: 'label must be a string' }, { status: 400 })
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : ''
      patch.label = label || null
    }
    if ('mirror_inbound_media' in body) {
      if (typeof body.mirror_inbound_media !== 'boolean') {
        return NextResponse.json({ error: 'mirror_inbound_media must be a boolean' }, { status: 400 })
      }
      patch.mirror_inbound_media = body.mirror_inbound_media
    }
    if ('is_default' in body) {
      if (body.is_default !== true) {
        return NextResponse.json(
          { error: 'is_default can only be set to true; make another channel the default instead' },
          { status: 400 },
        )
      }
      if (!channel.is_default) {
        const { error: clearError } = await supabase
          .from('whatsapp_config')
          .update({ is_default: false })
          .eq('account_id', accountId)
          .eq('is_default', true)
        if (clearError) {
          return NextResponse.json({ error: clearError.message }, { status: 500 })
        }
        patch.is_default = true
      }
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString()
      const { error } = await supabase
        .from('whatsapp_config')
        .update(patch)
        .eq('id', id)
        .eq('account_id', accountId)
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    const updated = await loadChannel(supabase, accountId, id)
    return NextResponse.json({ channel: updated ? toPublicChannel(updated) : null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/whatsapp/channels/[id]
 *
 * Removes the channel. Conversations keep their history (their
 * `channel_id` is nulled by the FK) and fall back to the account
 * default on the next reply. A bridge channel's session is logged out
 * and deleted on the bridge, best-effort. If the default was removed
 * and other channels remain, the oldest one becomes the default.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    // Service-role lookup, scoped by account: a stale list (or a second
    // click) must not surface as "not found" — the row being gone is the
    // outcome the caller wants, so answer success.
    const channel = await loadChannel(supabaseAdmin(), accountId, id)
    if (!channel) {
      return NextResponse.json({ success: true, already_removed: true })
    }

    if (channel.provider === 'waha') {
      await teardownBridgeSession(channel)
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (channel.is_default) {
      const remaining = await listChannels(supabase, accountId)
      if (remaining.length > 0) {
        await supabase
          .from('whatsapp_config')
          .update({ is_default: true })
          .eq('id', remaining[0].id)
          .eq('account_id', accountId)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
