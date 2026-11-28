import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as { id: string }[],
  fail: false,
  reads: 0,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        not: () => ({
          limit: async () => {
            h.reads++
            return h.fail ? { data: null, error: { message: 'down' } } : { data: h.rows, error: null }
          },
        }),
      }),
    }),
  }),
}))

const { accountIsBlocked, blockedAccountIds, forgetBlockedAccounts, withoutBlocked } = await import('./blocked-server')
const { senderForChannel } = await import('@/lib/whatsapp/providers')

beforeEach(() => {
  h.rows = []
  h.fail = false
  h.reads = 0
  forgetBlockedAccounts()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('blocked accounts', () => {
  it('knows which accounts are blocked and keeps the list briefly', async () => {
    h.rows = [{ id: 'acct-blocked' }]
    expect(await accountIsBlocked('acct-blocked')).toBe(true)
    expect(await accountIsBlocked('acct-fine')).toBe(false)
    expect(await accountIsBlocked(null)).toBe(false)
    expect(h.reads).toBe(1)
  })

  it('sees a change at once after forgetBlockedAccounts', async () => {
    expect(await accountIsBlocked('acct-1')).toBe(false)
    h.rows = [{ id: 'acct-1' }]
    forgetBlockedAccounts()
    expect(await accountIsBlocked('acct-1')).toBe(true)
  })

  it('blocks nobody when the list cannot be read', async () => {
    h.fail = true
    expect((await blockedAccountIds()).size).toBe(0)
  })

  it('leaves blocked accounts out of a scheduled query', () => {
    const calls: string[][] = []
    const query = {
      not(column: string, operator: string, value: string) {
        calls.push([column, operator, value])
        return this
      },
    }
    expect(withoutBlocked(query, new Set())).toBe(query)
    expect(calls).toEqual([])
    withoutBlocked(query, new Set(['a', 'b']))
    expect(calls).toEqual([['account_id', 'in', '(a,b)']])
  })
})

describe('senderForChannel', () => {
  it('refuses every send of a blocked account before reaching the transport', async () => {
    h.rows = [{ id: 'acct-blocked' }]
    const encryption = await import('@/lib/whatsapp/encryption')
    const channel = {
      id: 'chan-1',
      account_id: 'acct-blocked',
      provider: 'meta',
      phone_number_id: '123',
      access_token: encryption.encrypt('token'),
    } as unknown as Parameters<typeof senderForChannel>[0]
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const sender = senderForChannel(channel)
    await expect(sender.sendText({ to: '919876543210', text: 'hello' })).rejects.toMatchObject({
      code: 'account_blocked',
    })
    await expect(sender.markRead({ to: '919876543210', messageId: 'm1' } as never)).rejects.toMatchObject({
      code: 'account_blocked',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
