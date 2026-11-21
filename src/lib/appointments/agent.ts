// ============================================================
// The appointment step of the reply chain (migration 073).
//
//   Appointment  →  AI agent  →  human
//
// Each incoming message is offered to the steps in that order and the
// first one that takes it sends the only reply, so the customer never
// gets two answers to one message. A step that is switched off is
// skipped.
//
// How a message like "aaj dophar 3 bje ka appointment" is understood:
// the model (the account's own key) is told the business's current date,
// time and timezone and is given a small set of *actions*. It never
// decides anything itself — it asks the portal "is 2026-11-21 15:00
// free?", "book it", "cancel mine", and words the portal's answer in
// the customer's language. The portal owns every rule: working hours,
// places per slot, one live appointment per phone number.
//
// The customer's phone number is taken from the WhatsApp number the
// message arrived from and is never an argument of any action, so
// nobody can ask about, or change, someone else's appointment.
//
// Server-only. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { AI_CONDUCT_RULES } from '@/lib/ai/defaults'
import { aiFooter, withAiFooter } from '@/lib/ai/footer'
import { buildHandoffSummary } from '@/lib/ai/handoff'
import { logAiUsage } from '@/lib/ai/usage'
import { GEMINI_OPENAI_COMPAT_URL, normalizeForGemini } from '@/lib/ai/providers/gemini'
import { mergeConsecutive, normalizeUsage } from '@/lib/ai/providers/shared'
import type { AiConfig, AiUsage, ChatMessage } from '@/lib/ai/types'
import { engineSendText } from '@/lib/flows/meta-send'
import { phoneKey } from '@/lib/data-tables/lookup'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  AppointmentError,
  bookAppointment,
  cancelAppointment,
  cleanDetails,
  checkSlot,
  liveAppointment,
  loadAppointmentSettings,
  pastAppointments,
  slotsForDate,
  type AppointmentRow,
  type SlotState,
} from './service'
import {
  DATE_RE,
  REPLY_LANGUAGES,
  TIME_RE,
  describeHours,
  formatDay,
  formatTime,
  localParts,
  type AppointmentSettings,
} from './time'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_STEPS = 5
const TIMEOUT_MS = 25_000

/** Providers whose key can run actions (OpenAI-style tool calls). */
export function supportsAppointmentActions(provider: AiConfig['provider']): boolean {
  return provider === 'gemini' || provider === 'openai'
}

// ------------------------------------------------------------
// The actions
// ------------------------------------------------------------

const dateTimeParams = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'Calendar date in the business timezone, YYYY-MM-DD' },
    time: { type: 'string', description: '24-hour time in the business timezone, HH:MM' },
  },
  required: ['date', 'time'],
}
const noParams = { type: 'object', properties: {} }

