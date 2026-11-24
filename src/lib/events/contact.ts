// The contact a portal-issued pass goes to: a contact of this WhatsApp
// number, or a new number that is saved as one first (same rule as a
// portal-made appointment). Server-only.

import type { SupabaseClient } from '@supabase/supabase-js'

import { ContactError, findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts'
import { phoneKey } from '@/lib/data-tables/lookup'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { EventError } from './service'

export interface OrderContact {
  id: string
  name: string | null
  phoneKey: string
  conversationId: string | null
}

const UUID = /^[0-9a-f-]{36}$/i

export async function resolveOrderContact(
  db: SupabaseClient,
  accountId: string,
  channel: { id: string; display_phone: string | null },
  input: { contactId?: unknown; fresh?: unknown },
): Promise<OrderContact> {
  const fresh = input.fresh && typeof input.fresh === 'object' ? (input.fresh as { name?: unknown; phone?: unknown }) : null
  if (fresh) {
    // A 10-digit number is taken to be in the same country as the
    // business's own number; anything longer must carry its country code.
    const typed = typeof fresh.phone === 'string' ? fresh.phone.trim() : ''
    const digits = typed.replace(/\D/g, '')
    const own = (channel.display_phone ?? '').replace(/\D/g, '')
    const country = own.length > 10 ? own.slice(0, own.length - 10) : '91'
    const phone = typed.startsWith('+')
      ? `+${digits}`
      : digits.length === 10
        ? `+${country}${digits}`
        : digits.length > 10
          ? `+${digits}`
          : ''
    if (!phone) throw new EventError('bad_phone', 'Enter a mobile number with at least 10 digits')
    const name = typeof fresh.name === 'string' ? fresh.name.trim().slice(0, 120) : ''
    try {
      const auditUserId = await resolveAuditUserId(db, accountId)
      const made = await findOrCreateContact(db, accountId, auditUserId, { phone, name: name || null })
      const conversation = await findOrCreateConversationRow(db, accountId, made.id, auditUserId, channel.id)
      const { data: saved } = await db.from('contacts').select('id, name, phone').eq('id', made.id).maybeSingle()
      const row = saved as { id: string; name: string | null; phone: string | null } | null
      const key = phoneKey(row?.phone)
      if (!row || !key) throw new EventError('bad_phone', 'Could not save the contact', 500)
      return { id: row.id, name: name || row.name, phoneKey: key, conversationId: conversation.id }
    } catch (err) {
      if (err instanceof ContactError) throw new EventError('bad_phone', 'That mobile number is not valid')
      throw err
    }
  }

  const contactId = typeof input.contactId === 'string' ? input.contactId : ''
  if (!UUID.test(contactId)) throw new EventError('no_contact', 'Choose a contact')
  // Only a contact of this number: someone with a chat on it.
  const { data } = await db
    .from('contacts')
    .select('id, name, phone, conversations!inner(id, channel_id)')
    .eq('account_id', accountId)
    .eq('id', contactId)
    .eq('conversations.channel_id', channel.id)
    .maybeSingle()
  const row = data as { id: string; name: string | null; phone: string | null; conversations?: { id: string }[] } | null
  if (!row) throw new EventError('no_contact', 'That contact does not belong to this WhatsApp number')
  const key = phoneKey(row.phone)
  if (!key) throw new EventError('no_contact', 'That contact has no phone number')
  return { id: row.id, name: row.name, phoneKey: key, conversationId: row.conversations?.[0]?.id ?? null }
}
