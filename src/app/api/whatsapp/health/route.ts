import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api'
import { loadChannel, loadDefaultChannel } from '@/lib/whatsapp/channels'
import {
  parseMessagingLimit,
  parseQualityRating,
  type PhoneHealth,
} from '@/lib/whatsapp/phone-health'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const CACHE_HEADERS = { 'Cache-Control': 'private, max-age=300' }

function reply(body: PhoneHealth) {
  return NextResponse.json(body, { headers: CACHE_HEADERS })
}

const EMPTY: Omit<PhoneHealth, 'state'> = {
  displayPhoneNumber: null,
  quality: 'UNKNOWN',
  limit: null,
}

/**
 * GET /api/whatsapp/health?channel_id=<uuid>
 *
 * Health of one channel (default channel when `channel_id` is omitted).
 * Meta numbers report Meta's quality rating and messaging tier; a
 * WhatsApp Web bridge reports connected/disconnected from its session
 * status with the number it is logged in as.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`whatsapp-health:${userId}`, RATE_LIMITS.whatsappHealth)
    if (!limit.success) return rateLimitResponse(limit)

    const channelId = new URL(request.url).searchParams.get('channel_id')
    const config = channelId
      ? await loadChannel(supabase, accountId, channelId)
      : await loadDefaultChannel(supabase, accountId)

    if (!config || config.status !== 'connected') {
      return reply({ state: 'disconnected', ...EMPTY })
    }

    if (config.provider === 'waha') {
      return reply({
        state: config.bridge_status === 'WORKING' ? 'connected' : 'disconnected',
        displayPhoneNumber: config.display_phone ?? null,
        quality: 'UNKNOWN',
        limit: null,
      })
    }

    if (!config.phone_number_id) {
      return reply({ state: 'disconnected', ...EMPTY })
    }

    try {
      const info = await getPhoneNumberHealth({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      })
      return reply({
        state: 'connected',
        displayPhoneNumber: info.display_phone_number ?? null,
        quality: parseQualityRating(info.quality_rating),
        limit: parseMessagingLimit(info.whatsapp_business_manager_messaging_limit),
      })
    } catch (err) {
      console.error('[whatsapp/health] lookup failed:', err instanceof Error ? err.message : err)
      return reply({ state: 'unavailable', ...EMPTY })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
