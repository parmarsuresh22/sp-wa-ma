import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORWARD_TIMEOUT_MS,
  forwardMetaWebhook,
  forwardTargets,
} from './webhook-forward'

const ORIGINAL = process.env.WEBHOOK_FORWARD_URL

beforeEach(() => {
  delete process.env.WEBHOOK_FORWARD_URL
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WEBHOOK_FORWARD_URL
  else process.env.WEBHOOK_FORWARD_URL = ORIGINAL
  vi.restoreAllMocks()
})

describe('forwardTargets', () => {
  it('returns no targets when the variable is unset or blank', () => {
    expect(forwardTargets(undefined)).toEqual([])
    expect(forwardTargets('')).toEqual([])
    expect(forwardTargets(' , ,')).toEqual([])
  })

  it('splits on commas, trims whitespace and drops duplicates', () => {
    expect(
      forwardTargets(
        ' https://a.example/hook , https://b.example/hook,https://a.example/hook '
      )
    ).toEqual(['https://a.example/hook', 'https://b.example/hook'])
  })

  it('reads WEBHOOK_FORWARD_URL by default', () => {
    process.env.WEBHOOK_FORWARD_URL = 'https://n8n.example/webhook/abc/webhook'
    expect(forwardTargets()).toEqual(['https://n8n.example/webhook/abc/webhook'])
  })
})

describe('forwardMetaWebhook', () => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-hub-signature-256': 'sha256=deadbeef',
    // Must NOT be copied — hop-by-hop / Meta-internal noise.
    'x-forwarded-for': '1.2.3.4',
  })

  it('does nothing when no target is configured', async () => {
    const fetchImpl = vi.fn()
    await forwardMetaWebhook('{}', headers, fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('POSTs the untouched body and Meta signature to each target', async () => {
    process.env.WEBHOOK_FORWARD_URL =
      'https://a.example/hook, https://b.example/hook'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const rawBody = '{"entry":[{"id":"1"}]}'

    await forwardMetaWebhook(rawBody, headers, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const urls = fetchImpl.mock.calls.map((c) => c[0]).sort()
    expect(urls).toEqual(['https://a.example/hook', 'https://b.example/hook'])

    const init = fetchImpl.mock.calls[0][1] as RequestInit & {
      headers: Record<string, string>
    }
    expect(init.method).toBe('POST')
    expect(init.body).toBe(rawBody)
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-hub-signature-256']).toBe('sha256=deadbeef')
    expect(init.headers['x-forwarded-for']).toBeUndefined()
  })

  it('defaults content-type to JSON when the inbound request had none', async () => {
    process.env.WEBHOOK_FORWARD_URL = 'https://a.example/hook'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await forwardMetaWebhook('{}', new Headers(), fetchImpl)
    const init = fetchImpl.mock.calls[0][1] as {
      headers: Record<string, string>
    }
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-hub-signature-256']).toBeUndefined()
  })

  it('logs and swallows a non-2xx response', async () => {
    process.env.WEBHOOK_FORWARD_URL = 'https://a.example/hook'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 })

    await expect(
      forwardMetaWebhook('{}', headers, fetchImpl)
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('404')
  })

  it('logs and swallows a network error without failing other targets', async () => {
    process.env.WEBHOOK_FORWARD_URL =
      'https://down.example/hook,https://up.example/hook'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('https://down')) throw new Error('ECONNREFUSED')
      return { ok: true, status: 200 }
    })

    await expect(
      forwardMetaWebhook('{}', headers, fetchImpl)
    ).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('https://down.example/hook')
  })

  it('exposes a bounded timeout', () => {
    expect(FORWARD_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FORWARD_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})
