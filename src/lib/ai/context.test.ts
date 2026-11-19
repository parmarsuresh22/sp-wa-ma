import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})

describe('withDraftCue', () => {
  it('leaves a transcript that ends with the customer unchanged', async () => {
    const { withDraftCue } = await import('./context')
    const msgs = [
      { role: 'assistant' as const, content: 'Hello' },
      { role: 'user' as const, content: 'Price?' },
    ]
    expect(withDraftCue(msgs)).toBe(msgs)
  })

  it('closes a transcript the business ended with a customer-side cue', async () => {
    const { withDraftCue, DRAFT_FOLLOW_UP_CUE } = await import('./context')
    const msgs = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'How can I help?' },
    ]
    const out = withDraftCue(msgs)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ role: 'user', content: DRAFT_FOLLOW_UP_CUE })
    expect(msgs).toHaveLength(2)
  })

  it('returns an empty transcript as is', async () => {
    const { withDraftCue } = await import('./context')
    expect(withDraftCue([])).toEqual([])
  })
})
