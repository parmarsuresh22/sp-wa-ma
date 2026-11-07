import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeWamid, resolveReplyTargetByWamid } from './reply-target'

function fakeDb(
  result: { data: { id: string }[] | null; error: { message: string } | null },
  calls: { column: string; value: string }[] = []
): SupabaseClient {
  const client = {
    from: () => ({
      select: () => ({
        eq: (c1: string, v1: string) => {
          calls.push({ column: c1, value: v1 })
          return {
            eq: (c2: string, v2: string) => {
              calls.push({ column: c2, value: v2 })
              return {
                order: () => ({
                  limit: async () => result,
                }),
              }
            },
          }
        },
      }),
    }),
  }
  return client as unknown as SupabaseClient
}

describe('normalizeWamid', () => {
  it('trims a plausible id and rejects junk', () => {
    expect(normalizeWamid('  wamid.ABC==  ')).toBe('wamid.ABC==')
    expect(normalizeWamid('')).toBeNull()
    expect(normalizeWamid('   ')).toBeNull()
    expect(normalizeWamid(42)).toBeNull()
    expect(normalizeWamid(null)).toBeNull()
    expect(normalizeWamid('x'.repeat(257))).toBeNull()
  })
})

describe('resolveReplyTargetByWamid', () => {
  it('returns our row id when the wamid exists in the conversation', async () => {
    const calls: { column: string; value: string }[] = []
    const db = fakeDb({ data: [{ id: 'msg-uuid' }], error: null }, calls)

    const res = await resolveReplyTargetByWamid(db, 'conv-1', 'wamid.X')

    expect(res).toEqual({ ok: true, messageId: 'msg-uuid' })
    // Scoped to the conversation AND matched on Meta's id.
    expect(calls).toEqual([
      { column: 'conversation_id', value: 'conv-1' },
      { column: 'message_id', value: 'wamid.X' },
    ])
  })

  it('reports not_found when nothing matches', async () => {
    const db = fakeDb({ data: [], error: null })
    expect(await resolveReplyTargetByWamid(db, 'conv-1', 'wamid.X')).toEqual({
      ok: false,
      reason: 'not_found',
    })
    const dbNull = fakeDb({ data: null, error: null })
    expect(await resolveReplyTargetByWamid(dbNull, 'conv-1', 'wamid.X')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('reports db_error with the message when the query fails', async () => {
    const db = fakeDb({ data: null, error: { message: 'boom' } })
    expect(await resolveReplyTargetByWamid(db, 'conv-1', 'wamid.X')).toEqual({
      ok: false,
      reason: 'db_error',
      detail: 'boom',
    })
  })
})
