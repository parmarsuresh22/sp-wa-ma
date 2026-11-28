// ============================================================
// "Sync from phone" (migration 083): the address book of the phone
// behind a WhatsApp Web number, copied into the portal's contacts and
// tied to that number.
//
// A person already in the portal is not duplicated — they are only tied
// to the number. Nothing is ever removed, and no chat is opened.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface DeviceContact {
  /** Digits with the country code, no plus. */
  digits: string
  name: string | null
}

/**
 * The people in a bridge's contact list: saved contacts with a real
 * phone number. Groups, broadcast lists, hidden-number ids and the
 * phone's own number are left out. Pure.
 */
export function pickDeviceContacts(raw: unknown, ownNumber?: string | null): DeviceContact[] {
  const own = (ownNumber ?? '').replace(/\D/g, '')
  const seen = new Map<string, DeviceContact>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : typeof (r.id as { _serialized?: unknown })?._serialized === 'string' ? ((r.id as { _serialized: string })._serialized) : ''
    if (!/@(c\.us|s\.whatsapp\.net)$/.test(id)) continue
    if (r.isGroup === true || r.isMe === true || r.isBlocked === true) continue
    // Only people saved in the phone's address book, when the bridge says.
    if (r.isMyContact === false) continue
    const digits = id.split('@')[0].replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15 || digits === own) continue
    const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
    const name = pick(r.name) ?? pick(r.shortName) ?? pick(r.pushname) ?? pick(r.pushName) ?? null
    const had = seen.get(digits)
    if (!had || (!had.name && name)) seen.set(digits, { digits, name })
  }
  return [...seen.values()]
}

const CHUNK = 500
export const MAX_SYNC_CONTACTS = 5000

/**
 * Save the phone's contacts under one WhatsApp number. Returns how many
 * were found, how many are new to the portal, and how many are tied to
 * the number now.
 */
export async function saveDeviceContacts(
  db: SupabaseClient,
  input: { accountId: string; channelId: string; userId: string; contacts: DeviceContact[] },
): Promise<{ found: number; added: number; linked: number }> {
  const contacts = input.contacts.slice(0, MAX_SYNC_CONTACTS)
  if (contacts.length === 0) return { found: 0, added: 0, linked: 0 }

  // Everyone the account already has, by the digits of their number.
  const byDigits = new Map<string, string>()
  const byLast10 = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('contacts')
      .select('id, phone')
      .eq('account_id', input.accountId)
      .eq('is_group', false)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as { id: string; phone: string | null }[]
    for (const row of rows) {
      const digits = (row.phone ?? '').replace(/\D/g, '')
      if (!digits) continue
      byDigits.set(digits, row.id)
      if (digits.length >= 10) byLast10.set(digits.slice(-10), row.id)
    }
    if (rows.length < 1000 || from > 200_000) break
  }

  const ids: string[] = []
  const fresh: DeviceContact[] = []
  for (const c of contacts) {
    const known = byDigits.get(c.digits) ?? (c.digits.length >= 10 ? byLast10.get(c.digits.slice(-10)) : undefined)
    if (known) ids.push(known)
    else fresh.push(c)
  }

  let added = 0
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const part = fresh.slice(i, i + CHUNK)
    const { data, error } = await db
      .from('contacts')
      .insert(
        part.map((c) => ({
          account_id: input.accountId,
          user_id: input.userId,
          phone: `+${c.digits}`,
          name: c.name ?? `+${c.digits}`,
        })),
      )
      .select('id')
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as { id: string }[]) ids.push(row.id)
    added += (data ?? []).length
  }

  const unique = [...new Set(ids)]
  const now = new Date().toISOString()
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { error } = await db.from('contact_channels').upsert(
      unique.slice(i, i + CHUNK).map((contact_id) => ({
        contact_id,
        channel_id: input.channelId,
        account_id: input.accountId,
        source: 'device',
        synced_at: now,
      })),
      { onConflict: 'contact_id,channel_id' },
    )
    if (error) throw new Error(error.message)
  }
  return { found: contacts.length, added, linked: unique.length }
}
