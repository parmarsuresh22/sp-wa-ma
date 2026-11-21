// ============================================================
// The line at the bottom of every message the AI sends on its own, so
// the customer always knows they are talking to an assistant:
//
//   AI Assistant                    appointments not in use on the number
//   AI Assistant - Parmar Clinic    appointments in use (the business
//                                   name from the appointment settings)
//
// Added to automatic replies only — the AI agent and the appointment
// assistant. A draft an agent reviews and sends, and the portal's own
// appointment messages, are the business speaking and carry no footer.
//
// The footer is removed again before a past message is shown to the
// model, so it never learns to write one itself (which would double it).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const AI_FOOTER_LABEL = 'AI Assistant'

/** The footer text for a number, given the business name (if any). */
export function aiFooter(businessName?: string | null): string {
  const name = businessName?.replace(/\s+/g, ' ').trim()
  return name ? `${AI_FOOTER_LABEL} - ${name.slice(0, 80)}` : AI_FOOTER_LABEL
}

// A footer line at the very end of a message, with or without a name.
const FOOTER_AT_END = /(?:\r?\n)+[ \t]*AI Assistant(?: - [^\r\n]*)?[ \t]*$/

/** A message without its footer (unchanged when it has none). */
export function stripAiFooter(text: string): string {
  return text.replace(FOOTER_AT_END, '').trimEnd()
}

/** Put the footer under a reply, once. */
export function withAiFooter(text: string, footer: string): string {
  const body = stripAiFooter(text)
  return body ? `${body}\n\n${footer}` : footer
}

/**
 * The footer for automatic replies on one WhatsApp number: with the
 * business name when booking in chat is switched on there, plain
 * otherwise. Falls back to the plain footer on any error.
 */
export async function loadAiFooter(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null | undefined,
): Promise<string> {
  if (!channelId) return aiFooter()
  try {
    const { data } = await db
      .from('appointment_settings')
      .select('enabled, business_name')
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .maybeSingle()
    const row = data as { enabled?: boolean; business_name?: string | null } | null
    return row?.enabled ? aiFooter(row.business_name) : aiFooter()
  } catch {
    return aiFooter()
  }
}
