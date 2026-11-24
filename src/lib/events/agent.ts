// ============================================================
// The event-pass step of the reply chain (migration 080).
//
//   Event passes  →  Appointment  →  AI agent  →  human
//
// Two jobs, both for the person who is writing and nobody else (the
// phone number comes from WhatsApp, never from the model):
//
// 1. Payment proof. A customer with a request waiting for payment
//    sends a picture (or types the 12-digit reference number). The
//    portal reads it, compares it with the order and either issues the
//    passes or puts the order in the approval queue. No model decides
//    anything here.
//
// 2. Asking for passes. Like the appointment step, the model is given
//    a few actions — list the events, request passes, show my passes,
//    cancel my request — and words the portal's answers. Places, prices
//    and limits are enforced by the database.
//
// Server-only. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { aiAgentWillAnswer, runAppointmentAgent, supportsAppointmentActions } from '@/lib/appointments/agent'
import { bold, loadAppointmentSettings } from '@/lib/appointments/service'
import { formatDay, localParts } from '@/lib/appointments/time'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { AI_CONDUCT_RULES } from '@/lib/ai/defaults'
import { loadAiFooter, withAiFooter } from '@/lib/ai/footer'
import { REPLY_LANGUAGES } from '@/lib/ai/languages'
import { logAiUsage } from '@/lib/ai/usage'
import { phoneKey } from '@/lib/data-tables/lookup'
import { engineSendText } from '@/lib/flows/meta-send'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { fetchProofImage, readPaymentScreenshot } from './proof'
import {
  EventError,
  closeOrder,
  eventWhen,
  issueOrder,
  loadEvent,
  loadStats,
  moveToReview,
  normalizeEvent,
  normalizeOrder,
  notifyReviewer,
  passesOfOrder,
  reserveOrder,
  sendEventText,
  sendPasses,
  sendPaymentRequest,
  unpaidOrder,
  type EventWithTypes,
  type TypeStats,
} from './service'
import { checkProof, money, referenceInText, type OrderRow, type ProofProblem } from './types'

const noParams = { type: 'object', properties: {} }

export const EVENT_TOOLS = [
  {
    name: 'list_events',
    description:
      'The events passes can be requested for right now: date, time, venue, and each pass type with its price and the places left. Call this before offering or requesting passes.',
    parameters: noParams,
  },
  {
    name: 'get_my_passes',
    description: "The customer's own requests and passes: event, pass type, how many, amount and where each request stands.",
    parameters: noParams,
  },
  {
    name: 'request_passes',
    description:
      'Request passes for the customer. Only call after the customer clearly said which event, which pass type and how many, and agreed to the total price. For a paid pass the portal then sends a payment QR; for a free pass it sends the passes.',
    parameters: {
      type: 'object',
      properties: {
        event_code: { type: 'string', description: 'The code of the event from list_events, like EV4K7Q' },
        pass_type_number: { type: 'integer', description: 'The number of the pass type from list_events' },
        quantity: { type: 'integer', description: 'How many passes (one per person)' },
        name: { type: 'string', description: "The name to put on the passes (the customer's name)" },
      },
      required: ['event_code', 'pass_type_number', 'quantity'],
    },
  },
  {
    name: 'cancel_my_request',
    description: "Cancel the customer's request that is still waiting for payment. Only call after the customer clearly asked to cancel it.",
    parameters: noParams,
  },
  {
    name: 'resend_my_passes',
    description: 'Send the customer their already issued pass QR pictures again (they lost or deleted them).',
    parameters: noParams,
  },
  {
    name: 'not_about_events',
    description:
      'The latest message has nothing to do with events or passes (appointments, prices of other things, complaints, anything else). Call this instead of answering it.',
    parameters: noParams,
  },
  {
    name: 'ask_for_human',
    description: 'The customer asks for a person, wants a refund, is upset, or needs something these actions cannot do.',
    parameters: noParams,
  },
] as const

interface Ctx {
  db: SupabaseClient
  accountId: string
  channelId: string
  contactId: string
  conversationId: string
  phoneKey: string
  customerName: string | null
  now: Date
  /** Pictures to send once the reply has gone out (payment QR, passes). */
  afterReply: (() => Promise<unknown>)[]
}

/** Events on this number a customer may ask passes for right now. */
async function openEvents(db: SupabaseClient, accountId: string, channelId: string, now: Date): Promise<EventWithTypes[]> {
  const { data } = await db
    .from('events')
    .select('*, pass_types:event_pass_types(*)')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .eq('status', 'open')
    .eq('chat_booking', true)
    .gt('starts_at', now.toISOString())
    .order('starts_at', { ascending: true })
    .limit(20)
  return ((data ?? []) as Record<string, unknown>[])
    .map(normalizeEvent)
    .filter((e) => !e.apply_until || Date.parse(e.apply_until) > now.getTime())
}

