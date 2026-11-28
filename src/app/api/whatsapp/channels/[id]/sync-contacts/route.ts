import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { decrypt } from '@/lib/whatsapp/encryption'
import { createWahaClient } from '@/lib/whatsapp/providers/waha'
import { MAX_SYNC_CONTACTS, pickDeviceContacts, saveDeviceContacts } from '@/lib/whatsapp/contact-sync'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

export const maxDuration = 120

/**
 * POST /api/whatsapp/channels/[id]/sync-contacts   (agent+)
 *
 * Copies the address book of the phone behind a WhatsApp Web number
 * into the portal's contacts, tied to that number. People already in
 * the portal are not duplicated. Answers { found, added, linked }.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent', 'contacts')
    const limit = checkRateLimit(`contact-sync:${accountId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, id)
    if (!channel) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    if (channel.provider !== 'waha' || !channel.bridge_base_url || !channel.bridge_session) {
      return NextResponse.json(
        { error: 'Contacts can be synced from a WhatsApp Web number only. A Business API number has no phone address book.' },
        { status: 400 },
      )
    }

    let raw: unknown
    try {
      raw = await createWahaClient({ baseUrl: channel.bridge_base_url, apiKey: decrypt(channel.access_token) }).listContacts(
        channel.bridge_session,
      )
    } catch (err) {
      console.error('[contact-sync] the bridge did not return contacts:', err instanceof Error ? err.message : err)
      return NextResponse.json(
        { error: 'The contacts could not be read from the phone. Check that this WhatsApp number is connected, then try again.' },
        { status: 502 },
      )
    }

    const contacts = pickDeviceContacts(raw, channel.display_phone)
    const result = await saveDeviceContacts(db, { accountId, channelId: channel.id, userId, contacts })
    return NextResponse.json({ ...result, capped: contacts.length > MAX_SYNC_CONTACTS })
  } catch (err) {
    return toErrorResponse(err)
  }
}
