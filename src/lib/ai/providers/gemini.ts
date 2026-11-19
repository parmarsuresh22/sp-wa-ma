import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Google Gemini adapter.
//
// Talks to Gemini's OpenAI-compatible surface rather than the native
// `generateContent` API: same request/response shape as the OpenAI
// adapter (system message, `choices[0].message.content`, `usage`), so
// one less payload format to maintain, and the compatibility layer is
// documented as supporting chat completions, tool calling and
// structured output. Auth is the Gemini API key as a Bearer token.
//
// Two Gemini-specific details:
//   - Thinking models count reasoning tokens against `max_tokens`. With
//     our WhatsApp-sized cap a reply can come back empty once thinking
//     has used the budget, so we ask for low reasoning effort and give
//     the cap extra headroom. The cap bounds spend; it is not a charge.
//   - A bad key is reported as HTTP 400 ("API key not valid"), not 401,
//     so the error mapping looks at the message as well as the status
//     to keep the settings page's "key rejected" message accurate.
// ============================================================

export const GEMINI_OPENAI_COMPAT_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

/** Headroom for thinking tokens (see header comment). */
export const GEMINI_MAX_TOKENS = MAX_OUTPUT_TOKENS * 4

interface GeminiCompatResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Pull Gemini's error message out of a non-2xx body. The compat layer
 * usually returns `{ error: { message } }`, but has been seen wrapping
 * it in an array; tolerate both plus plain-string errors.
 */
async function readErrorDetail(res: Response): Promise<string> {
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

/** Map a non-2xx Gemini response to a typed AiError. */
export async function geminiHttpError(res: Response): Promise<AiError> {
  const provider = 'Gemini'
  const detail = await readErrorDetail(res)
  const { status } = res
  const looksLikeBadKey =
    status === 401 ||
    status === 403 ||
    (status === 400 && /api key/i.test(detail))

  const code = looksLikeBadKey
    ? 'invalid_key'
    : status === 429
      ? 'rate_limited'
      : 'provider_error'
  const base =
    code === 'invalid_key'
      ? t('ai.invalidKey', { provider })
      : code === 'rate_limited'
        ? t('ai.rateLimited', { provider })
        : t('ai.apiError', { provider, status: String(status) })

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Gemini expects the dialogue to open with the customer. A thread the
 * business started (a wish, a broadcast, a message typed on the phone)
 * opens with an assistant turn, so lead with a neutral customer-side
 * marker instead of dropping that context.
 */
export function normalizeForGemini(messages: ProviderArgs['messages']): ProviderArgs['messages'] {
  const merged = mergeConsecutive(messages)
  if (merged.length > 0 && merged[0].role === 'assistant') {
    return [{ role: 'user', content: '(The business started this conversation.)' }, ...merged]
  }
  return merged
}

/**
 * Call Gemini (OpenAI-compatible chat completions) with the caller's own
 * key. Returns the raw assistant text + token usage; handoff parsing
 * happens in `generateReply`.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(GEMINI_OPENAI_COMPAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...normalizeForGemini(messages),
        ],
        max_tokens: GEMINI_MAX_TOKENS,
        reasoning_effort: 'low',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await geminiHttpError(res)
  }

  const data = (await res.json().catch(() => null)) as GeminiCompatResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError(t('ai.emptyResponse', { provider: 'Gemini' }), {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
