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
import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts'
import {
  BROADCAST_CHUNK,
  MAX_BROADCAST_RECIPIENTS,
  MESSAGE_GAP_MS,
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
    // A WhatsApp group is a chat, not a contact: never part of an audience.
    .eq('is_group', false)
    .not('phone', 'is', null)
    .neq('phone', '')
  if (audience.mode === 'tags') query = query.in('contact_tags.tag_id', audience.tag_ids)
  return query
}

/** The numbers of the saved list this audience points at (migration 077). */
async function listNumbers(db: SupabaseClient, accountId: string, audience: PostAudience): Promise<string[]> {
  if (!audience.list_id) return []
  const { data, error } = await db
    .from('post_recipient_lists')
    .select('numbers')
    .eq('id', audience.list_id)
    .eq('account_id', accountId)
    .eq('channel_id', audience.channel_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return ((data as { numbers?: string[] } | null)?.numbers ?? []).slice(0, MAX_BROADCAST_RECIPIENTS)
}

/**
 * The next few people of a file-based audience. The cursor is the
 * position in the list. Each 10-digit number gets the country code of
 * the sending number and is saved as a contact of that number (or
 * matched to the contact that already has it), so replies land in the
 * inbox like anyone else's.
 */
async function nextListContacts(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
  channel: ChannelRow,
  cursor: string | null,
  limit: number,
  auditUserId: string,
): Promise<{ contacts: AudienceContact[]; cursor: string }> {
  const numbers = await listNumbers(db, accountId, audience)
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) + 1 : 0
  const slice = numbers.slice(start, start + limit)
  const ownDigits = (channel.display_phone ?? '').replace(/\D/g, '')
  const countryCode = ownDigits.length > 10 ? ownDigits.slice(0, ownDigits.length - 10) : '91'
  const contacts: AudienceContact[] = []
  for (const n of slice) {
    try {
      const made = await findOrCreateContact(db, accountId, auditUserId, { phone: `+${countryCode}${n}` })
      const { data } = await db.from('contacts').select('id, name, phone').eq('id', made.id).maybeSingle()
      if (data) contacts.push(data as AudienceContact)
    } catch {
      // A number WhatsApp's own rules reject is skipped, not fatal.
    }
  }
  return { contacts, cursor: String(start + slice.length - 1) }
}

/** Hand-picked ids are filtered a slice at a time to keep requests short. */
const ID_SLICE = 100

/** How many people the broadcast will reach (capped). */
export async function countAudience(
  db: SupabaseClient,
  accountId: string,
  audience: PostAudience,
): Promise<number> {
  if (audience.mode === 'list') {
    const numbers = await listNumbers(db, accountId, audience)
    return Math.min(numbers.length, MAX_BROADCAST_RECIPIENTS)
  }
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
  const auditUserId = await resolveAuditUserId(db, post.account_id)
  const want = Math.min(BROADCAST_CHUNK, room)
  let contacts: AudienceContact[] = []
  // A file-based audience walks the list by position, so its cursor
  // moves even when a number could not be used.
  let listCursor: string | null = null
  if (room > 0) {
    if (audience.mode === 'list') {
      const next = await nextListContacts(db, post.account_id, audience, channel, tally.cursor, want, auditUserId)
      contacts = next.contacts
      listCursor = next.cursor
      // Numbers that could not be turned into a contact count as failed.
      const skipped = Math.max(0, Math.min(want, tally.total - handled) - contacts.length)
      if (skipped > 0) {
        tally.failed += skipped
        tally.last_error = 'Some numbers in the file are not valid WhatsApp numbers'
      }
    } else {
      contacts = await nextAudienceContacts(db, post.account_id, audience, tally.cursor, want)
    }
  }

  if (contacts.length === 0 && audience.mode !== 'list') {
    tally.done = true
    return tally
  }
  if (audience.mode === 'list' && listCursor !== null) tally.cursor = listCursor
  const ownNumber = (channel.display_phone ?? '').replace(/\D/g, '').slice(-10)
  const text = post.final_text ?? post.caption ?? ''

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]
    if (audience.mode !== 'list') tally.cursor = contact.id
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
    // An uneven, human-ish gap between sends; even bursts get Web numbers
    // banned. Averages MESSAGE_GAP_MS.
    if (i < contacts.length - 1) await sleep(MESSAGE_GAP_MS * (0.7 + Math.random() * 0.6))
  }

  if (tally.sent + tally.failed >= Math.min(tally.total, MAX_BROADCAST_RECIPIENTS)) tally.done = true
  return tally
}
