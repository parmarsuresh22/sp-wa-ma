// ============================================================
// AI image editing / generation for posts, on the account's own key.
//
// Text chat and image work are different models, and image model names
// change often, so nothing is hard-coded as "the" model: the provider is
// asked which models the key can use and the best image-capable one is
// picked (`POSTS_IMAGE_MODEL` overrides the choice).
//
//   gemini   native generateContent with an image-output model. The
//            picture to edit rides along as inlineData; the reply
//            carries the new picture as inlineData.
//   openai   /v1/images/edits (multipart) to edit, /v1/images/generations
//            to create. GPT image models always answer with base64.
//
// Anthropic and generic OpenAI-compatible endpoints have no image
// output, so they are refused with a message that says so.
// ============================================================

import { AiError, type AiConfig } from '@/lib/ai/types'

const TIMEOUT_MS = 55_000

export interface AiImageInput {
  /** What to do, in the person's words. */
  instruction: string
  /** The picture to change; omit to create one from the instruction. */
  image?: { bytes: Buffer; mime: string } | null
}

export interface AiImageOutput {
  bytes: Buffer
  mime: string
  model: string
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS)
}

function networkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to answer. Try again.', {
      code: 'timeout',
      status: 504,
    })
  }
  return new AiError(
    `Could not reach the AI provider: ${err instanceof Error ? err.message : String(err)}`,
    { code: 'network_error', status: 502 },
  )
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const raw = (await res.json()) as unknown
    const body = Array.isArray(raw) ? raw[0] : raw
    const err = (body as { error?: { message?: string } | string } | null)?.error
    if (typeof err === 'string') return err
    return err?.message ?? ''
  } catch {
    return ''
  }
}

function httpError(provider: string, status: number, detail: string): AiError {
  const badKey = status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))
  const base = badKey
    ? `${provider} rejected the API key`
    : status === 429
      ? `${provider} rate limit or quota reached`
      : `${provider} error ${status}`
  return new AiError(detail ? `${base}: ${detail}` : base, {
    code: badKey ? 'invalid_key' : status === 429 ? 'rate_limited' : 'provider_error',
    status: badKey ? 401 : 502,
  })
}

// ------------------------------------------------------------
// Gemini
// ------------------------------------------------------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiModel {
  name?: string
  supportedGenerationMethods?: string[]
}

/**
 * Rank Gemini model names for image work: higher is better. Exported
 * for tests. Image-output models carry "image" (or the "nano-banana"
 * nickname) in their id; Imagen models use a different API (`predict`)
 * and are skipped.
 */
export function geminiImageModelScore(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('imagen')) return -1
  if (!n.includes('image') && !n.includes('banana')) return -1
  let score = 10
  if (n.includes('flash')) score += 5 // cheaper and quicker than pro
  if (n.includes('preview') || n.includes('exp')) score -= 2
  if (n.includes('lite')) score -= 1
  // Prefer the newest version number in the id.
  const version = /(\d+(?:\.\d+)?)/.exec(n)
  if (version) score += Math.min(9, Number.parseFloat(version[1]))
  return score
}

export function pickGeminiImageModel(models: GeminiModel[]): string | null {
  const candidates = models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter((name) => name && geminiImageModelScore(name) >= 0)
    .sort((a, b) => geminiImageModelScore(b) - geminiImageModelScore(a))
  return candidates[0] ?? null
}

async function geminiImage(apiKey: string, input: AiImageInput): Promise<AiImageOutput> {
  let model = process.env.POSTS_IMAGE_MODEL?.trim() || ''
  if (!model) {
    let res: Response
    try {
      res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
        headers: { 'x-goog-api-key': apiKey },
        signal: timeoutSignal(),
      })
    } catch (err) {
      throw networkError(err)
    }
    if (!res.ok) throw httpError('Gemini', res.status, await errorDetail(res))
    const body = (await res.json().catch(() => null)) as { models?: GeminiModel[] } | null
    model = pickGeminiImageModel(body?.models ?? []) ?? ''
    if (!model) {
      throw new AiError(
        'This Gemini key has no image-capable model available. Enable one in Google AI Studio, or use an OpenAI key.',
        { code: 'no_image_model', status: 400 },
      )
    }
  }

  const parts: Record<string, unknown>[] = [{ text: input.instruction }]
  if (input.image) {
    parts.push({
      inlineData: { mimeType: input.image.mime, data: input.image.bytes.toString('base64') },
    })
  }

  let res: Response
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
      signal: timeoutSignal(),
    })
  } catch (err) {
    throw networkError(err)
  }
  if (!res.ok) throw httpError('Gemini', res.status, await errorDetail(res))

  type Part = {
    text?: string
    inlineData?: { mimeType?: string; data?: string }
    inline_data?: { mime_type?: string; data?: string }
  }
  const data = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: Part[] } }[]
  } | null
  const outParts = data?.candidates?.[0]?.content?.parts ?? []
  for (const p of outParts) {
    const b64 = p.inlineData?.data ?? p.inline_data?.data
    if (b64) {
      return {
        bytes: Buffer.from(b64, 'base64'),
        mime: p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? 'image/png',
        model,
      }
    }
  }
  const said = outParts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 300)
  throw new AiError(
    said
      ? `Gemini returned no image: ${said}`
      : 'Gemini returned no image. Try a different instruction.',
    { code: 'empty_response', status: 502 },
  )
}

