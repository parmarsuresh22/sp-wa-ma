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

/** Contact ids a tag / hand-picked audience resolves to (sorted, capped). */
async function explicitAudienceIds(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
): Promise<string[] | null> {
  if (audience.mode === 'contacts') return [...audience.contact_ids].sort()
  if (audience.mode === 'tags') {
    // contact_tags has no account_id; the join through contacts scopes it.
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id, contacts!inner(account_id)')
      .in('tag_id', audience.tag_ids)
      .eq('contacts.account_id', accountId)
      .limit(5000)
    if (error) throw new Error(error.message)
    const ids = [...new Set(((data ?? []) as { contact_id: string }[]).map((r) => r.contact_id))]
    return ids.sort().slice(0, MAX_BROADCAST_RECIPIENTS)
  }
  return null // mode "all": read straight from contacts
}

/** How many people the broadcast will reach (capped). */
export async function countAudience(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
): Promise<number> {
  const ids = await explicitAudienceIds(db, accountId, audience)
  if (ids) {
    if (ids.length === 0) return 0
    const { count } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('id', ids)
      .not('phone', 'is', null)
    return count ?? 0
  }
  const { count } = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .not('phone', 'is', null)
  return Math.min(count ?? 0, MAX_BROADCAST_RECIPIENTS)
}

/** The next few recipients after `cursor`, in a stable (id) order. */
async function nextAudienceContacts(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
  cursor: string | null,
  limit: number,
): Promise<AudienceContact[]> {
  const ids = await explicitAudienceIds(db, accountId, audience)
  let query = db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .not('phone', 'is', null)
  if (ids) {
    const rest = cursor ? ids.filter((id) => id > cursor) : ids
    if (rest.length === 0) return []
    // A slice wide enough to still yield `limit` rows if some have no phone.
    query = query.in('id', rest.slice(0, limit * 4))
  } else if (cursor) {
    query = query.gt('id', cursor)
  }
  const { data, error } = await query.order('id', { ascending: true }).limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as AudienceContact[]
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