export const APPOINTMENT_TOOLS = [
  {
    name: 'get_my_appointments',
    description:
      "The customer's own upcoming appointment (if any) and their latest 3 past visits with treatment and medicine notes.",
    parameters: noParams,
  },
  {
    name: 'check_slot',
    description:
      'Check whether a date and time is free. When it is not, the answer lists up to 3 free alternatives. Always call this before offering or booking a time.',
    parameters: dateTimeParams,
  },
  {
    name: 'list_free_slots',
    description: 'All free times on one date. Use when the customer asks what is available on a day.',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD in the business timezone' } },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book a new appointment. Only call after check_slot said the time is free AND the customer clearly agreed to that exact date and time. Pass what the customer told you about their requirements, their address and any other question you were told to ask.',
    parameters: {
      type: 'object',
      properties: {
        ...dateTimeParams.properties,
        requirements: { type: 'string', description: 'What the customer needs, in their own words' },
        address: { type: 'string', description: "The customer's address" },
        answers: {
          type: 'array',
          description: 'One entry per extra question you were told to ask',
          items: {
            type: 'object',
            properties: { question: { type: 'string' }, answer: { type: 'string' } },
            required: ['question', 'answer'],
          },
        },
      },
      required: ['date', 'time'],
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      "Move the customer's upcoming appointment to a new date and time. Only call after check_slot said the new time is free AND the customer clearly agreed.",
    parameters: dateTimeParams,
  },
  {
    name: 'cancel_appointment',
    description: "Cancel the customer's upcoming appointment. Only call after the customer clearly asked to cancel.",
    parameters: noParams,
  },
  {
    name: 'not_about_appointments',
    description:
      'The latest message is a question or request that has nothing to do with appointments (prices, products, complaints, anything else). Call this instead of answering it.',
    parameters: noParams,
  },
  {
    name: 'ask_for_human',
    description: 'The customer asks for a person, is upset, or needs something these actions cannot do.',
    parameters: noParams,
  },
] as const

type ToolName = (typeof APPOINTMENT_TOOLS)[number]['name']

function slotView(s: SlotState, settings: AppointmentSettings) {
  return {
    date: s.date,
    time: s.time,
    day: formatDay(s.startsAt, settings.timezone),
    time_12h: formatTime(s.startsAt, settings.timezone),
    places_left: s.left,
  }
}

function apptView(a: AppointmentRow, settings: AppointmentSettings) {
  const at = new Date(a.starts_at)
  const local = localParts(at, settings.timezone)
  return {
    date: local.date,
    time: local.time,
    day: formatDay(at, settings.timezone),
    time_12h: formatTime(at, settings.timezone),
    status: a.status === 'pending' ? 'waiting_for_the_business_to_confirm' : a.status,
    treatment: a.treatment,
    medicine: a.medicine,
    notes: a.notes,
  }
}

export interface ToolContext {
  db: SupabaseClient
  settings: AppointmentSettings
  contactId: string
  conversationId: string
  /** From the sender's WhatsApp number — never from the model. */
  phoneKey: string
  customerName: string | null
  now: Date
}

/**
 * Run one action. The result is plain data the model then words for the
 * customer; a refusal is data too (`ok: false` with the reason), never
 * an exception, so the model can explain it.
 */
export async function runAppointmentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { db, settings, now } = ctx
  const date = typeof args.date === 'string' ? args.date.trim() : ''
  const time = typeof args.time === 'string' ? args.time.trim().slice(0, 5) : ''
  const badDateTime = () => ({ ok: false, error: 'Give date as YYYY-MM-DD and time as HH:MM (24-hour).' })

  try {
    switch (name as ToolName) {
      case 'get_my_appointments': {
        const [live, past] = await Promise.all([
          liveAppointment(db, settings.channel_id, ctx.phoneKey, now),
          pastAppointments(db, settings.channel_id, ctx.phoneKey, now, 3),
        ])
        return {
          ok: true,
          upcoming: live ? apptView(live, settings) : null,
          past_visits: past.map((a) => apptView(a, settings)),
          address: settings.address,
        }
      }
      case 'check_slot': {
        if (!DATE_RE.test(date) || !TIME_RE.test(time)) return badDateTime()
        const live = await liveAppointment(db, settings.channel_id, ctx.phoneKey, now)
        const check = await checkSlot(db, settings, date, time, now, live?.id)
        return {
          ok: true,
          available: check.available,
          reason: check.reason ?? null,
          slot: check.slot && check.available ? slotView(check.slot, settings) : null,
          alternatives: check.alternatives.map((s) => slotView(s, settings)),
          customer_already_has_upcoming: live ? apptView(live, settings) : null,
        }
      }
      case 'list_free_slots': {
        if (!DATE_RE.test(date)) return { ok: false, error: 'Give date as YYYY-MM-DD.' }
        const slots = (await slotsForDate(db, settings, date, now)).filter((s) => s.free)
        return { ok: true, date, free: slots.slice(0, 40).map((s) => slotView(s, settings)) }
      }
      case 'book_appointment':
      case 'reschedule_appointment': {
        if (!DATE_RE.test(date) || !TIME_RE.test(time)) return badDateTime()
        const live = await liveAppointment(db, settings.channel_id, ctx.phoneKey, now)
        if (name === 'reschedule_appointment' && !live) {
          return { ok: false, error: 'no_upcoming_appointment' }
        }
        if (name === 'book_appointment' && live) {
          return {
            ok: false,
            error: 'has_live_appointment',
            upcoming: apptView(live, settings),
            hint: 'Only one upcoming appointment per phone number. Offer to move or cancel the existing one.',
          }
        }
        const row = await bookAppointment(db, {
          settings,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          phoneKey: ctx.phoneKey,
          customerName: ctx.customerName,
          date,
          time,
          source: 'ai',
          createdBy: null,
          replaceId: name === 'reschedule_appointment' ? live?.id : null,
          // With "confirmation required" a chat booking is a request:
          // it holds the slot but the business has the last word. A
          // moved booking goes back to waiting too.
          status: settings.confirm_required ? 'pending' : 'booked',
          details: name === 'book_appointment' ? cleanDetails(args) : undefined,
          now,
        })
        return {
          ok: true,
          needs_business_confirmation: row.status === 'pending',
          booked: apptView(row, settings),
          business_name: settings.business_name,
          address: settings.address,
        }
      }
      case 'cancel_appointment': {
        const live = await liveAppointment(db, settings.channel_id, ctx.phoneKey, now)
        if (!live) return { ok: false, error: 'no_upcoming_appointment' }
        const cancelled = await cancelAppointment(db, settings.account_id, live.id)
        return cancelled
          ? { ok: true, cancelled: apptView(cancelled, settings) }
          : { ok: false, error: 'no_upcoming_appointment' }
      }
      default:
        return { ok: false, error: 'unknown_action' }
    }
  } catch (err) {
    if (err instanceof AppointmentError) {
      // The slot went while the customer was deciding: say what is free.
      if (DATE_RE.test(date) && TIME_RE.test(time) && err.code !== 'has_live_appointment') {
        const check = await checkSlot(db, settings, date, time, now).catch(() => null)
        return {
          ok: false,
          error: err.code,
          alternatives: (check?.alternatives ?? []).map((s) => slotView(s, settings)),
        }
      }
      return { ok: false, error: err.code }
    }
    return { ok: false, error: 'temporary_problem' }
  }
}