function eventView(event: EventWithTypes, stats: TypeStats[]) {
  const { day, time } = eventWhen(event)
  return {
    event_code: event.code,
    name: event.name,
    day,
    time,
    venue: event.venue,
    about: event.description,
    most_passes_per_phone_number: event.max_per_phone,
    pass_types: event.pass_types
      .filter((t) => t.active)
      .map((t) => {
        const held = stats.find((s) => s.pass_type_id === t.id)?.held ?? 0
        return {
          pass_type_number: t.position,
          name: t.name,
          price: t.price > 0 ? money(t.price) : 'free',
          places_left: Math.max(0, t.capacity - held),
        }
      }),
  }
}

const ORDER_STATUS_WORDS: Record<string, string> = {
  awaiting_payment: 'waiting_for_payment',
  review: 'payment_received_waiting_for_the_business_to_confirm',
  issued: 'passes_issued',
  rejected: 'payment_not_confirmed',
  cancelled: 'cancelled',
}

async function myOrders(ctx: Ctx): Promise<{ order: OrderRow; event: EventWithTypes }[]> {
  const { data } = await ctx.db
    .from('event_orders')
    .select('*')
    .eq('account_id', ctx.accountId)
    .eq('phone_key', ctx.phoneKey)
    .order('created_at', { ascending: false })
    .limit(10)
  const out: { order: OrderRow; event: EventWithTypes }[] = []
  const cache = new Map<string, EventWithTypes | null>()
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const order = normalizeOrder(raw)
    if (!cache.has(order.event_id)) cache.set(order.event_id, await loadEvent(ctx.db, ctx.accountId, order.event_id))
    const event = cache.get(order.event_id)
    // Only this number's events, and not ones long over.
    if (!event || event.channel_id !== ctx.channelId) continue
    if (Date.parse(event.starts_at) < ctx.now.getTime() - 24 * 3_600_000) continue
    out.push({ order, event })
  }
  return out
}

function orderView(order: OrderRow, event: EventWithTypes, now: Date) {
  const expired = order.status === 'awaiting_payment' && !!order.expires_at && Date.parse(order.expires_at) < now.getTime()
  return {
    order: order.code,
    event: event.name,
    ...eventWhen(event),
    pass_type: event.pass_types.find((t) => t.id === order.pass_type_id)?.name ?? null,
    quantity: order.quantity,
    amount: order.amount > 0 ? money(order.amount) : 'free',
    status: expired ? 'expired_not_paid_in_time' : ORDER_STATUS_WORDS[order.status],
  }
}

