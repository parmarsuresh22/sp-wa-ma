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

/** What a sync saw, in numbers — to tell why a list came out short. */
export interface DeviceContactStats {
  total: number
  phoneIds: number
  hiddenIds: number
  hiddenResolved: number
  groupsAndLists: number
  notSaved: number
  kept: number
}

const PHONE_ID = /@(c\.us|s\.whatsapp\.net)$/
const digitsOf = (v: unknown) => (typeof v === 'string' ? v.split('@')[0].replace(/\D/g, '') : '')
const idOf = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof (v as { _serialized?: unknown } | null)?._serialized === 'string'
      ? (v as { _serialized: string })._serialized
      : ''

/** `<digits>@lid` → phone digits, from the bridge's list of hidden ids. */
export function lidMapFrom(raw: unknown): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const lid = idOf(r.lid)
    const pn = digitsOf(idOf(r.pn))
    if (lid && pn) map.set(lid.split('@')[0], pn)
  }
  return map
}

/**
 * The people in a bridge's contact list: contacts with a real phone
 * number. Groups, broadcast lists, blocked people and the phone's own
 * number are left out.
 *
 * WhatsApp now lists many people under a hidden id (`…@lid`) instead of
 * their number; `lids` (from the bridge) turns those back into numbers,
 * and an entry that carries its number in another field is read from
 * there. When the bridge marks which entries are saved in the phone's
 * address book, only those are kept; when it marks none, everyone with
 * a number is. Pure.
 */
export function pickDeviceContacts(
  raw: unknown,
  ownNumber?: string | null,
  lids: Map<string, string> = new Map(),
): { contacts: DeviceContact[]; stats: DeviceContactStats } {
  const list = (Array.isArray(raw) ? raw : []).map((item) => (item && typeof item === 'object' ? item : {}) as Record<string, unknown>)
  const own = (ownNumber ?? '').replace(/\D/g, '')
  // Does this bridge tell saved contacts apart at all?
  const marksSaved = list.some((r) => r.isMyContact === true)
  const stats: DeviceContactStats = { total: list.length, phoneIds: 0, hiddenIds: 0, hiddenResolved: 0, groupsAndLists: 0, notSaved: 0, kept: 0 }
  const seen = new Map<string, DeviceContact>()

  for (const r of list) {
    const id = idOf(r.id)
    let digits = ''
    if (PHONE_ID.test(id)) {
      stats.phoneIds++
      digits = digitsOf(id)
    } else if (id.endsWith('@lid')) {
      stats.hiddenIds++
      digits =
        lids.get(id.split('@')[0]) ||
        digitsOf(idOf(r.phoneNumber)) ||
        digitsOf(idOf(r.jid)) ||
        digitsOf(idOf(r.pn)) ||
        (typeof r.number === 'string' ? r.number.replace(/\D/g, '') : '')
      if (digits) stats.hiddenResolved++
    } else {
      stats.groupsAndLists++
      continue
    }
    if (r.isGroup === true || r.isMe === true || r.isBlocked === true) continue
    if (marksSaved && r.isMyContact !== true) {
      stats.notSaved++
      continue
    }
    if (digits.length < 8 || digits.length > 15 || digits === own) continue
    const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
    const name = pick(r.name) ?? pick(r.shortName) ?? pick(r.verifiedName) ?? pick(r.pushname) ?? pick(r.pushName) ?? null
    // Without the saved mark, a nameless entry is a stranger from a group.
    if (!marksSaved && !name) {
      stats.notSaved++
      continue
    }
    const had = seen.get(digits)
    if (!had || (!had.name && name)) seen.set(digits, { digits, name })
  }
  stats.kept = seen.size
  return { contacts: [...seen.values()], stats }
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