// ------------------------------------------------------------
// The conversation with the model
// ------------------------------------------------------------

export function appointmentSystemPrompt(
  settings: AppointmentSettings,
  now: Date,
  customerName: string | null,
  /** Another responder (the AI agent) will answer what is not about appointments. */
  othersWillAnswer = true,
): string {
  const local = localParts(now, settings.timezone)
  const business = settings.business_name?.trim() || 'this business'
  return [
    `You are the appointment assistant of ${business} on WhatsApp.`,
    `Current date and time at the business: ${formatDay(now, settings.timezone)}, ${local.time} (24-hour), date ${local.date}, timezone ${settings.timezone}. Work out "today", "tomorrow", "kal", "parso", weekday names and times like "dophar 3 bje" from this.`,
    `Working hours: ${describeHours(settings.hours)}. Appointments are ${settings.slot_minutes} minutes long and can be booked up to ${settings.days_ahead} days ahead.`,
    settings.address ? `Address: ${settings.address}` : '',
    customerName ? `The customer's saved name is ${customerName}.` : '',
    '',
    'What you can do: show the customer their own upcoming appointment and their latest 3 visits (treatment, medicine), book a new appointment, move it, or cancel it. One phone number may hold only one upcoming appointment.',
    '',
    'Rules:',
    REPLY_LANGUAGES[settings.reply_language]
      ? `- Always reply in ${REPLY_LANGUAGES[settings.reply_language]}, whatever language the customer writes in (you still understand every language). Keep replies short and friendly, like a WhatsApp message. No markdown.`
      : '- Reply in the same language and script the customer writes in (Hindi, Hinglish, English, or any other). Keep replies short and friendly, like a WhatsApp message. No markdown.',
    '- Never guess availability. Call check_slot (or list_free_slots) and use only what it returns. Never invent times, appointments, treatments or medicines.',
    '- Before booking, moving or cancelling, state the full date and time and get a clear yes from the customer. Then call the action. Only say it is booked, moved or cancelled after the action returned ok: true.',
    settings.confirm_required
      ? '- This business confirms every booking itself. After book_appointment or reschedule_appointment returns ok, tell the customer their REQUEST for that day, date and time has been sent and that they will get a confirmation message here once the business approves it. Never say it is confirmed or booked. If their upcoming appointment has status waiting_for_the_business_to_confirm, say it is still waiting for confirmation.'
      : '- After booking or moving, confirm with the day, date, time and the address.',
    ...beforeBooking(settings),
    '- If a time is not free, offer the alternatives the action returned.',
    '- You only ever act for the person you are chatting with. If they give another phone number or ask about someone else, say you can only help with the number they are writing from.',
    '- Do not sign your messages or add an "AI Assistant" line; one is added for you.',
    '- Decide from the LATEST customer message; earlier messages are only background.',
    '- A greeting (hi, hello, namaste…) or an unclear message always gets a reply from you, even when earlier messages were about something else: introduce yourself in one or two lines and say what you can help with.',
    othersWillAnswer
      ? '- If the latest message is clearly about something other than appointments (prices, products, complaints…), call not_about_appointments and write nothing.'
      : '- If the latest message is clearly about something other than appointments (prices, products, complaints…), do NOT call not_about_appointments. Reply in one or two lines that you can only help with appointments here and that the team will answer that question soon. Never make up an answer to it.',
    '- If the customer asks for a person or needs something you cannot do, call ask_for_human and write nothing.',
    '- Every customer gets the same slots and the same service: availability comes only from the actions, never from who is asking.',
  ]
    .filter((line) => line !== '')
    .join('\n')
    .concat('\n\n', AI_CONDUCT_RULES)
}

