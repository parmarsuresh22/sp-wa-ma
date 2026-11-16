import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  deliverViaChannel,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  touchConversation,
} from '@/lib/flows/meta-send'
import {
  resolveTemplateRow,
  templateContentText,
  templateHeaderMediaUrl,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Automation-side sender.
//
// Uses the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has on
// hand. Delivery (contact + conversation scoping, channel resolution,
// Meta phone-variant retry) is shared with the Flows engine in
// src/lib/flows/meta-send.ts; this file owns the text/template
// persistence shape.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Local template row. A missing row is fine: the send still goes
  // out, we just can't reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  // Account-scoped contact + conversation checks, channel resolution,
  // Meta phone-variant retry and contact auto-correct all live in the
  // shared engine core (flows/meta-send.ts).
  const { messageId: waMessageId, sender } = await deliverViaChannel(
    db,
    input,
    async (s, to) => {
      if (input.kind === 'template') {
        if (!s.capabilities.templates) {
          throw new Error(t('send.templatesUnsupportedOnChannel'))
        }
        const r = await s.sendTemplate({
          to,
          templateName: input.templateName,
          language: input.language ?? 'en_US',
          template: templateRow ?? undefined,
          params: input.params ?? [],
        })
        return r.messageId
      }
      const r = await s.sendText({ to, text: input.text })
      return r.messageId
    },
  )

  // Persist the sent message so it appears in the inbox with a real
  // provider message id. sender_type='bot' distinguishes automation
  // sends from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  // Templates persist the substituted body, same as the manual and
  // public-API send paths. This was unconditionally null, so every
  // automation template send rendered as an empty bubble (issue #483).
  const content_text =
    input.kind === 'text'
      ? input.text
      : templateContentText(templateRow, input.params ?? [])
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    media_url: templateHeaderMediaUrl(templateRow),
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // The provider already has the message; record the DB error but
    // don't pretend the send failed. The engine wraps this in a log line.
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await touchConversation(
    db,
    input,
    input.kind === 'template'
      ? (content_text ?? `[template:${input.templateName}]`)
      : input.text,
    sender.channelId,
  )

  return { whatsapp_message_id: waMessageId }
}
