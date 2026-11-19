import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  bridge: { baseUrl: 'https://bridge.test', apiKey: 'k', source: 'settings' } as unknown,
  createBridgeChannel: vi.fn(),
}))

vi.mock('@/lib/admin/super-admin', () => ({
  loadPlatformBridge: vi.fn(async () => h.bridge),
}))
vi.mock('@/lib/whatsapp/bridge-channel', () => {
  class BridgeChannelError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return { BridgeChannelError, createBridgeChannel: h.createBridgeChannel }
})

import {
  approveWebNumberRequest,
  rejectWebNumberRequest,
  toPublicRequest,
  webNumberUsage,
  WebNumberRequestError,
  type WebNumberRequestRow,
} from './web-number-requests'
import { BridgeChannelError } from '@/lib/whatsapp/bridge-channel'

const REQUEST: WebNumberRequestRow = {
  id: 'req-1',
  account_id: 'acc-1',
  requested_by: 'user-1',
  label: 'Sales',
  status: 'pending',
  channel_id: null,
  note: null,
  decided_by: null,
  decided_at: null,
  created_at: '2026-11-19T00:00:00Z',
}

interface State {
  request: WebNumberRequestRow | null
  linked: number
  pending: number
  limit: number | null
  updates: Record<string, unknown>[]
}

/** Fake covering the three tables the helpers touch. */
function fakeDb(state: State): SupabaseClient {
  return {
    from(table: string) {
      let patch: Record<string, unknown> | null = null
      const filters: Record<string, unknown> = {}
      const result = () => {
        if (table === 'whatsapp_config') return { count: state.linked, data: null, error: null }
        if (table === 'accounts') {
          return { data: state.limit === null ? null : { web_number_limit: state.limit }, error: null }
        }
        // web_number_requests
        if (patch) {
          const matches =
            !!state.request &&
            (filters.status === undefined || state.request.status === filters.status)
          if (matches) {
            state.updates.push(patch)
            state.request = { ...state.request!, ...patch } as WebNumberRequestRow
            return { data: [{ id: state.request.id }], error: null }
          }
          return { data: [], error: null }
        }
        return { count: state.pending, data: state.request, error: null }
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (row: Record<string, unknown>) => {
          patch = row
          return builder
        },
        eq: (col: string, value: unknown) => {
          filters[col] = value
          return builder
        },
        maybeSingle: async () => result(),
        then: (resolve: (r: unknown) => unknown) => resolve(result()),
      }
      return builder
    },
  } as unknown as SupabaseClient
}

function newState(over: Partial<State> = {}): State {
  return { request: { ...REQUEST }, linked: 0, pending: 1, limit: 2, updates: [], ...over }
}

beforeEach(() => {
  h.bridge = { baseUrl: 'https://bridge.test', apiKey: 'k', source: 'settings' }
  h.createBridgeChannel.mockReset()
  h.createBridgeChannel.mockResolvedValue({ id: 'ch-1' })
})

describe('toPublicRequest', () => {
  it('drops who asked and who decided', () => {
    const pub = toPublicRequest({ ...REQUEST, decided_by: 'admin-1' })
    expect(pub).not.toHaveProperty('requested_by')
    expect(pub).not.toHaveProperty('decided_by')
    expect(pub).not.toHaveProperty('account_id')
    expect(pub.label).toBe('Sales')
  })
})

describe('webNumberUsage', () => {
  it('reads linked, pending and the account limit', async () => {
    const usage = await webNumberUsage(fakeDb(newState({ linked: 1, pending: 1, limit: 3 })), 'acc-1')
    expect(usage).toEqual({ linked: 1, pending: 1, limit: 3 })
  })

  it('falls back to 2 when the account has no limit stored', async () => {
    const usage = await webNumberUsage(fakeDb(newState({ limit: null })), 'acc-1')
    expect(usage.limit).toBe(2)
  })
})

describe('approveWebNumberRequest', () => {
  it('creates the channel on the platform bridge for the requesting account', async () => {
    const state = newState()
    const out = await approveWebNumberRequest(fakeDb(state), 'req-1', {
      decidedBy: 'admin-1',
      origin: 'https://app.test',
    })
    expect(h.createBridgeChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acc-1',
        userId: 'user-1',
        label: 'Sales',
        baseUrl: 'https://bridge.test',
        apiKey: 'k',
        origin: 'https://app.test',
      }),
    )
    expect(out.request.status).toBe('approved')
    expect(out.request.channel_id).toBe('ch-1')
    expect(state.request?.status).toBe('approved')
    expect(state.request?.channel_id).toBe('ch-1')
  })

  it('refuses a request that was already decided', async () => {
    const state = newState({ request: { ...REQUEST, status: 'rejected' } })
    await expect(
      approveWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'a', origin: 'o' }),
    ).rejects.toMatchObject({ status: 409 })
    expect(h.createBridgeChannel).not.toHaveBeenCalled()
  })

  it('refuses when the account is already at its limit', async () => {
    const state = newState({ linked: 2, limit: 2 })
    await expect(
      approveWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'a', origin: 'o' }),
    ).rejects.toBeInstanceOf(WebNumberRequestError)
    expect(h.createBridgeChannel).not.toHaveBeenCalled()
    expect(state.request?.status).toBe('pending')
  })

  it('refuses when no platform bridge is configured', async () => {
    h.bridge = null
    const state = newState()
    await expect(
      approveWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'a', origin: 'o' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(state.request?.status).toBe('pending')
  })

  it('puts the request back to pending when the bridge refuses', async () => {
    h.createBridgeChannel.mockRejectedValue(new BridgeChannelError('bridge down', 502))
    const state = newState()
    await expect(
      approveWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'a', origin: 'o' }),
    ).rejects.toMatchObject({ message: 'bridge down', status: 502 })
    expect(state.request?.status).toBe('pending')
    expect(state.request?.decided_by).toBeNull()
  })

  it('404s for an unknown request', async () => {
    await expect(
      approveWebNumberRequest(fakeDb(newState({ request: null })), 'nope', {
        decidedBy: 'a',
        origin: 'o',
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('rejectWebNumberRequest', () => {
  it('marks a pending request rejected with a trimmed note', async () => {
    const state = newState()
    await rejectWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'admin-1', note: '  no  ' })
    expect(state.request?.status).toBe('rejected')
    expect(state.request?.note).toBe('no')
  })

  it('refuses one that is no longer pending', async () => {
    const state = newState({ request: { ...REQUEST, status: 'approved' } })
    await expect(
      rejectWebNumberRequest(fakeDb(state), 'req-1', { decidedBy: 'a' }),
    ).rejects.toMatchObject({ status: 409 })
  })
})
