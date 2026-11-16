import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listChannels } from '@/lib/whatsapp/channels'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }

    const limit = checkRateLimit(`whatsapp-media:${user.id}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    // A Meta media id is scoped to the WABA that received it. With
    // several Meta numbers on the account we don't know which one the
    // attachment came in on, so try each channel's token in turn
    // (default first). Bridge channels never produce Meta media ids.
    const metaChannels = (await listChannels(supabase, accountId)).filter(
      (c) => c.provider === 'meta'
    )
    if (metaChannels.length === 0) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    let lastError: unknown = null
    for (const channel of metaChannels) {
      try {
        const accessToken = decrypt(channel.access_token)
        // Get the download URL from Meta
        const mediaInfo = await getMediaUrl({ mediaId, accessToken })
        // Download the binary data
        const { buffer, contentType } = await downloadMedia({
          downloadUrl: mediaInfo.url,
          accessToken,
        })
        return new Response(new Uint8Array(buffer), {
          status: 200,
          headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
        })
      } catch (err) {
        lastError = err
      }
    }
    throw lastError ?? new Error('media lookup failed on every channel')
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
