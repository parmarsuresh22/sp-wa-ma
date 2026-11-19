// ============================================================
// Publishing a post (migration 072): WhatsApp Status, the broadcast
// to contacts, and the storage of AI / Drive images.
//
// Server-only; every function takes the service-role client and an
// account id it has already been authorised for.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import type { ChannelRow } from '@/lib/whatsapp/channels'
import { createWahaClient } from '@/lib/whatsapp/providers/waha'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { renderBroadcastText } from '@/lib/whatsapp/broadcast-core'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import {
  BROADCAST_CHUNK,
  MAX_BROADCAST_RECIPIENTS,
  type PostAudience,
  type PostBroadcastResult,
  type PostRow,
} from './post'

export const POST_MEDIA_BUCKET = 'chat-media'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Image types the bucket accepts (and WhatsApp can show). */
export function isPostImageMime(mime: string | null | undefined): boolean {
  return !!mime && mime in EXT_BY_MIME
}

/** Put image bytes in the account's media folder; returns its public URL. */
export async function storeAccountImage(
  db: SupabaseClient,
  accountId: string,
  image: { bytes: Buffer; mime: string },
  label: string,
): Promise<{ url: string; path: string; mime: string }> {
  const ext = EXT_BY_MIME[image.mime]
  if (!ext) throw new Error('Only PNG, JPEG and WebP images can be used in a post')
  const safe = label.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'post'
  const path = `account-${accountId}/${Date.now()}-${safe}.${ext}`
  const { error } = await db.storage.from(POST_MEDIA_BUCKET).upload(path, image.bytes, {
    contentType: image.mime,
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`Could not store the image: ${error.message}`)
  const {
    data: { publicUrl },
  } = db.storage.from(POST_MEDIA_BUCKET).getPublicUrl(path)
  return { url: publicUrl, path, mime: image.mime }
}

/** Download an object of the account's media folder. */
export async function readAccountImage(
  db: SupabaseClient,
  path: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const { data, error } = await db.storage.from(POST_MEDIA_BUCKET).download(path)
  if (error || !data) throw new Error(`Could not read the image: ${error?.message ?? 'not found'}`)
  return { bytes: Buffer.from(await data.arrayBuffer()), mime: data.type || 'image/jpeg' }
}

/**
 * Post a WhatsApp Status on one WhatsApp Web number. An image goes out
 * with the text as its caption; with no image the text is the status.
 */
export async function publishStatus(
  channel: ChannelRow,
  post: { text: string; mediaUrl: string | null; mediaMime: string | null },
): Promise<void> {
  if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) {
    throw new Error('WhatsApp Status can only be posted from a WhatsApp Web number')
  }
  if (channel.status !== 'connected') {
    throw new Error('This WhatsApp Web number is not connected')
  }
  const client = createWahaClient({
    baseUrl: channel.bridge_base_url,
    apiKey: decrypt(channel.access_token),
  })
  if (post.mediaUrl) {
    await client.sendStatusImage(
      channel.bridge_session,
      { url: post.mediaUrl, mimetype: post.mediaMime || 'image/jpeg' },
      post.text || undefined,
    )
  } else {
    if (!post.text.trim()) throw new Error('A status needs an image or some text')
    await client.sendStatusText(channel.bridge_session, post.text)
  }
}

// ------------------------------------------------------------
// Broadcast audience
// ------------------------------------------------------------

interface AudienceContact {
  id: string
  name: string | null
  phone: string | null
}

/**
 * The audience is always limited to the contacts of the number the
 * broadcast leaves from: people who have a chat on that number. An
 * account with several numbers keeps each number's customers apart.
 *
 * Both filters are inner joins, so the database does the narrowing and
 * no long id list travels in the request.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function audienceQuery(db: SupabaseClient, accountId: string, audience: PostAudience, columns: string, head: boolean): any {
  const select =
    columns +
    ', conversations!inner(channel_id)' +
    (audience.mode === 'tags' ? ', contact_tags!inner(tag_id)' : '')
  let query = db
    .from('contacts')
    .select(select, head ? { count: 'exact', head: true } : undefined)
    .eq('account_id', accountId)
    .eq('conversations.channel_id', audience.channel_id)
    .not('phone', 'is', null)
  if (audience.mode === 'tags') query = query.in('contact_tags.tag_id', audience.tag_ids)
  return query
}

/** Hand-picked ids are filtered a slice at a time to keep requests short. */
const ID_SLICE = 100

