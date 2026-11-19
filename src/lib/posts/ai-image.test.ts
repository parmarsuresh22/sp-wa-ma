import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from '@/lib/ai/types'
import { aiImage, geminiImageModelScore, pickGeminiImageModel, pickOpenAiImageModel } from './ai-image'

const config = (provider: AiConfig['provider']): AiConfig =>
  ({
    provider,
    model: 'chat-model',
    baseUrl: null,
    apiKey: 'key',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 5,
    handoffAgentId: null,
  }) as AiConfig

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('pickGeminiImageModel', () => {
  const gc = ['generateContent']
  it('picks an image-output model and ignores text and Imagen models', () => {
    expect(
      pickGeminiImageModel([
        { name: 'models/gemini-3-flash', supportedGenerationMethods: gc },
        { name: 'models/imagen-4.0-generate', supportedGenerationMethods: ['predict'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: gc },
      ]),
    ).toBe('gemini-2.5-flash-image')
  })
  it('prefers a newer, non-preview flash image model', () => {
    expect(
      pickGeminiImageModel([
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: gc },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: gc },
        { name: 'models/gemini-3-pro-image-preview', supportedGenerationMethods: gc },
      ]),
    ).toBe('gemini-3.1-flash-image')
  })
  it('skips models that cannot generateContent, and returns null with none', () => {
    expect(
      pickGeminiImageModel([{ name: 'models/gemini-9-flash-image', supportedGenerationMethods: ['embedContent'] }]),
    ).toBeNull()
    expect(pickGeminiImageModel([])).toBeNull()
  })
  it('never scores an Imagen or a text model', () => {
    expect(geminiImageModelScore('imagen-4.0-fast-generate')).toBe(-1)
    expect(geminiImageModelScore('gemini-3-flash')).toBe(-1)
    expect(geminiImageModelScore('gemini-nano-banana-2')).toBeGreaterThan(0)
  })
})

describe('pickOpenAiImageModel', () => {
  it('picks the newest gpt-image model, plain id first', () => {
    expect(
      pickOpenAiImageModel(['gpt-4o', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1.5-2026-01-01', 'dall-e-3']),
    ).toBe('gpt-image-1.5')
  })
  it('returns null when the key has none', () => {
    expect(pickOpenAiImageModel(['gpt-4o', 'dall-e-3'])).toBeNull()
  })
})

describe('aiImage', () => {
  it('refuses providers that cannot make images', async () => {
    await expect(aiImage(config('anthropic'), { instruction: 'x' })).rejects.toMatchObject({
      code: 'unsupported_provider',
      status: 400,
    })
  })

  it('needs an instruction', async () => {
    await expect(aiImage(config('gemini'), { instruction: '  ' })).rejects.toMatchObject({ status: 400 })
  })

  it('edits through Gemini: lists models, sends the picture, reads the picture back', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
        if (url.includes('/models?')) {
          return new Response(
            JSON.stringify({
              models: [{ name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }],
            }),
          )
        }
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('new').toString('base64') } }] } },
            ],
          }),
        )
      }),
    )
    const out = await aiImage(config('gemini'), {
      instruction: 'make it festive',
      image: { bytes: Buffer.from('old'), mime: 'image/jpeg' },
    })
    expect(out.bytes.toString()).toBe('new')
    expect(out.mime).toBe('image/png')
    expect(out.model).toBe('gemini-2.5-flash-image')
    expect(calls[1].url).toContain('gemini-2.5-flash-image:generateContent')
    const sent = JSON.parse(calls[1].body!)
    expect(sent.contents[0].parts[0].text).toBe('make it festive')
    expect(sent.contents[0].parts[1].inlineData.data).toBe(Buffer.from('old').toString('base64'))
    expect(sent.generationConfig.responseModalities).toContain('IMAGE')
  })

  it('explains when Gemini answers with words instead of a picture', async () => {
    vi.stubEnv('POSTS_IMAGE_MODEL', 'some-image-model')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I cannot do that' }] } }] }))),
    )
    await expect(aiImage(config('gemini'), { instruction: 'x' })).rejects.toMatchObject({
      code: 'empty_response',
      message: expect.stringContaining('I cannot do that'),
    })
  })

  it('reports a rejected key as such', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })),
    )
    await expect(aiImage(config('gemini'), { instruction: 'x' })).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('creates through OpenAI when there is no picture to edit', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }))
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }))
      }),
    )
    const out = await aiImage(config('openai'), { instruction: 'a red kite' })
    expect(urls[1]).toContain('/images/generations')
    expect(out.bytes.toString()).toBe('img')
    expect(out.mime).toBe('image/png')
  })

  it('edits through OpenAI when there is a picture', async () => {
    const urls: string[] = []
    vi.stubEnv('POSTS_IMAGE_MODEL', 'gpt-image-1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ data: [{ b64_json: 'aW1n' }] }))
      }),
    )
    await aiImage(config('openai'), { instruction: 'brighter', image: { bytes: Buffer.from('old'), mime: 'image/png' } })
    expect(urls).toEqual(['https://api.openai.com/v1/images/edits'])
  })
})