export async function runEventTool(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> {
  const { db, now } = ctx
  try {
    switch (name) {
      case 'list_events': {
        const events = await openEvents(db, ctx.accountId, ctx.channelId, now)
        const stats = await loadStats(db, ctx.accountId, events.map((e) => e.id))
        return { ok: true, events: events.map((e) => eventView(e, stats)) }
      }
      case 'get_my_passes': {
        const mine = await myOrders(ctx)
        return { ok: true, requests: mine.map(({ order, event }) => orderView(order, event, now)) }
      }
      case 'request_passes': {
        const code = typeof args.event_code === 'string' ? args.event_code.trim().toUpperCase() : ''
        const typeNumber = Number(args.pass_type_number)
        const quantity = Number(args.quantity)
        if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, error: 'Ask how many passes they need.' }
        const events = await openEvents(db, ctx.accountId, ctx.channelId, now)
        const event = events.find((e) => e.code === code)
        if (!event) return { ok: false, error: 'event_not_found', hint: 'Call list_events and use its event_code.' }
        const type = event.pass_types.find((t) => t.active && t.position === typeNumber)
        if (!type) return { ok: false, error: 'pass_type_not_found', hint: 'Call list_events and use its pass_type_number.' }
        if (quantity > event.max_per_phone) {
          return { ok: false, error: 'phone_limit', most_passes_per_phone_number: event.max_per_phone }
        }
        const holder = (typeof args.name === 'string' ? args.name.trim().slice(0, 80) : '') || ctx.customerName
        const order = await reserveOrder(db, {
          event,
          passTypeId: type.id,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          phoneKey: ctx.phoneKey,
          customerName: holder,
          quantity,
          source: 'ai',
          createdBy: null,
        })
        const base = { order: order.code, event: event.name, ...eventWhen(event), pass_type: type.name, quantity }
        if (order.amount <= 0) {
          const done = await issueOrder(db, order)
          if (!done) return { ok: false, error: 'temporary_problem' }
          ctx.afterReply.push(() => sendPasses(db, event, done.order, done.passes))
          return {
            ok: true,
            ...base,
            amount: 'free',
            passes_issued: true,
            note: 'The pass QR pictures are sent automatically right after your message - one picture per person. Do not describe or invent the QR.',
          }
        }
        ctx.afterReply.push(() => sendPaymentRequest(db, event, order))
        return {
          ok: true,
          ...base,
          amount: money(order.amount),
          waiting_for_payment: true,
          places_held_for_minutes: event.hold_minutes,
          note: 'A payment QR with the amount is sent automatically right after your message. Tell the customer to pay it and send the payment screenshot here; the passes are issued once the payment is confirmed. Do not write any UPI ID or link yourself.',
        }
      }
      case 'cancel_my_request': {
        const order = await unpaidOrder(db, ctx.accountId, ctx.phoneKey, now)
        if (!order) return { ok: false, error: 'no_request_waiting_for_payment' }
        const closed = await closeOrder(db, order, 'cancelled', null)
        return closed ? { ok: true, cancelled_order: order.code } : { ok: false, error: 'no_request_waiting_for_payment' }
      }
      case 'resend_my_passes': {
        const issued = (await myOrders(ctx)).filter(({ order }) => order.status === 'issued').slice(0, 2)
        if (issued.length === 0) return { ok: false, error: 'no_issued_passes' }
        for (const { order, event } of issued) {
          const passes = (await passesOfOrder(db, order.id)).filter((p) => p.status !== 'cancelled')
          if (passes.length > 0) ctx.afterReply.push(() => sendPasses(db, event, order, passes))
        }
        return { ok: true, note: 'The pass QR pictures are sent again right after your message.' }
      }
      default:
        return { ok: false, error: 'unknown_action' }
    }
  } catch (err) {
    if (err instanceof EventError) {
      return {
        ok: false,
        error: err.code,
        ...(err.code === 'sold_out' ? { places_left: Number(err.detail ?? 0) } : {}),
        ...(err.code === 'phone_limit' ? { more_passes_this_number_may_take: Number(err.detail ?? 0) } : {}),
        ...(err.code === 'has_unpaid_order'
          ? { unpaid_order: err.detail, hint: 'They must pay or cancel that request first.' }
          : {}),
      }
    }
    console.error('[events] action failed:', err)
    return { ok: false, error: 'temporary_problem' }
  }
}

