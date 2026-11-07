import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeWabaToApp } from './meta-api'

const okResponse = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('subscribeWabaToApp', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts an empty body when no override is requested (legacy behaviour)', async () => {
    await subscribeWabaToApp({ wabaId: 'waba-1', accessToken: 'tok' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/waba-1\/subscribed_apps$/)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(init.body).toBeUndefined()
  })

  it('sends override_callback_uri + verify_token as a form body when both are given', async () => {
    await subscribeWabaToApp({
      wabaId: 'waba-1',
      accessToken: 'tok',
      overrideCallbackUri: 'https://crm.example.com/api/whatsapp/webhook',
      verifyToken: 'my secret & token',
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(headers.Authorization).toBe('Bearer tok')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('override_callback_uri')).toBe(
      'https://crm.example.com/api/whatsapp/webhook'
    )
    expect(form.get('verify_token')).toBe('my secret & token')
  })

  it('falls back to the plain subscribe when only one of the two override fields is present', async () => {
    await subscribeWabaToApp({
      wabaId: 'waba-1',
      accessToken: 'tok',
      overrideCallbackUri: 'https://crm.example.com/api/whatsapp/webhook',
      verifyToken: null,
    })
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined()

    await subscribeWabaToApp({
      wabaId: 'waba-1',
      accessToken: 'tok',
      overrideCallbackUri: null,
      verifyToken: 'tok-only',
    })
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].body).toBeUndefined()
  })

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'nope', code: 100 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    )
    await expect(
      subscribeWabaToApp({ wabaId: 'waba-1', accessToken: 'tok' })
    ).rejects.toThrow()
  })
})
