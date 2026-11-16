import { describe, expect, it, vi } from 'vitest'
import {
  chatIdToPhone,
  createWahaSender,
  extractWahaMessageId,
  guessMimeFromUrl,
  isGroupChatId,
  normalizeBridgeBaseUrl,
  toWahaChatId,
  WahaError,
} from './waha'
import { interactiveToText, matchInteractiveReply } from './types'

describe('chat ids', () => {
  it('converts phones to WAHA chat ids and back', () => {
    expect(toWahaChatId('+91 98765 43210')).toBe('919876543210@c.us')
    expect(toWahaChatId('919876543210@c.us')).toBe('919876543210@c.us')
    expect(chatIdToPhone('919876543210@c.us')).toBe('+919876543210')
    expect(chatIdToPhone('919876543210@s.whatsapp.net')).toBe('+919876543210')
    expect(chatIdToPhone('1203630@g.us')).toBeNull()
    expect(chatIdToPhone(null)).toBeNull()
    expect(isGroupChatId('1203630@g.us')).toBe(true)
    expect(isGroupChatId('919876543210@c.us')).toBe(false)
  })
})

describe('normalizeBridgeBaseUrl', () => {
  it('keeps https/http origins, strips trailing slashes, query and hash', () => {
    expect(normalizeBridgeBaseUrl(' https://waha.example.com/ ')).toBe('https://waha.example.com')
    expect(normalizeBridgeBaseUrl('https://waha.example.com/waha/?x=1#y')).toBe('https://waha.example.com/waha')
    expect(normalizeBridgeBaseUrl('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000')
  })
  it('rejects credentials in the URL and non-http schemes', () => {
    expect(normalizeBridgeBaseUrl('https://user:pw@waha.example.com')).toBeNull()
    expect(normalizeBridgeBaseUrl('ftp://waha.example.com')).toBeNull()
    expect(normalizeBridgeBaseUrl('not a url')).toBeNull()
    expect(normalizeBridgeBaseUrl('')).toBeNull()
  })
})

describe('extractWahaMessageId', () => {
  it('accepts the string form (GOWS/NOWEB) and the object form (WEBJS)', () => {
    expect(extractWahaMessageId({ id: 'true_1@c.us_ABC' })).toBe('true_1@c.us_ABC')
    expect(extractWahaMessageId({ id: { _serialized: 'true_1@c.us_DEF', id: 'DEF' } })).toBe('true_1@c.us_DEF')
    expect(extractWahaMessageId({ id: { id: 'GHI' } })).toBe('GHI')
    expect(extractWahaMessageId({})).toBeNull()
    expect(extractWahaMessageId(null)).toBeNull()
  })
})

describe('guessMimeFromUrl', () => {
  it('reads the extension and falls back by kind', () => {
    expect(guessMimeFromUrl('https://cdn/x/photo.JPG?x=1', 'image')).toBe('image/jpeg')
    expect(guessMimeFromUrl('https://cdn/x/report.pdf', 'document')).toBe('application/pdf')
    expect(guessMimeFromUrl('https://cdn/x/noext', 'video')).toBe('video/mp4')
    expect(guessMimeFromUrl('https://cdn/x/noext', 'audio')).toBe('audio/ogg; codecs=opus')
  })
})

describe('interactive fallback', () => {
  const payload = {
    kind: 'buttons' as const,
    header: 'Hours',
    body: 'When should we call?',
    footer: 'Reply with a number',
    buttons: [
      { id: 'am', title: 'Morning' },
      { id: 'pm', title: 'Afternoon' },
    ],
  }

  it('renders buttons as a numbered list', () => {
    expect(interactiveToText(payload)).toBe(
      '*Hours*\nWhen should we call?\n\n1. Morning\n2. Afternoon\n\n_Reply with a number_',
    )
  })

  it('matches a typed number, a label or an id back to the option', () => {
    expect(matchInteractiveReply(payload, '2')).toEqual({ id: 'pm', title: 'Afternoon' })
    expect(matchInteractiveReply(payload, '1.')).toEqual({ id: 'am', title: 'Morning' })
    expect(matchInteractiveReply(payload, 'afternoon')).toEqual({ id: 'pm', title: 'Afternoon' })
    expect(matchInteractiveReply(payload, 'am')).toEqual({ id: 'am', title: 'Morning' })
    expect(matchInteractiveReply(payload, '3')).toBeNull()
    expect(matchInteractiveReply(payload, 'something else')).toBeNull()
  })

  it('flattens list sections in order', () => {
    const list = {
      kind: 'list' as const,
      body: 'Pick',
      button_label: 'Menu',
      sections: [
        { title: 'A', rows: [{ id: 'a1', title: 'One', description: 'first' }] },
        { rows: [{ id: 'b1', title: 'Two' }] },
      ],
    }
    expect(interactiveToText(list)).toBe('Pick\n\n1. One — first\n2. Two')
    expect(matchInteractiveReply(list, '2')).toEqual({ id: 'b1', title: 'Two', description: undefined })
  })
})

describe('createWahaSender', () => {
  function sender(fetchImpl: typeof fetch) {
    return createWahaSender({
      channelId: 'ch-1',
      baseUrl: 'https://waha.example.com',
      session: 'wacrm-1',
      apiKey: 'secret',
      fetchImpl,
    })
  }

  it('posts text with the session, chat id, API key and quoted id', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'true_911234567890@c.us_X' }), { status: 201 }),
    ) as unknown as typeof fetch
    const r = await sender(fetchMock).sendText({
      to: '+911234567890',
      text: 'hello',
      contextMessageId: 'false_911234567890@c.us_P',
    })
    expect(r.messageId).toBe('true_911234567890@c.us_X')
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://waha.example.com/api/sendText')
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('secret')
    expect(JSON.parse(String(init.body))).toEqual({
      session: 'wacrm-1',
      chatId: '911234567890@c.us',
      text: 'hello',
      reply_to: 'false_911234567890@c.us_P',
    })
  })

  it('routes media to the endpoint for its kind and skips captions on voice notes', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'true_1@c.us_M' }), { status: 201 }),
    ) as unknown as typeof fetch
    const s = sender(fetchMock)
    await s.sendMedia({ to: '+911234567890', kind: 'image', link: 'https://cdn/a.png', caption: 'cap' })
    await s.sendMedia({ to: '+911234567890', kind: 'audio', link: 'https://cdn/a.ogg', caption: 'ignored' })
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('https://waha.example.com/api/sendImage')
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({
      file: { url: 'https://cdn/a.png', mimetype: 'image/png' },
      caption: 'cap',
    })
    expect(calls[1][0]).toBe('https://waha.example.com/api/sendVoice')
    expect(JSON.parse(String(calls[1][1].body))).not.toHaveProperty('caption')
  })

  it('degrades interactive messages to numbered text', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'true_1@c.us_I' }), { status: 201 }),
    ) as unknown as typeof fetch
    await sender(fetchMock).sendInteractive({
      to: '+911234567890',
      payload: { kind: 'buttons', body: 'Pick', buttons: [{ id: 'a', title: 'A' }] },
    })
    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://waha.example.com/api/sendText')
    expect(JSON.parse(String(init.body)).text).toBe('Pick\n\n1. A')
  })

  it('refuses templates and surfaces bridge errors with their status', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Unauthorized', statusCode: 401 }), { status: 401 }),
    ) as unknown as typeof fetch
    const s = sender(fetchMock)
    await expect(
      s.sendTemplate({ to: '+1', templateName: 't', language: 'en', params: [] }),
    ).rejects.toMatchObject({ code: 'unsupported_on_channel' })
    await expect(s.sendText({ to: '+911234567890', text: 'x' })).rejects.toBeInstanceOf(WahaError)
    await expect(s.sendText({ to: '+911234567890', text: 'x' })).rejects.toMatchObject({ status: 401 })
  })
})