export function eventSystemPrompt(args: {
  businessName: string | null
  now: Date
  timezone: string
  customerName: string | null
  events: ReturnType<typeof eventView>[]
  othersWillAnswer: boolean
  replyLanguage?: string | null
}): string {
  const local = localParts(args.now, args.timezone)
  const language = args.replyLanguage ? REPLY_LANGUAGES[args.replyLanguage] : null
  return [
    `You are the event pass assistant of ${args.businessName?.trim() || 'this business'} on WhatsApp.`,
    `Current date and time: ${formatDay(args.now, args.timezone)}, ${local.time} (24-hour), date ${local.date}, timezone ${args.timezone}.`,
    args.customerName ? `The customer's saved name is ${args.customerName}.` : '',
    '',
    'What you can do: tell the customer about the events below, request entry passes for them, show their own requests and passes, cancel a request that is not paid yet, and send their passes again.',
    '',
    `Events open for passes right now (call list_events for the latest places left): ${JSON.stringify(args.events)}`,
    '',
    'Rules:',
    language
      ? `- Always reply in ${language}, whatever language the customer writes in. Keep replies short and friendly, like a WhatsApp message.`
      : '- Reply in the same language and script the customer writes in (Hindi, Hinglish, English, or any other). Keep replies short and friendly, like a WhatsApp message.',
    '- Use only what the actions return. Never invent events, prices, places, passes, QR codes, UPI IDs or payment links.',
    '- Before request_passes you must know the event, the pass type, how many passes and the name for the pass. Ask for whatever is missing in one short message. State the total price (or that it is free) and get a clear yes, then call the action.',
    '- One pass admits one person. After request_passes returns ok: for a paid pass say a payment QR follows, they should pay and send the payment screenshot here; for a free pass say the pass QR pictures follow. Say a pass is issued only when the action said so.',
    '- If the customer says they have paid but sent no screenshot, ask them to send the payment screenshot or the 12-digit UPI reference number here.',
    '- You only ever act for the person you are chatting with. If they give another phone number or ask about someone else, say you can only help with the number they are writing from.',
    '- Refunds and changes to an issued pass are decided by the team: call ask_for_human.',
    '- Do not sign your messages or add an "AI Powered" line; one is added for you.',
    '- Put event names, dates, times and amounts in bold the WhatsApp way, with one asterisk on each side: *Saturday, 28 November 2026*, *7:00 pm*, *₹500*. Use no other formatting.',
    '- Decide from the LATEST customer message; earlier messages are only background.',
    args.othersWillAnswer
      ? '- If the latest message is not about events or passes (including a plain greeting when the earlier chat was not about events), call not_about_events and write nothing.'
      : '- A greeting or an unclear message gets a short reply from you saying what you can help with. If the latest message is clearly about something else, do NOT call not_about_events: reply in one or two lines that you can only help with event passes here and that the team will answer that question soon. Never make up an answer to it.',
    '- If the customer asks for a person or needs something you cannot do, call ask_for_human and write nothing.',
    '- Every customer gets the same prices and the same places: they come only from the actions, never from who is asking.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .concat('\n\n', AI_CONDUCT_RULES)
}

// ------------------------------------------------------------
// Payment proof
// ------------------------------------------------------------

/**
 * A customer with an unpaid request sent a picture or a reference
 * number. Returns true when it was dealt with (a reply went out).
 */
async function handlePaymentProof(args: {
  db: SupabaseClient
  event: EventWithTypes
  order: OrderRow
  mediaUrl: string | null
  typedReference: string | null
  now: Date
}): Promise<boolean> {
  const { db, event, order, now } = args
  const expired = !!order.expires_at && Date.parse(order.expires_at) < now.getTime()
  const label = `order ${order.code} (${order.quantity} x ${event.pass_types.find((t) => t.id === order.pass_type_id)?.name ?? 'pass'}, ${bold(event.name)})`
  const referenceUsed = () =>
    sendEventText(
      db,
      event,
      order,
      `This payment reference number was already used for another order, so it cannot be used for ${label}. Please send the screenshot of the payment made for this order.`,
    ).then(() => true)

  let problems: ProofProblem[]
  let reference: string | null
  let reading = null
  if (args.mediaUrl) {
    const config = await loadAiConfig(db, event.account_id, { requireActive: false }).catch(() => null)
    const image = config ? await fetchProofImage(args.mediaUrl) : null
    reading = config && image ? await readPaymentScreenshot(config, image) : null
    problems = checkProof(reading, {
      amount: order.amount,
      upiId: event.upi_id,
      upiName: event.upi_name,
      today: localParts(now, event.timezone).date,
    })
    if (problems.includes('not_payment')) {
      // A photo of something else. Only ask again while the request is live.
      if (expired) return false
      await sendEventText(
        db,
        event,
        order,
        `I could not see a payment in this picture. Please send the payment screenshot for ${label} showing the amount ${bold(money(order.amount))} and the reference number.`,
      )
      return true
    }
    reference = reading?.utr ?? null
  } else {
    reference = args.typedReference
    problems = ['typed_reference']
  }
  if (expired) problems.push('paid_late')
  const proof = { reading, problems, via: args.mediaUrl ? 'screenshot' : 'typed' }

  if (problems.length === 0 && event.auto_issue) {
    try {
      const done = await issueOrder(db, order, { patch: { payment_ref: reference, proof_url: args.mediaUrl, proof } })
      if (done) {
        await sendEventText(
          db,
          event,
          done.order,
          `Payment of ${bold(money(order.amount))} received for ${label}. Thank you! Your ${order.quantity === 1 ? 'pass follows' : 'passes follow'}.`,
        ).catch(() => undefined)
        await sendPasses(db, event, done.order, done.passes)
      }
      return true
    } catch (err) {
      if (err instanceof EventError && err.code === 'reference_used') return referenceUsed()
      throw err
    }
  }

  const moved = await moveToReview(db, order, { payment_ref: reference, proof_url: args.mediaUrl, proof })
  if (!moved) return referenceUsed()
  await sendEventText(
    db,
    event,
    order,
    `Thank you. We received your payment details for ${label}. Your ${order.quantity === 1 ? 'pass' : 'passes'} will be sent here as soon as the payment is confirmed.`,
  ).catch((err) => console.warn('[events] proof receipt not sent:', err instanceof Error ? err.message : err))
  await notifyReviewer(db, event, { ...order, status: 'review', payment_ref: reference, proof_url: args.mediaUrl, proof })
  return true
}

// ------------------------------------------------------------
// The chain step
// ------------------------------------------------------------

export interface EventDispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  channelId?: string | null
  inboundMessageId?: string
  text: string
  contentType: string
  mediaUrl: string | null
}

