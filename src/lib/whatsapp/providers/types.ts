// ============================================================
// Outbound provider interface.
//
// One channel → one `ChannelSender`. The send paths (inbox composer,
// public API, engines, reactions, auto-reply) talk to this interface
// and never to Meta or WAHA directly, so adding a third transport is a
// new file here plus one `case` in `senderForChannel`.
//
// Capabilities tell callers what to refuse up front (templates and
// broadcasts on a bridge) and when the Meta-only phone-variant retry
// applies.
// ============================================================

import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import type { ChannelProvider } from '@/lib/whatsapp/channels'

export interface SenderCapabilities {
  /** Meta-approved templates (and therefore broadcasts). */
  templates: boolean
  /** Native reply buttons / lists. False → degraded to numbered text. */
  interactive: boolean
  reactions: boolean
  typing: boolean
  /**
   * Meta's sandbox rejects numbers that differ only in a trunk prefix
   * with "recipient not in allowed list"; the send core retries phone
   * variants on that error. A bridge has no such list.
   */
  variantRetry: boolean
}

export interface SendResult {
  /** Provider message id (Meta wamid, or WAHA's `true_<chat>_<id>`). */
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendInteractiveArgs {
  to: string
  payload: InteractiveMessagePayload
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language: string
  template?: MessageTemplate
  messageParams?: SendTimeParams
  params: string[]
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  targetMessageId: string
  /** Empty string removes the reaction. */
  emoji: string
}

export interface TypingArgs {
  to: string
  /** The inbound message being answered (Meta needs it; WAHA ignores it). */
  inboundMessageId: string
}

export interface ChannelSender {
  readonly provider: ChannelProvider
  readonly channelId: string
  readonly capabilities: SenderCapabilities
  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendInteractive(args: SendInteractiveArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<void>
  /** Best-effort read receipt + typing indicator. */
  markReadAndTyping(args: TypingArgs): Promise<void>
  /** Best-effort read receipt only (blue ticks for the customer). */
  markRead(args: TypingArgs): Promise<void>
}

/** Thrown when a caller asks a channel for something it cannot do. */
export class UnsupportedOnChannelError extends Error {
  readonly code = 'unsupported_on_channel'
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedOnChannelError'
  }
}

/**
 * Render reply buttons / a list as plain text for transports without
 * native interactive messages. The customer answers with a number or
 * the label; the inbound side matches either back to the option id.
 */
export function interactiveToText(payload: InteractiveMessagePayload): string {
  const lines: string[] = []
  if (payload.header?.trim()) lines.push(`*${payload.header.trim()}*`)
  lines.push(payload.body)
  lines.push('')
  const options = interactiveOptions(payload)
  options.forEach((opt, i) => {
    lines.push(
      opt.description ? `${i + 1}. ${opt.title} — ${opt.description}` : `${i + 1}. ${opt.title}`,
    )
  })
  if (payload.footer?.trim()) {
    lines.push('')
    lines.push(`_${payload.footer.trim()}_`)
  }
  return lines.join('\n')
}

export interface InteractiveOption {
  id: string
  title: string
  description?: string
}

/** Flatten buttons or list rows into one ordered option list. */
export function interactiveOptions(payload: InteractiveMessagePayload): InteractiveOption[] {
  if (payload.kind === 'buttons') {
    return payload.buttons.map((b) => ({ id: b.id, title: b.title }))
  }
  const out: InteractiveOption[] = []
  for (const section of payload.sections) {
    for (const row of section.rows) {
      out.push({ id: row.id, title: row.title, description: row.description })
    }
  }
  return out
}

/**
 * Map a typed reply ("2", "2.", "Existing customer") back to the option
 * it names on the last interactive prompt. Null when it matches none.
 */
export function matchInteractiveReply(
  payload: InteractiveMessagePayload,
  text: string,
): InteractiveOption | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const options = interactiveOptions(payload)
  const numeric = /^(\d{1,2})[.)]?$/.exec(trimmed)
  if (numeric) {
    const idx = Number.parseInt(numeric[1], 10) - 1
    return options[idx] ?? null
  }
  const lower = trimmed.toLowerCase()
  return (
    options.find((o) => o.title.trim().toLowerCase() === lower) ??
    options.find((o) => o.id.toLowerCase() === lower) ??
    null
  )
}
