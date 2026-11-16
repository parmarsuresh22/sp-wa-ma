// Meta Cloud API sender — a thin wrapper over the existing meta-api
// functions so the send paths can treat every channel alike.

import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  sendTypingIndicator,
} from '@/lib/whatsapp/meta-api'
import type {
  ChannelSender,
  SendInteractiveArgs,
  SendMediaArgs,
  SendReactionArgs,
  SendResult,
  SendTemplateArgs,
  SendTextArgs,
  TypingArgs,
} from './types'

export interface MetaSenderConfig {
  channelId: string
  phoneNumberId: string
  accessToken: string
}

export function createMetaSender(cfg: MetaSenderConfig): ChannelSender {
  const { channelId, phoneNumberId, accessToken } = cfg
  return {
    provider: 'meta',
    channelId,
    capabilities: {
      templates: true,
      interactive: true,
      reactions: true,
      typing: true,
      variantRetry: true,
    },
    async sendText(args: SendTextArgs): Promise<SendResult> {
      const r = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendMedia(args: SendMediaArgs): Promise<SendResult> {
      const r = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendInteractive(args: SendInteractiveArgs): Promise<SendResult> {
      const p = args.payload
      if (p.kind === 'buttons') {
        const r = await sendInteractiveButtons({
          phoneNumberId,
          accessToken,
          to: args.to,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId: args.contextMessageId,
        })
        return { messageId: r.messageId }
      }
      const r = await sendInteractiveList({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId: args.contextMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
      const r = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        messageParams: args.messageParams,
        params: args.params,
        contextMessageId: args.contextMessageId,
      })
      return { messageId: r.messageId }
    },
    async sendReaction(args: SendReactionArgs): Promise<void> {
      await sendReactionMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        targetMessageId: args.targetMessageId,
        emoji: args.emoji,
      })
    },
    async markReadAndTyping(args: TypingArgs): Promise<void> {
      await sendTypingIndicator({
        phoneNumberId,
        accessToken,
        messageId: args.inboundMessageId,
      })
    },
  }
}