// ------------------------------------------------------------
// OpenAI
// ------------------------------------------------------------

const OPENAI_BASE = 'https://api.openai.com/v1'

/** Newest `gpt-image-*` id the key can use; exported for tests. */
export function pickOpenAiImageModel(ids: string[]): string | null {
  const version = (id: string): number => {
    const m = /gpt-image-(\d+(?:\.\d+)?)/.exec(id)
    return m ? Number.parseFloat(m[1]) : 0
  }
  const candidates = ids
    .filter((id) => /^gpt-image-\d/.test(id))
    // Plain ids before dated / nicknamed variants of the same version.
    .sort((a, b) => version(b) - version(a) || a.length - b.length)
  return candidates[0] ?? null
}

async function openAiImage(apiKey: string, input: AiImageInput): Promise<AiImageOutput> {
  const auth = { Authorization: `Bearer ${apiKey}` }
  let model = process.env.POSTS_IMAGE_MODEL?.trim() || ''
  if (!model) {
    try {
      const res = await fetch(`${OPENAI_BASE}/models`, { headers: auth, signal: timeoutSignal() })
      if (res.status === 401 || res.status === 403) {
        throw httpError('OpenAI', res.status, await errorDetail(res))
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null
        model = pickOpenAiImageModel((body?.data ?? []).map((m) => m.id ?? '')) ?? ''
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      throw networkError(err)
    }
    if (!model) model = 'gpt-image-1'
  }

  let res: Response
  try {
    if (input.image) {
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', input.instruction)
      const ext = input.image.mime === 'image/png' ? 'png' : input.image.mime === 'image/webp' ? 'webp' : 'jpg'
      form.set(
        'image',
        new Blob([new Uint8Array(input.image.bytes)], { type: input.image.mime }),
        `image.${ext}`,
      )
      res = await fetch(`${OPENAI_BASE}/images/edits`, {
        method: 'POST',
        headers: auth,
        body: form,
        signal: timeoutSignal(),
      })
    } else {
      res = await fetch(`${OPENAI_BASE}/images/generations`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: input.instruction }),
        signal: timeoutSignal(),
      })
    }
  } catch (err) {
    throw networkError(err)
  }
  if (!res.ok) throw httpError('OpenAI', res.status, await errorDetail(res))

  const data = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string }[]
    output_format?: string
  } | null
  const b64 = data?.data?.[0]?.b64_json
  if (!b64) {
    throw new AiError('OpenAI returned no image. Try a different instruction.', {
      code: 'empty_response',
      status: 502,
    })
  }
  const fmt = (data?.output_format ?? 'png').toLowerCase()
  return {
    bytes: Buffer.from(b64, 'base64'),
    mime: fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png',
    model,
  }
}

/** Edit (or create) an image with the account's configured provider. */
export async function aiImage(config: AiConfig, input: AiImageInput): Promise<AiImageOutput> {
  if (!input.instruction.trim()) {
    throw new AiError('Describe what the AI should do with the image.', {
      code: 'bad_request',
      status: 400,
    })
  }
  switch (config.provider) {
    case 'gemini':
      return geminiImage(config.apiKey, input)
    case 'openai':
      return openAiImage(config.apiKey, input)
    default:
      throw new AiError(
        'Image editing needs a Gemini or OpenAI key. The AI agent is set up with a provider that only writes text; the caption button still works.',
        { code: 'unsupported_provider', status: 400 },
      )
  }
}
