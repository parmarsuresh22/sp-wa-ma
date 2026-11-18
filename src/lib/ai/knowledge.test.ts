import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  inserted: Record<string, unknown>[] | null
  deletedIds: string[] | null
  existingChunkIds: string[]
  events: string[]
  insertError: unknown
  allChunks: { content: string; document_id: string; chunk_index: number }[]
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 50, // a KB large enough to be searched (not handed over whole)
    allChunks: [] as { content: string; document_id: string; chunk_index: number }[],
    rpcCalls: [],
    inserted: null,
    deletedIds: null,
    existingChunkIds: ['old-1', 'old-2'],
    events: [],
    insertError: null,
  }
  const db = {
    rpc: (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard (awaited bare) and the
      // small-KB "load everything" path (.order().order() awaited).
      select: () => ({
        eq: () => {
          state.events.push('list')
          const result = {
            count: state.chunkCount,
            data: state.existingChunkIds.map((id) => ({ id })),
            error: null,
          }
          const ordered = {
            order: () => ordered,
            then: (resolve: (v: unknown) => unknown) =>
              resolve({ data: state.allChunks, error: null }),
          }
          return {
            ...ordered,
            then: (resolve: (v: unknown) => unknown) => resolve(result),
          }
        },
      }),
      delete: () => ({
        in: (_col: string, ids: string[]) => {
          state.events.push('delete')
          state.deletedIds = [...(state.deletedIds ?? []), ...ids]
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.events.push('insert')
        if (state.insertError) return Promise.resolve({ error: state.insertError })
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('hands a small knowledge base over whole, in document order, without searching', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 3
    state.allChunks = [
      { content: 'A1', document_id: 'a', chunk_index: 0 },
      { content: 'A2', document_id: 'a', chunk_index: 1 },
      { content: 'B1', document_id: 'b', chunk_index: 0 },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'where does he work')
    expect(out).toEqual(['A1', 'A2', 'B1'])
    expect(state.rpcCalls).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('caps the whole-KB handover by characters', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 2
    state.allChunks = [
      { content: 'x'.repeat(15_000), document_id: 'a', chunk_index: 0 },
      { content: 'y'.repeat(2_000), document_id: 'a', chunk_index: 1 },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toHaveLength(1)
  })

  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    const result = await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: false, embedError: null })
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('reports keyword-only success when embedding fails', async () => {
    const { db, state } = makeDb()
    const embedError = new Error('rate limited')
    h.embedTexts.mockRejectedValueOnce(embedError)
    const result = await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: true, embedError })
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('keeps the existing chunks until the embed has finished', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockImplementationOnce(async () => {
      expect(state.events).toEqual([])
      throw new Error('timeout')
    })
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(state.events).toEqual(['list', 'insert', 'delete'])
  })

  it('keeps the existing chunks when the insert fails', async () => {
    const { db, state } = makeDb()
    state.insertError = new Error('insert failed')
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world'),
    ).rejects.toThrow('insert failed')
    expect(state.deletedIds).toBeNull()
  })

  it('deletes previous chunks in batches', async () => {
    const { db, state } = makeDb()
    state.existingChunkIds = Array.from({ length: 250 }, (_, i) => `old-${i}`)
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(state.events.filter((e) => e === 'delete')).toHaveLength(3)
    expect(state.deletedIds).toHaveLength(250)
  })
})
