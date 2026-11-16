import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type {
  InteractiveButton,
  InteractiveListSection,
  InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive'
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope'
import { loadChannelForConversation } from '@/lib/whatsapp/channels'
import { senderForChannel, type ChannelSender } from '@/lib/whatsapp/providers'
import { supabaseAdmin } from './admin-client'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Flows-side sender.
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits text, media and interactive button +
// list messages. Every send resolves the *conversation's channel*
// (`@/lib/whatsapp/channels`) and goes through that channel's provider
// — Meta Cloud API or a WAHA bridge — so a flow authored once runs the
// same on every number the account has connected.
// ------------------------------------------------------------

/**
 * Resolve the sender for a conversation: its own channel, else the
 * account default. Throws the engines' "not configured" error when the
 * account has no channel at all. Also used by the AI auto-reply's
 * typing indicator.
 */
export async function loadConversationSender(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  conversationId: string,
): Promise<ChannelSender> {
  const channel = await loadChannelForConversation(db, accountId, conversationId)
  if (!channel) {
    throw new Error(t('send.notConfigured'))
  }
  return senderForChannel(channel)
}

export interface EngineTarget {
  accountId: string
  conversationId: string
  contactId: string
}

/**
 * Shared delivery core for every engine send: account-scoped contact +
 * conversation checks, channel resolution, the Meta-only phone-variant
 * retry, and the contact phone auto-correct. `build` performs the
 * provider call for one recipient spelling and returns the message id.
 */
export async function deliverViaChannel(
  db: ReturnType<typeof supabaseAdmin>,
  target: EngineTarget,
  build: (sender: ChannelSender, to: string) => Promise<string>,
): Promise<{ messageId: string; sender: ChannelSender }> {
  // Scope the contact lookup by account_id — the engine uses the
  // service-role client (bypassing RLS); without this filter an
  // authenticated user could fire their own automations against another
  // tenant's contact UUID. Migration 017 moved to account tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', target.contactId)
    .eq('account_id', target.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error(t('send.contactNotFound'))
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, target.conversationId, target.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const sanitized = sendTarget.target

  const sender = await loadConversationSender(db, target.accountId, target.conversationId)

  // Phone-variant retry: Meta's sandbox + numbers registered with/
  // without a trunk 0 both need it. A bridge has no allow-list.
  const variants =
    sendTarget.isPhone && sender.capabilities.variantRetry
      ? phoneVariants(sanitized)
      : [sanitized]
  let workingPhone = sanitized
  let messageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      messageId = await build(sender, v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  return { messageId, sender }
}

export async function touchConversation(
  db: ReturnType<typeof supabaseAdmin>,
  target: EngineTarget,
  preview: string,
  channelId: string,
): Promise<void> {
  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', target.conversationId)
    .eq('account_id', target.accountId)
  // Adopt a pre-061 thread onto the channel it just went out on.
  await db
    .from('conversations')
    .update({ channel_id: channelId })
    .eq('id', target.conversationId)
    .is('channel_id', null)
}

interface SendTextEngineArgs extends EngineTarget {
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { messageId, sender } = await deliverViaChannel(db, args, async (s, to) => {
    const r = await s.sendText({ to, text: args.text })
    return r.messageId
  })

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: messageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await touchConversation(db, args, args.text, sender.channelId)

  return { whatsapp_message_id: messageId }
}

interface SendMediaEngineArgs extends EngineTarget {
  userId: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Persists the
 * outgoing message with `content_type` matching the media kind so the
 * inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { messageId, sender } = await deliverViaChannel(db, args, async (s, to) => {
    const r = await s.sendMedia({
      to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  })

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    media_url: args.link,
    message_id: messageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await touchConversation(db, args, preview, sender.channelId)

  return { whatsapp_message_id: messageId }
}

interface SendInteractiveButtonsEngineArgs extends EngineTarget {
  userId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs extends EngineTarget {
  userId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the provider message id so the caller (engine) can stash it
 * on the `flow_runs.last_prompt_message_id` field for later reference.
 *
 * On a WhatsApp Web channel (no native buttons) the provider renders
 * the options as a numbered list; the inbound side maps a typed "2" or
 * the label back to the option id, so flows keep working.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaChannel({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaChannel({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaChannel(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { messageId, sender } = await deliverViaChannel(db, input, async (s, to) => {
    const r = await s.sendInteractive({ to, payload: interactivePayload })
    return r.messageId
  })

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends.
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths — and so a
  // bridge channel can match a typed "2" back to the second option.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: messageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await touchConversation(db, input, input.bodyText, sender.channelId)

  return { whatsapp_message_id: messageId }
}
