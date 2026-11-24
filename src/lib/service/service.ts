// ============================================================
// Service Today (migration 081): reading the records, saving a visit,
// and the messages that go with it.
//
// Server-only. Every function takes the service-role client and an
// account the caller has already been authorised for. It works on
// WhatsApp Web numbers only, and nothing here costs anything: there is
// no balance to check before a message goes out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadChannel } from '@/lib/whatsapp/channels'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { resolveOrderContact } from '@/lib/events/contact'
import { isAccountMediaUrl } from '@/lib/posts/post'
import {
  addDays,
  localDay,
  parseBusinessInput,
  parseVisitInput,
  reminderDue,
  serviceMessage,
  type ServiceCustomer,
  type ServiceMessageKind,
  type ServiceSettings,
  type ServiceVisit,
} from './types'

export class ServiceError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ServiceError'
    this.status = status
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

type Channel = NonNullable<Awaited<ReturnType<typeof loadChannel>>>

/** The WhatsApp Web number the records belong to; other kinds are refused. */
export async function requireWebChannel(db: SupabaseClient, accountId: string, channelId: unknown): Promise<Channel> {
  if (!isUuid(channelId)) throw new ServiceError('Choose a WhatsApp number')
  const channel = await loadChannel(db, accountId, channelId)
  if (!channel) throw new ServiceError('WhatsApp number not found', 404)
  if (channel.provider !== 'waha') throw new ServiceError('Service Today works on WhatsApp Web numbers only')
  return channel
}

function toSettings(row: Record<string, unknown>): ServiceSettings {
  return {
    id: row.id as string,
    channel_id: row.channel_id as string,
    business_name: (row.business_name as string) ?? '',
    address: (row.address as string) ?? '',
    language: row.language === 'hi' ? 'hi' : 'en',
    timezone: (row.timezone as string) || 'Asia/Kolkata',
    reminder_time: (row.reminder_time as string) || '09:00',
  }
}

const toVisit = (row: Record<string, unknown>): ServiceVisit =>
  ({ ...row, images: Array.isArray(row.images) ? (row.images as string[]) : [] }) as ServiceVisit

export async function loadServiceSettings(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
): Promise<ServiceSettings | null> {
  const { data, error } = await db
    .from('service_settings')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toSettings(data as Record<string, unknown>) : null
}