/** How many people the broadcast will reach (capped). */
export async function countAudience(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
): Promise<number> {
  if (audience.mode === 'tags' && audience.tag_ids.length === 0) return 0
  let total = 0
  if (audience.mode === 'contacts') {
    const ids = [...new Set(audience.contact_ids)]
    for (let i = 0; i < ids.length; i += ID_SLICE) {
      const { count, error } = await audienceQuery(db, accountId, audience, 'id', true).in(
        'id',
        ids.slice(i, i + ID_SLICE),
      )
      if (error) throw new Error(error.message)
      total += count ?? 0
    }
  } else {
    const { count, error } = await audienceQuery(db, accountId, audience, 'id', true)
    if (error) throw new Error(error.message)
    total = count ?? 0
  }
  return Math.min(total, MAX_BROADCAST_RECIPIENTS)
}

/** The next few recipients after `cursor`, in a stable (id) order. */
async function nextAudienceContacts(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
  cursor: string | null,
  limit: number,
): Promise<AudienceContact[]> {
  const toContacts = (rows: unknown): AudienceContact[] =>
    ((rows ?? []) as AudienceContact[]).map((r) => ({ id: r.id, name: r.name, phone: r.phone }))

  if (audience.mode === 'contacts') {
    const ids = [...new Set(audience.contact_ids)].sort()
    const rest = cursor ? ids.filter((id) => id > cursor) : ids
    const found: AudienceContact[] = []
    // Some picked ids may not qualify (no phone, not on this number), so
    // keep reading slices until the chunk is full or the list ends.
    for (let i = 0; i < rest.length && found.length < limit; i += ID_SLICE) {
      const { data, error } = await audienceQuery(db, accountId, audience, 'id, name, phone', false)
        .in('id', rest.slice(i, i + ID_SLICE))
        .order('id', { ascending: true })
        .limit(limit - found.length)
      if (error) throw new Error(error.message)
      found.push(...toContacts(data))
    }
    return found
  }

  if (audience.mode === 'tags' && audience.tag_ids.length === 0) return []
  let query = audienceQuery(db, accountId, audience, 'id, name, phone', false)
  if (cursor) query = query.gt('id', cursor)
  const { data, error } = await query.order('id', { ascending: true }).limit(limit)
  if (error) throw new Error(error.message)
  return toContacts(data)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send the post to the next few contacts and return the updated tally.
 * The caller (the open Posts page) keeps calling until `done` — each
 * call is short, so no request runs long, and a closed tab simply
 * pauses the broadcast where it was.
 */
export async function broadcastNextChunk(
  db: SupabaseClient,
  post: PostRow,
  channel: ChannelRow,
  senderId: string | null,
): Promise<PostBroadcastResult> {
  const audience = post.audience
  const prev = post.results.broadcast
  if (!audience || !prev) throw new Error('This post has no broadcast')
  if (prev.done) return prev

  const tally: PostBroadcastResult = { ...prev }
  const handled = tally.sent + tally.failed
  const room = Math.max(0, Math.min(tally.total, MAX_BROADCAST_RECIPIENTS) - handled)
  const contacts =
    room > 0
      ? await nextAudienceContacts(db, post.account_id, audience, tally.cursor, Math.min(BROADCAST_CHUNK, room))
      : []

  if (contacts.length === 0) {
    tally.done = true
    return tally
  }

  const auditUserId = await resolveAuditUserId(db, post.account_id)
  const ownNumber = (channel.display_phone ?? '').replace(/\D/g, '').slice(-10)
  const text = post.final_text ?? post.caption ?? ''

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]
    tally.cursor = contact.id
    // Never message the number the broadcast is leaving from.
    const digits = (contact.phone ?? '').replace(/\D/g, '')
    if (ownNumber && digits.slice(-10) === ownNumber) continue
    try {
      const conversation = await findOrCreateConversationRow(
        db,
        post.account_id,
        contact.id,
        auditUserId,
        channel.id,
      )
      const body = renderBroadcastText(text, contact.name)
      await sendMessageToConversation(db, post.account_id, {
        conversationId: conversation.id,
        channelId: channel.id,
        messageType: post.media_url ? 'image' : 'text',
        mediaUrl: post.media_url,
        contentText: body || null,
        senderId,
      })
      tally.sent++
    } catch (err) {
      tally.failed++
      tally.last_error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    }
    // A human-ish gap between sends; bulk bursts get Web numbers banned.
    if (i < contacts.length - 1) await sleep(900)
  }

  if (tally.sent + tally.failed >= Math.min(tally.total, MAX_BROADCAST_RECIPIENTS)) tally.done = true
  return tally
}
