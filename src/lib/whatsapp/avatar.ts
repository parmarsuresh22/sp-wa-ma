// ============================================================
// WhatsApp profile photos (migration 077).
//
// The inbox and the contact list show a contact's WhatsApp photo. To
// keep every page as fast as before, the photo is never looked up when
// a page loads: it is fetched in the background when a message arrives
// from that contact, at most once a week, copied into our own storage
// (WhatsApp's own photo addresses expire within hours), and its address
// saved on the contact row the pages already read.
//
// Only a WhatsApp Web bridge can do this; the WhatsApp Business API
// does not give out profile photos.
//
// Server-only. Never throws: a photo is decoration, the message is not.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import type { ChannelRow } from '@/lib/whatsapp/channels'
import { createWahaClient, toWahaChatId } from '@/lib/whatsapp/providers/waha'

/** How long a looked-up photo (or the lack of one) is trusted. */
export const AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const BUCKET = 'chat-media'

export function avatarIsStale(checkedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!checkedAt) return true
  const at = Date.parse(checkedAt)
  return Number.isNaN(at) || now - at > AVATAR_REFRESH_MS
}

/** Where a contact's photo lives in storage (stable, so a refresh overwrites it). */
export function avatarPath(accountId: string, contactId: string): string {
  return `account-${accountId}/avatars/${contactId}.jpg`
}

/**
 * Look up and store the WhatsApp photo of the contact that just wrote,
 * if it has not been checked in the last week.
 *
 * `key` identifies the contact the same way the inbound pipeline does:
 * the phone (`+digits`) for a person, the chat id for a group.
 */
export async function refreshContactAvatar(
  db: SupabaseClient,
  channel: ChannelRow,
  key: { phone?: string | null; waUserId?: string | null },
): Promise<void> {
  try {
    if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) return

    let query = db
      .from('contacts')
      .select('id, phone, wa_user_id, avatar_checked_at')
      .eq('account_id', channel.account_id)
    if (key.waUserId) query = query.eq('wa_user_id', key.waUserId)
    else if (key.phone) query = query.eq('phone_normalized', key.phone.replace(/\D/g, ''))
    else return
    const { data } = await query.limit(1)
    const contact = (data as { id: string; phone: string | null; wa_user_id: string | null; avatar_checked_at: string | null }[] | null)?.[0]
    if (!contact || !avatarIsStale(contact.avatar_checked_at)) return

    // Claim the check first, so a burst of messages looks it up once.
    const stamp = new Date().toISOString()
    let claim = db.from('contacts').update({ avatar_checked_at: stamp }).eq('id', contact.id)
    claim = contact.avatar_checked_at
      ? claim.eq('avatar_checked_at', contact.avatar_checked_at)
      : claim.is('avatar_checked_at', null)
    const { data: claimed } = await claim.select('id')
    if (!claimed || claimed.length === 0) return

    const chatId = contact.wa_user_id?.endsWith('@g.us')
      ? contact.wa_user_id
      : contact.phone
        ? toWahaChatId(contact.phone)
        : null
    if (!chatId) return

    const client = createWahaClient({ baseUrl: channel.bridge_base_url, apiKey: decrypt(channel.access_token) })
    const url = await client.profilePictureUrl(channel.bridge_session, chatId)
    if (!url) {
      // No photo (or hidden): show initials. The stamp stops re-asking.
      await db.from('contacts').update({ avatar_url: null }).eq('id', contact.id)
      return
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/')) return
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return

    const path = avatarPath(channel.account_id, contact.id)
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, {
      contentType: type === 'image/png' || type === 'image/webp' ? type : 'image/jpeg',
      cacheControl: '86400',
      upsert: true,
    })
    if (upErr) return
    const {
      data: { publicUrl },
    } = db.storage.from(BUCKET).getPublicUrl(path)
    // The version makes browsers pick up a changed photo despite caching.
    await db
      .from('contacts')
      .update({ avatar_url: `${publicUrl}?v=${Date.parse(stamp)}` })
      .eq('id', contact.id)
  } catch (err) {
    console.warn('[avatar] refresh skipped:', err instanceof Error ? err.message : err)
  }
}
