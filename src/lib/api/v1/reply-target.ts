// ============================================================
// Resolve a quoted-reply target given Meta's message id (wamid).
//
// `POST /api/v1/messages` accepts `reply_to_message_id` (our UUID) —
// fine for a caller that read the message via our API first. An
// external bot that only ever saw Meta's webhook (n8n, Make…) has the
// *wamid* instead (`messages[0].id`), so the route also accepts
// `reply_to_whatsapp_message_id` and maps it to our row here.
//
// Scoped to the conversation the reply is going to, so a caller can't
// quote a message from another chat. Not-found is reported, not thrown:
// the usual cause is a race (the bot answered before our webhook
// handler finished inserting the inbound row), and for a bot a reply
// without a quote beats a dropped reply.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

type MessageRow = { id: string }

export type ReplyTargetResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'not_found' | 'db_error'; detail?: string }

/** Trim + sanity-check a caller-supplied wamid; `null` if unusable. */
export function normalizeWamid(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  // Meta ids are `wamid.` + base64-ish; cap length defensively.
  if (!value || value.length > 256) return null
  return value
}

/**
 * Map a wamid to our `messages.id` inside `conversationId`. If Meta
 * ever redelivers and we hold duplicates, prefer the newest row.
 */
export async function resolveReplyTargetByWamid(
  db: SupabaseClient,
  conversationId: string,
  wamid: string
): Promise<ReplyTargetResult> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', wamid)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) return { ok: false, reason: 'db_error', detail: error.message }
  const row = (data as MessageRow[] | null)?.[0]
  if (!row) return { ok: false, reason: 'not_found' }
  return { ok: true, messageId: row.id }
}