/** What must be collected from the customer before book_appointment. */
function beforeBooking(settings: AppointmentSettings): string[] {
  const ask: string[] = []
  if (settings.ask_requirements) ask.push('what they need the appointment for (their requirements) → pass as "requirements"')
  if (settings.ask_address) ask.push('their address → pass as "address"')
  for (const q of settings.custom_questions) ask.push(`"${q}" → pass in "answers" with this exact question`)
  if (ask.length === 0) return []
  return [
    '- Before calling book_appointment you must have asked the customer for, and received an answer to, each of the following. Ask for whatever is still missing in one short message (not one message per question), then book:',
    ...ask.map((line) => `    • ${line}`),
  ]
}

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface CompletionMessage {
  role: 'assistant'
  content?: string | null
  tool_calls?: ToolCall[]
  [key: string]: unknown
}

export type AppointmentOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'pass' }
  | { kind: 'human' }

/**
 * Let the model work through the actions until it has a reply for the
 * customer, or decides the message is not for it.
 */
export async function runAppointmentAgent(args: {
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey'>
  systemPrompt: string
  messages: ChatMessage[]
  runTool: (name: string, toolArgs: Record<string, unknown>) => Promise<Record<string, unknown>>
  onUsage?: (usage: AiUsage | null) => void
}): Promise<AppointmentOutcome> {
  const { config } = args
  const gemini = config.provider === 'gemini'
  const url = gemini ? GEMINI_OPENAI_COMPAT_URL : OPENAI_URL
  const history = gemini ? normalizeForGemini(args.messages) : mergeConsecutive(args.messages)
  const thread: unknown[] = [{ role: 'system', content: args.systemPrompt }, ...history]
  const tools = APPOINTMENT_TOOLS.map((t) => ({ type: 'function', function: t }))

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: thread,
        tools,
        tool_choice: 'auto',
        ...(gemini ? { reasoning_effort: 'low' } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`appointment model call failed (${res.status}): ${detail.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: CompletionMessage }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    args.onUsage?.(
      normalizeUsage({
        prompt: data.usage?.prompt_tokens,
        completion: data.usage?.completion_tokens,
        total: data.usage?.total_tokens,
      }),
    )
    const message = data.choices?.[0]?.message
    if (!message) throw new Error('appointment model returned nothing')

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      const text = (message.content ?? '').trim()
      return text ? { kind: 'reply', text } : { kind: 'pass' }
    }
    if (calls.some((c) => c.function?.name === 'ask_for_human')) return { kind: 'human' }
    if (calls.some((c) => c.function?.name === 'not_about_appointments')) return { kind: 'pass' }

    // Echo the model's own turn back exactly as it came (Gemini attaches
    // data to it that must be returned), then answer every call.
    thread.push(message)
    for (const call of calls) {
      let parsed: Record<string, unknown> = {}
      try {
        const raw = JSON.parse(call.function.arguments || '{}')
        if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>
      } catch {
        /* treated as no arguments */
      }
      const result = await args.runTool(call.function.name, parsed)
      thread.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  // Too many rounds without an answer: let a person look at it.
  return { kind: 'human' }
}

// ------------------------------------------------------------
// The chain step
// ------------------------------------------------------------

export interface AppointmentDispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  channelId?: string | null
  inboundMessageId?: string
}

/**
 * Will the AI agent answer this conversation if we pass? Not when it is
 * off, pinned to another number, or has used up its replies for this
 * chat — passing to it then would leave the customer with no answer.
 */
export function aiAgentWillAnswer(
  config: Pick<AiConfig, 'isActive' | 'autoReplyEnabled' | 'channelId' | 'autoReplyMaxPerConversation'>,
  channelId: string | null,
  aiReplyCount: number,
): boolean {
  if (!config.isActive || !config.autoReplyEnabled) return false
  if (config.channelId && config.channelId !== channelId) return false
  if (aiReplyCount >= config.autoReplyMaxPerConversation) return false
  return true
}

async function handToHuman(
  db: SupabaseClient,
  conversationId: string,
  config: AiConfig,
  messages: ChatMessage[],
): Promise<void> {
  const summary = buildHandoffSummary({ messages, replyCount: 0 }).replace(
    'AI agent handed off',
    'Appointment assistant handed off',
  )
  await db
    .from('conversations')
    .update({ ai_autoreply_disabled: true, ai_handoff_summary: summary })
    .eq('id', conversationId)
  if (config.handoffAgentId) {
    await db
      .from('conversations')
      .update({ assigned_agent_id: config.handoffAgentId })
      .eq('id', conversationId)
      .is('assigned_agent_id', null)
  }
}

/**
 * Offer an inbound message to the appointment step.
 *
 * `consumed: true`  — this step answered (or handed the chat to a
 *                     person); nothing else may reply to this message.
 * `consumed: false` — not ours: the AI agent step runs next.
 */
export async function dispatchInboundToAppointments(
  args: AppointmentDispatchArgs,
): Promise<{ consumed: boolean }> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId } = args
  const channelId = args.channelId ?? null
  if (!channelId) return { consumed: false }

  try {
    const db = supabaseAdmin()

    const settings = await loadAppointmentSettings(db, accountId, channelId)
    if (!settings.id || !settings.enabled) return { consumed: false }

    // Appointment uses the saved AI key even when the AI agent itself
    // is switched off — that switch is about general questions.
    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (!config || !supportsAppointmentActions(config.provider)) return { consumed: false }

    // A user-built auto-responder on this number answers every message;
    // stand down rather than double-reply (same rule as the AI agent).
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
    if (!conv) return { consumed: false }
    // A person owns this chat (or automation was paused here): stay silent.
    if (conv.assigned_agent_id || conv.ai_autoreply_disabled) return { consumed: false }

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    const key = phoneKey((contact as { phone?: string | null } | null)?.phone)
    if (!key) return { consumed: false }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return { consumed: false }

    const limit = checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
    if (!limit.success) return { consumed: false }

    const now = new Date()
    const customerName = (contact as { name?: string | null } | null)?.name?.trim() || null
    const agentAnswers = aiAgentWillAnswer(
      config,
      channelId,
      (conv as { ai_reply_count?: number | null }).ai_reply_count ?? 0,
    )
    const outcome = await runAppointmentAgent({
      config,
      systemPrompt: appointmentSystemPrompt(settings, now, customerName, agentAnswers),
      messages,
      runTool: (name, toolArgs) =>
        runAppointmentTool(name, toolArgs, {
          db,
          settings,
          contactId,
          conversationId,
          phoneKey: key,
          customerName,
          now,
        }),
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

    if (outcome.kind === 'pass') {
      if (agentAnswers) return { consumed: false }
      // No AI agent to take it: the message waits in the inbox for a
      // person. The chat is NOT paused — one question about something
      // else must not stop the customer booking afterwards.
      return { consumed: true }
    }
    if (outcome.kind === 'human') {
      await handToHuman(db, conversationId, config, messages)
      return { consumed: true }
    }

    // The customer wrote again while we were working: that newer message
    // gets its own answer, so drop this one rather than send two.
    if (inboundMessageId) {
      const { data: latest } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
      if (latest?.[0] && latest[0].message_id !== inboundMessageId) return { consumed: true }
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      // Says who is speaking: "AI Assistant - <business name>".
      text: withAiFooter(outcome.text, aiFooter(settings.business_name)),
      aiGenerated: true,
    })
    return { consumed: true }
  } catch (err) {
    console.error('[appointments] dispatch failed:', err)
    return { consumed: false }
  }
}
