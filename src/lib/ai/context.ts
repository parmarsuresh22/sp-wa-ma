import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}

/** Stand-in customer turn for a draft when the business spoke last. */
export const DRAFT_FOLLOW_UP_CUE =
  '(The customer has not written anything since the last message above. Write a short follow-up the business could send next.)'

/**
 * Shape a transcript for "Draft with AI". A draft is often requested
 * right after the business (or the auto-reply bot) has answered, so the
 * transcript ends on an assistant turn — and a chat model asked to
 * continue after its own turn returns nothing (Gemini) or rejects the
 * request. Close it with a customer-side cue so there is a turn to
 * answer. A transcript that already ends with the customer is returned
 * unchanged.
 */
export function withDraftCue(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  if (messages[messages.length - 1].role === 'user') return messages
  return [...messages, { role: 'user', content: DRAFT_FOLLOW_UP_CUE }]
}
