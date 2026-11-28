import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { decrypt } from '@/lib/whatsapp/encryption'
import { createWahaClient } from '@/lib/whatsapp/providers/waha'
import {
  MAX_SYNC_CONTACTS,
  lidMapFrom,
  pickDeviceContacts,
  saveDeviceContacts,
  type DeviceContact,
} from '@/lib/whatsapp/contact-sync'
import { countryOf, devicePhoneDigits } from '@/lib/contacts/device-contacts'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

export const maxDuration = 120

/**
 * POST /api/whatsapp/channels/[id]/sync-contacts   (agent+)
 *
 * Puts a phone's contacts into the portal, tied to this WhatsApp
 * number. People already in the portal are not duplicated.
 *
 *   Body { contacts: [{ name, phone }] }   contacts picked on the phone
 *                                          or read from its contacts
 *                                          file — any kind of number
 *   No body                                what the WhatsApp Web bridge
 *                                          knows of the linked phone
 *                                          (often only people chatted
 *                                          with, not the address book)
 *
 * Answers { found, added, linked }.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent', 'contacts')
    const limit = checkRateLimit(`contact-sync:${accountId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, id)
    if (!channel) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as { contacts?: unknown } | null
    if (body && Array.isArray(body.contacts)) {
      const country = countryOf(channel.display_phone)
      const own = (channel.display_phone ?? '').replace(/\D/g, '')
      const seen = new Map<string, DeviceContact>()
      for (const item of (body.contacts as unknown[]).slice(0, MAX_SYNC_CONTACTS * 2)) {
        const r = (item && typeof item === 'object' ? item : {}) as { name?: unknown; phone?: unknown }
        const digits = typeof r.phone === 'string' ? devicePhoneDigits(r.phone.slice(0, 40), country) : null
        if (!digits || digits === own) continue
        const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : null
        const had = seen.get(digits)
        if (!had || (!had.name && name)) seen.set(digits, { digits, name })
      }
      const contacts = [...seen.values()]
      const result = await saveDeviceContacts(db, { accountId, channelId: channel.id, userId, contacts })
      return NextResponse.json({ ...result, capped: contacts.length > MAX_SYNC_CONTACTS })
    }

    if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) {
      return NextResponse.json(
        { error: 'A Business API number has no linked phone to read. Pick contacts on your phone or upload its contacts file instead.' },
        { status: 400 },
      )
    }

    let raw: unknown
    let lids: unknown[] = []
    let engine: string | null = null
    try {
      const bridge = createWahaClient({ baseUrl: channel.bridge_base_url, apiKey: decrypt(channel.access_token) })
      raw = await bridge.listContacts(channel.bridge_session)
      // Many people are listed under a hidden id now; this list gives
      // their numbers back.
      lids = await bridge.listLids(channel.bridge_session)
      engine = await bridge
        .getSession(channel.bridge_session)
        .then((s) => JSON.stringify((s as unknown as { engine?: unknown }).engine ?? null).slice(0, 200))
        .catch(() => null)
    } catch (err) {
      console.error('[contact-sync] the bridge did not return contacts:', err instanceof Error ? err.message : err)
      return NextResponse.json(
        { error: 'The contacts could not be read from the linked phone. Check that this WhatsApp number is connected, or pick contacts on your phone instead.' },
        { status: 502 },
      )
    }

    const { contacts, stats } = pickDeviceContacts(raw, channel.display_phone, lidMapFrom(lids))
    const result = await saveDeviceContacts(db, { accountId, channelId: channel.id, userId, contacts })
    // What this run saw, in numbers only — so a short list can be
    // explained afterwards without asking the customer for details.
    const summary = { at: new Date().toISOString(), engine, lids: lids.length, ...stats, ...result }
    console.log('[contact-sync]', channel.id, JSON.stringify(summary))
    await db
      .from('internal_settings')
      .upsert(
        { key: `contact_sync_last:${channel.id}`, value: JSON.stringify(summary), updated_at: summary.at },
        { onConflict: 'key' },
      )
      .then(
        () => undefined,
        () => undefined,
      )
    return NextResponse.json({ ...result, stats, capped: contacts.length > MAX_SYNC_CONTACTS })
  } catch (err) {
    return toErrorResponse(err)
  }
}