/** Everything the page shows for one number. */
export async function loadServiceData(db: SupabaseClient, accountId: string, channelId: string) {
  const business = await loadServiceSettings(db, accountId, channelId)
  const [{ data: customers, error: e1 }, { data: visits, error: e2 }] = await Promise.all([
    db
      .from('service_customers')
      .select('*')
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .eq('status', 'active')
      .order('name', { ascending: true })
      .limit(5000),
    db
      .from('service_visits')
      .select('*')
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .eq('status', 'active')
      .order('visit_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20000),
  ])
  if (e1 || e2) throw new Error((e1 ?? e2)!.message)
  const today = localDay(new Date(), business?.timezone ?? 'Asia/Kolkata').date
  return {
    business,
    customers: (customers ?? []) as ServiceCustomer[],
    visits: ((visits ?? []) as Record<string, unknown>[]).map(toVisit),
    today,
  }
}

export async function saveServiceBusiness(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  raw: unknown,
): Promise<ServiceSettings> {
  const parsed = parseBusinessInput(raw)
  if (!parsed.ok) throw new ServiceError(parsed.error)
  const { data, error } = await db
    .from('service_settings')
    .upsert(
      { account_id: accountId, channel_id: channelId, ...parsed.value, updated_at: new Date().toISOString() },
      { onConflict: 'channel_id' },
    )
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return toSettings(data as Record<string, unknown>)
}

/** Send one message to a customer on the number their record belongs to. */
async function sendToCustomer(
  db: SupabaseClient,
  accountId: string,
  customer: Pick<ServiceCustomer, 'contact_id' | 'channel_id'>,
  text: string,
  senderId: string | null,
): Promise<void> {
  const auditUserId = await resolveAuditUserId(db, accountId)
  const conversation = await findOrCreateConversationRow(db, accountId, customer.contact_id, auditUserId, customer.channel_id)
  await sendMessageToConversation(db, accountId, {
    conversationId: conversation.id,
    channelId: customer.channel_id,
    messageType: 'text',
    contentText: text,
    senderId,
  })
}

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

function ownImages(images: string[], accountId: string): string[] {
  // Only photos this account uploaded to its own folder.
  return images.filter((u) => isAccountMediaUrl(u, process.env.NEXT_PUBLIC_SUPABASE_URL, accountId))
}

/**
 * Save today's entry: the customer is found or made, the visit is
 * stored, and the customer gets a WhatsApp confirmation. A message that
 * cannot be sent never loses the entry — the reason is returned.
 */
export async function saveServiceVisit(
  db: SupabaseClient,
  input: { accountId: string; channel: Channel; userId: string | null; body: Record<string, unknown> },
): Promise<{ visit: ServiceVisit; customer: ServiceCustomer; sent: boolean; message_error: string | null }> {
  const { accountId, channel, userId, body } = input
  const settings = await loadServiceSettings(db, accountId, channel.id)
  if (!settings) throw new ServiceError('Save the business name and address first')
  const parsed = parseVisitInput(body)
  if (!parsed.ok) throw new ServiceError(parsed.error)
  const v = parsed.value

  let customer: ServiceCustomer | null = null
  if (isUuid(body.customerId)) {
    const { data } = await db
      .from('service_customers')
      .select('*')
      .eq('id', body.customerId)
      .eq('account_id', accountId)
      .eq('channel_id', channel.id)
      .maybeSingle()
    customer = (data as ServiceCustomer | null) ?? null
    if (!customer) throw new ServiceError('Customer not found', 404)
  }

  const now = new Date().toISOString()
  if (customer) {
    const { data, error } = await db
      .from('service_customers')
      .update({ name: v.customer_name, area: v.area ?? customer.area, status: 'active', updated_at: now })
      .eq('id', customer.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    customer = data as ServiceCustomer
  } else {
    let contact
    try {
      contact = await resolveOrderContact(db, accountId, channel, {
        fresh: { name: v.customer_name, phone: typeof body.customerPhone === 'string' ? body.customerPhone : '' },
      })
    } catch (err) {
      const status = (err as { status?: unknown })?.status
      if (typeof status === 'number' && status < 500) throw new ServiceError(short(err), status)
      throw err
    }
    // The same number again is the same customer (and comes back if it
    // had been removed).
    const { data, error } = await db
      .from('service_customers')
      .upsert(
        {
          account_id: accountId,
          channel_id: channel.id,
          contact_id: contact.id,
          phone_key: contact.phoneKey,
          name: v.customer_name,
          area: v.area,
          status: 'active',
          updated_at: now,
        },
        { onConflict: 'channel_id,contact_id' },
      )
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    customer = data as ServiceCustomer
  }

  const { data: made, error: visitError } = await db
    .from('service_visits')
    .insert({
      account_id: accountId,
      channel_id: channel.id,
      customer_id: customer.id,
      service: v.service,
      area: v.area,
      visit_date: v.visit_date,
      next_visit: v.next_visit,
      comment: v.comment,
      images: ownImages(v.images, accountId),
      created_by: userId,
    })
    .select('*')
    .single()
  if (visitError) throw new Error(visitError.message)
  let visit = toVisit(made as Record<string, unknown>)

  let messageError: string | null = null
  try {
    await sendToCustomer(
      db,
      accountId,
      customer,
      serviceMessage('saved', settings, {
        customerName: customer.name,
        service: visit.service,
        visitDate: visit.visit_date,
        nextVisit: visit.next_visit,
      }),
      userId,
    )
  } catch (err) {
    messageError = short(err)
    await db.from('service_visits').update({ message_error: messageError }).eq('id', visit.id)
    visit = { ...visit, message_error: messageError }
  }
  return { visit, customer, sent: !messageError, message_error: messageError }
}

/** Change an open visit. No message goes out; reminders follow the new date. */
export async function updateServiceVisit(
  db: SupabaseClient,
  accountId: string,
  visitId: string,
  body: Record<string, unknown>,
): Promise<ServiceVisit> {
  const parsed = parseVisitInput(body)
  if (!parsed.ok) throw new ServiceError(parsed.error)
  const v = parsed.value
  const { data: found } = await db
    .from('service_visits')
    .select('*')
    .eq('id', visitId)
    .eq('account_id', accountId)
    .eq('status', 'active')
    .maybeSingle()
  const current = found as (ServiceVisit & { customer_id: string }) | null
  if (!current) throw new ServiceError('Visit not found', 404)
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('service_visits')
    .update({
      service: v.service,
      area: v.area,
      visit_date: v.visit_date,
      next_visit: v.next_visit,
      comment: v.comment,
      images: ownImages(v.images, accountId),
      updated_at: now,
    })
    .eq('id', visitId)
    .eq('account_id', accountId)
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  await db
    .from('service_customers')
    .update({ name: v.customer_name, ...(v.area ? { area: v.area } : {}), updated_at: now })
    .eq('id', current.customer_id)
    .eq('account_id', accountId)
  return toVisit(data as Record<string, unknown>)
}

/** Hide a visit; its reminders stop. */
export async function removeServiceVisit(db: SupabaseClient, accountId: string, visitId: string): Promise<boolean> {
  const { data, error } = await db
    .from('service_visits')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', visitId)
    .eq('account_id', accountId)
    .select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}

/** Hide a customer; every reminder for them stops at once. */
export async function removeServiceCustomer(db: SupabaseClient, accountId: string, customerId: string): Promise<boolean> {
  const { data, error } = await db
    .from('service_customers')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('account_id', accountId)
    .select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}

// ------------------------------------------------------------
// Reminders (called by the 15-minute scheduler)
// ------------------------------------------------------------

const MAX_PER_RUN = 60
const PAUSE_MS = 1000

/**
 * Send the reminders that have come due: the day before and on the day
 * of each next visit, from the business's reminder time on. A visit is
 * claimed first (its marker set in one conditional UPDATE), so two
 * overlapping runs can never remind the same customer twice.
 */
export async function runServiceReminders(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ due: number; sent: number; failed: number }> {
  // A day either side of UTC covers every time zone; the exact day is
  // decided per number below.
  const utcDay = now.toISOString().slice(0, 10)
  const { data, error } = await db
    .from('service_visits')
    .select('*, customer:service_customers(id, contact_id, channel_id, name, status)')
    .eq('status', 'active')
    .gte('next_visit', addDays(utcDay, -1))
    .lte('next_visit', addDays(utcDay, 2))
    .order('next_visit', { ascending: true })
    .limit(2000)
  if (error) throw new Error(error.message)

  type Row = ServiceVisit & {
    account_id: string
    customer: Pick<ServiceCustomer, 'id' | 'contact_id' | 'channel_id' | 'name' | 'status'> | null
  }
  const settingsByChannel = new Map<string, ServiceSettings | null>()
  let due = 0
  let sent = 0
  let failed = 0

  for (const row of (data ?? []) as Row[]) {
    if (sent + failed >= MAX_PER_RUN) break
    if (!row.customer || row.customer.status !== 'active') continue
    let settings = settingsByChannel.get(row.channel_id)
    if (settings === undefined) {
      settings = await loadServiceSettings(db, row.account_id, row.channel_id)
      settingsByChannel.set(row.channel_id, settings)
    }
    if (!settings) continue
    const kind: ServiceMessageKind | null = reminderDue(row, localDay(now, settings.timezone), settings.reminder_time)
    if (!kind) continue
    due++

    const mark = kind === 'due_today' ? 'rem0' : 'rem1'
    const { data: claimed } = await db
      .from('service_visits')
      .update({ [`${mark}_sent_for`]: row.next_visit, [`${mark}_sent_at`]: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'active')
      .eq('next_visit', row.next_visit)
      .or(`${mark}_sent_for.is.null,${mark}_sent_for.neq.${row.next_visit}`)
      .select('id')
    if (!claimed || claimed.length === 0) continue

    try {
      await sendToCustomer(
        db,
        row.account_id,
        row.customer,
        serviceMessage(kind, settings, {
          customerName: row.customer.name,
          service: row.service,
          visitDate: row.visit_date,
          nextVisit: row.next_visit,
        }),
        null,
      )
      sent++
    } catch (err) {
      failed++
      // The marker stays set: a number that is logged out must not make
      // the same reminder go out again and again every 15 minutes.
      await db.from('service_visits').update({ message_error: short(err) }).eq('id', row.id)
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
  }
  return { due, sent, failed }
}
