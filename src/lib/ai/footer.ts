// ============================================================
// The line at the bottom of every message the AI sends on its own, so
// the customer always knows an assistant wrote it:
//
//   _AI Powered_
//
// The underscores are WhatsApp's italics, so the customer sees the line
// in italic type. It carries no business name.
//
// Added to automatic replies only — the AI agent and the appointment
// assistant. A draft an agent reviews and sends, and the portal's own
// appointment messages, are the business speaking and carry no footer.
//
// The footer is removed again before a past message is shown to the
// model, so it never learns to write one itself (which would double it).
// ============================================================

export const AI_FOOTER_LABEL = 'AI Powered'

/** The footer text: the same on every number. */
export function aiFooter(): string {
  return `_${AI_FOOTER_LABEL}_`
}

// A footer line at the very end of a message: today's italic
// "AI Powered" form, the form with a business name after it, and the
// "AI Assistant" form sent before those.
const FOOTER_AT_END = /(?:\r?\n)+[ \t]*_?(?:AI Powered|AI Assistant)(?: ?- ?[^\r\n]*?)?_?[ \t]*$/

/** A message without its footer (unchanged when it has none). */
export function stripAiFooter(text: string): string {
  return text.replace(FOOTER_AT_END, '').trimEnd()
}

/** Put the footer under a reply, once. */
export function withAiFooter(text: string, footer: string): string {
  const body = stripAiFooter(text)
  return body ? `${body}\n\n${footer}` : footer
}