/**
 * Offer an inbound message to the event-pass step.
 * `consumed: true` — answered here; nothing else may reply to it.
 */
export async function dispatchInboundToEvents(args: EventDispatchArgs): Promise<{ consumed: boolean }> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId } = args
  const channelId = args.channelId ?? null
  if (!channelId) return { consumed: false }
  const text = args.text.trim()
  const isPicture = args.contentType === 'image' && !!args.mediaUrl
  if (!text && !isPicture) return { consumed: false }

  try {
    const db = supabaseAdmin()
    const now = new Date()

    // Most numbers run no event: one cheap look, then out of the way.
    const { data: anyEvent } = await db
      .from('events')
      .select('id')
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .neq('status', 'cancelled')
      .gt('starts_at', new Date(now.getTime() - 24 * 3_600_000).toISOString())
      .limit(1)
    if ((anyEvent ?? []).length === 0) return { consumed: false }

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    const key = phoneKey((contact as { phone?: string | null } | null)?.phone)
    if (!key) return { consumed: false }
    const customerName = (contact as { name?: string | null } | null)?.name?.trim() || null

    // 1. Payment proof for a request that is waiting for it.
    const typedReference = isPicture ? null : referenceInText(text)
    if (isPicture || typedReference) {
      const order = await unpaidOrder(db, accountId, key, now)
      const event = order ? await loadEvent(db, accountId, order.event_id) : null
      if (order && event && event.channel_id === channelId) {
        const handled = await handlePaymentProof({
          db,
          event,
          order: order.conversation_id ? order : { ...order, conversation_id: conversationId },
          mediaUrl: isPicture ? args.mediaUrl : null,
          typedReference,
          now,
        })
        if (handled) return { consumed: true }
      }
    }
    if (!text) return { consumed: false }

    // 2. Asking for passes.
    const events = await openEvents(db, accountId, channelId, now)
    const ctx: Ctx = { db, accountId, channelId, contactId, conversationId, phoneKey: key, customerName, now, afterReply: [] }
    if (events.length === 0 && (await myOrders(ctx)).length === 0) return { consumed: false }

    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (!config || !supportsAppointmentActions(config.provider)) return { consumed: false }

    // Same stand-down rules as the appointment step.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id, channel_id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
    const competing = ((autoResponders ?? []) as { channel_id?: string | null }[]).filter(
      (a) => !a.channel_id || a.channel_id === channelId,
    )
    if (competing.length > 0) return { consumed: false }

    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv || conv.assigned_agent_id || conv.ai_autoreply_disabled) return { consumed: false }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return { consumed: false }

    const limit = checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
    if (!limit.success) return { consumed: false }

    const appointmentSettings = await loadAppointmentSettings(db, accountId, channelId)
    const othersWillAnswer =
      (!!appointmentSettings.id && appointmentSettings.enabled) ||
      aiAgentWillAnswer(config, channelId, (conv as { ai_reply_count?: number | null }).ai_reply_count ?? 0)
    const stats = await loadStats(db, accountId, events.map((e) => e.id))

    const outcome = await runAppointmentAgent({
      config,
      tools: EVENT_TOOLS,
      passTool: 'not_about_events',
      systemPrompt: eventSystemPrompt({
        businessName: appointmentSettings.business_name,
        now,
        timezone: events[0]?.timezone ?? appointmentSettings.timezone ?? 'Asia/Kolkata',
        customerName,
        events: events.map((e) => eventView(e, stats)),
        othersWillAnswer,
        replyLanguage: config.replyLanguage,
      }),
      messages,
      runTool: (name, toolArgs) => runEventTool(name, toolArgs, ctx),
      onUsage: (usage) =>
        void logAiUsage(db, {
          accountId,
          conversationId,
          mode: 'auto_reply',
          provider: config.provider,
          model: config.model,
          usage,
        }),
    })

    if (outcome.kind === 'pass') return { consumed: !othersWillAnswer }
    if (outcome.kind === 'human') {
      // Leave it for a person; the later steps decide whether to pause.
      return { consumed: false }
    }

    // A newer message from the customer gets its own answer — but what
    // this one already did (a request made) must still be followed up.
    let superseded = false
    if (inboundMessageId) {
      const { data: latest } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
      superseded = !!latest?.[0] && latest[0].message_id !== inboundMessageId
    }
    if (!superseded || ctx.afterReply.length > 0) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: withAiFooter(outcome.text, await loadAiFooter(db, accountId, channelId)),
        aiGenerated: true,
      })
    }
    for (const job of ctx.afterReply) await job()
    return { consumed: true }
  } catch (err) {
    console.error('[events] dispatch failed:', err)
    return { consumed: false }
  }
}
