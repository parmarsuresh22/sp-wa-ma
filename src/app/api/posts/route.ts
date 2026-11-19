import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { listChannels } from '@/lib/whatsapp/channels'
import {
  accountMediaPath,
  cleanIdList,
  isAccountMediaUrl,
  MAX_CAPTION_LENGTH,
  parseAudience,
  withWhatsAppLink,
  type PostResults,
  type PostRow,
  type PostStatusResult,
} from '@/lib/posts/post'
import { countAudience, isPostImageMime, publishStatus, readAccountImage } from '@/lib/posts/publish'
import { DriveError, openDrive, uploadToDrive } from '@/lib/google/drive'

// Status goes to the bridge and the Drive copy uploads the image.
export const maxDuration = 60

/**
 * POST /api/posts   (agent+)
 *
 * Body: {
 *   caption?: string,
 *   media_url?: string,          // an image this account uploaded
 *   media_mime?: string,
 *   include_link?: boolean,      // add "chat with us" + wa.me link
 *   link_channel_id?: string,    // whose number the link carries
 *   status_channel_ids?: string[],   // WhatsApp Web numbers to post a Status on
 *   audience?: { mode, tag_ids, contact_ids, channel_id },  // broadcast
 *   save_to_drive?: boolean
 * }
 *
 * Saves the post, publishes the Status on each chosen number and copies
 * the image to Google Drive. The broadcast is only *prepared* here (its
 * recipient count); the page then drives it in small chunks through
 * POST /api/posts/[id]/broadcast.
 *
 * Each destination reports its own outcome in `results` — one failing
 * does not undo the others.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`posts:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const caption = typeof body.caption === 'string' ? body.caption.trim() : ''
    if (caption.length > MAX_CAPTION_LENGTH) {
      return NextResponse.json(
        { error: `The text is longer than ${MAX_CAPTION_LENGTH} characters` },
        { status: 400 },
      )
    }

    const mediaUrl = typeof body.media_url === 'string' && body.media_url ? body.media_url : null
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (mediaUrl && !isAccountMediaUrl(mediaUrl, supabaseUrl, accountId)) {
      return NextResponse.json({ error: 'Upload the image again' }, { status: 400 })
    }
    const mediaMime =
      mediaUrl && typeof body.media_mime === 'string' && isPostImageMime(body.media_mime)
        ? body.media_mime
        : mediaUrl
          ? 'image/jpeg'
          : null
    if (!caption && !mediaUrl) {
      return NextResponse.json({ error: 'Add an image or some text first' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const channels = await listChannels(db, accountId)
    const webChannels = channels.filter((c) => c.provider === 'waha')

    // The contact line.
    const includeLink = body.include_link === true
    const linkChannel = includeLink
      ? (channels.find((c) => c.id === body.link_channel_id) ?? channels[0] ?? null)
      : null
    if (includeLink && !linkChannel?.display_phone) {
      return NextResponse.json(
        { error: 'The chosen WhatsApp number has no phone number yet; connect it first' },
        { status: 400 },
      )
    }
    const finalText = includeLink ? withWhatsAppLink(caption, linkChannel?.display_phone) : caption

    // Destinations.
    const statusIds = cleanIdList(body.status_channel_ids, 10)
    const statusChannels = webChannels.filter((c) => statusIds.includes(c.id))
    if (statusIds.length !== statusChannels.length) {
      return NextResponse.json(
        { error: 'WhatsApp Status can only be posted from a WhatsApp Web number of this account' },
        { status: 400 },
      )
    }
    const audience = body.audience ? parseAudience(body.audience) : null
    if (body.audience && !audience) {
      return NextResponse.json({ error: 'Choose who the broadcast goes to' }, { status: 400 })
    }
    if (audience && !webChannels.some((c) => c.id === audience.channel_id)) {
      return NextResponse.json(
        { error: 'The broadcast must leave from a WhatsApp Web number of this account' },
        { status: 400 },
      )
    }
    const saveToDrive = body.save_to_drive === true && !!mediaUrl
    if (statusChannels.length === 0 && !audience && !saveToDrive) {
      return NextResponse.json({ error: 'Choose at least one place to post to' }, { status: 400 })
    }

    const results: PostResults = {}
    if (audience) {
      const total = await countAudience(db, accountId, audience)
      if (total === 0) {
        return NextResponse.json(
          { error: 'Nobody matches that audience. Only contacts who have a chat on the sending number, and a phone number, are included.' },
          { status: 400 },
        )
      }
      results.broadcast = { total, sent: 0, failed: 0, cursor: null, done: false }
    }

    const { data: inserted, error: insertErr } = await db
      .from('posts')
      .insert({
        account_id: accountId,
        created_by: userId,
        caption: caption || null,
        final_text: finalText || null,
        media_url: mediaUrl,
        media_path: mediaUrl ? accountMediaPath(mediaUrl, supabaseUrl, accountId) : null,
        media_mime: mediaMime,
        include_link: includeLink,
        link_channel_id: linkChannel?.id ?? null,
        status_channel_ids: statusChannels.map((c) => c.id),
        audience,
        results,
      })
      .select('*')
      .single()
    if (insertErr || !inserted) {
      return NextResponse.json(
        { error: insertErr?.message ?? 'Could not save the post' },
        { status: 500 },
      )
    }
    const post = inserted as PostRow

    // WhatsApp Status, one number at a time.
    if (statusChannels.length > 0) {
      const statusResults: PostStatusResult[] = []
      for (const channel of statusChannels) {
        try {
          await publishStatus(channel, { text: finalText, mediaUrl, mediaMime })
          statusResults.push({ channel_id: channel.id, ok: true })
        } catch (err) {
          statusResults.push({
            channel_id: channel.id,
            ok: false,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          })
        }
      }
      results.status = statusResults
    }

    // A copy of the image in the account's Google Drive.
    let driveFileId: string | null = null
    if (saveToDrive && post.media_path) {
      try {
        const conn = await openDrive(db, accountId)
        const image = await readAccountImage(db, post.media_path)
        const base = post.media_path.split('/').pop() ?? 'post.jpg'
        driveFileId = await uploadToDrive(db, conn, {
          name: base,
          mime: mediaMime ?? image.mime,
          bytes: image.bytes,
          description: caption,
        })
        results.drive = { ok: true, file_id: driveFileId }
      } catch (err) {
        results.drive = {
          ok: false,
          error:
            err instanceof DriveError || err instanceof Error
              ? err.message.slice(0, 300)
              : 'Could not save to Google Drive',
        }
      }
    }

    const { data: updated } = await db
      .from('posts')
      .update({ results, drive_file_id: driveFileId, updated_at: new Date().toISOString() })
      .eq('id', post.id)
      .select('*')
      .single()

    return NextResponse.json({ post: (updated as PostRow | null) ?? { ...post, results } }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
