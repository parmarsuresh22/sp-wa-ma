import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  channelDisplayName,
  hasConnectedChannel,
  listChannels,
  loadChannel,
  loadDefaultChannel,
  loadDefaultMetaChannel,
  resolveSendChannel,
  toPublicChannel,
  type ChannelRow,
} from './channels'

function row(partial: Partial<ChannelRow> & { id: string }): ChannelRow {
  return {
    account_id: 'acct-1',
    user_id: 'u-1',
    provider: 'meta',
    label: null,
    display_phone: null,
    is_default: false,
    status: 'connected',
    connected_at: null,
    created_at: '2026-01-01T00:00:00Z',
    access_token: 'enc',
    phone_number_id: 'pn',
    waba_id: null,
    verify_token: 'enc-v',
    bridge_base_url: null,
    bridge_session: null,
    bridge_webhook_secret: 'enc-s',
    bridge_status: null,
    ...partial,
  }
}

/** Fake that answers `from('whatsapp_config').select('*').eq('account_id', …)`. */
function db(rows: ChannelRow[] | ChannelRow | null, calls: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      calls.push(table)
      return {
        select: () => ({
          eq: (_c: string, v: string) =>
            Promise.resolve({
              data: Array.isArray(rows) ? rows.filter((r) => r.account_id === v) : rows,
              error: null,
            }),
        }),
      }
    },
  } as unknown as SupabaseClient
}

const META_OLD = row({ id: 'm-old', created_at: '2026-01-01T00:00:00Z', phone_number_id: 'pn-1' })
const META_DEFAULT = row({ id: 'm-def', created_at: '2026-02-01T00:00:00Z', is_default: true, phone_number_id: 'pn-2' })
const WAHA = row({
  id: 'w-1',
  provider: 'waha',
  created_at: '2025-12-01T00:00:00Z',
  phone_number_id: null,
  bridge_base_url: 'https://waha',
  bridge_session: 's',
  status: 'disconnected',
})

describe('ordering and defaults', () => {
  it('lists default first, then oldest first', async () => {
    const rows = await listChannels(db([META_OLD, WAHA, META_DEFAULT]), 'acct-1')
    expect(rows.map((r) => r.id)).toEqual(['m-def', 'w-1', 'm-old'])
  })

  it('falls back to the oldest channel when none is flagged default', async () => {
    const def = await loadDefaultChannel(db([META_OLD, WAHA]), 'acct-1')
    expect(def?.id).toBe('w-1')
  })

  it('loadDefaultMetaChannel skips bridges and treats a pre-061 row as Meta', async () => {
    const legacy = row({ id: 'legacy', provider: undefined as unknown as 'meta', is_default: true })
    expect((await loadDefaultMetaChannel(db([WAHA, META_OLD]), 'acct-1'))?.id).toBe('m-old')
    expect((await loadDefaultMetaChannel(db([legacy]), 'acct-1'))?.id).toBe('legacy')
    expect(await loadDefaultMetaChannel(db([WAHA]), 'acct-1')).toBeNull()
  })

  it('tolerates a single-object result from older fakes and an empty account', async () => {
    expect((await loadDefaultChannel(db(META_OLD), 'acct-1'))?.id).toBe('m-old')
    expect(await loadDefaultChannel(db([]), 'acct-1')).toBeNull()
    expect(await loadDefaultChannel(db(null), 'acct-1')).toBeNull()
  })
})

describe('resolveSendChannel', () => {
  const all = [META_OLD, META_DEFAULT, WAHA]

  it('honours an explicit channel only when it belongs to the account', async () => {
    expect((await resolveSendChannel(db(all), 'acct-1', { channelId: 'w-1' }))?.id).toBe('w-1')
    expect(await resolveSendChannel(db(all), 'acct-1', { channelId: 'someone-elses' })).toBeNull()
  })

  it("uses the conversation's own channel, else the default", async () => {
    expect(
      (await resolveSendChannel(db(all), 'acct-1', { conversationChannelId: 'm-old' }))?.id,
    ).toBe('m-old')
    expect(
      (await resolveSendChannel(db(all), 'acct-1', { conversationChannelId: 'deleted' }))?.id,
    ).toBe('m-def')
    expect((await resolveSendChannel(db(all), 'acct-1'))?.id).toBe('m-def')
  })

  it('loadChannel is account-scoped', async () => {
    const foreign = row({ id: 'f', account_id: 'acct-2' })
    expect(await loadChannel(db([META_OLD, foreign]), 'acct-1', 'f')).toBeNull()
    expect((await loadChannel(db([META_OLD, foreign]), 'acct-1', 'm-old'))?.id).toBe('m-old')
  })

  it('hasConnectedChannel needs at least one connected row', async () => {
    expect(await hasConnectedChannel(db([WAHA]), 'acct-1')).toBe(false)
    expect(await hasConnectedChannel(db([WAHA, META_OLD]), 'acct-1')).toBe(true)
  })
})

describe('presentation', () => {
  it('channelDisplayName prefers label, then number, then ids', () => {
    expect(channelDisplayName(row({ id: 'a', label: ' Sales ' }))).toBe('Sales')
    expect(channelDisplayName(row({ id: 'a', display_phone: '+91 1' }))).toBe('+91 1')
    expect(channelDisplayName(row({ id: 'a', phone_number_id: 'pn-9' }))).toBe('pn-9')
    expect(channelDisplayName(row({ id: 'a', phone_number_id: null, bridge_session: 'sess' }))).toBe('sess')
  })

  it('toPublicChannel strips every secret', () => {
    const pub = toPublicChannel(META_DEFAULT) as Record<string, unknown>
    expect(pub).not.toHaveProperty('access_token')
    expect(pub).not.toHaveProperty('verify_token')
    expect(pub).not.toHaveProperty('bridge_webhook_secret')
    expect(pub).not.toHaveProperty('user_id')
    expect(pub.id).toBe('m-def')
  })
})
