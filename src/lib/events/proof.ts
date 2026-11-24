// ============================================================
// Reading a payment screenshot (migration 080).
//
// The picture a customer sends after paying is shown to the account's
// own AI model, which is asked to copy out what the receipt says:
// amount, who was paid, the reference number, the date. It decides
// nothing — `checkProof` compares those values with the order.
//
// Works with a Gemini or OpenAI key (both read pictures). Without one,
// or when anything fails, the result is null and a person approves the
// payment by looking at the screenshot.
//
// Server-only. Never throws.
// ============================================================

import { GEMINI_OPENAI_COMPAT_URL } from '@/lib/ai/providers/gemini'
import type { AiConfig } from '@/lib/ai/types'
import type { ProofReading } from './types'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const TIMEOUT_MS = 30_000

const PROMPT = [
  'You are shown one picture a customer sent as proof of a UPI payment in India.',
  'Copy out exactly what the picture shows. Do not guess: use null for anything that is not clearly readable.',
  'Answer with one JSON object and nothing else:',
  '{',
  '  "is_payment": true when the picture is a payment receipt / transaction screen of a UPI or bank app, otherwise false,',
  '  "status": "success" | "failed" | "pending" | "unknown" (what the receipt says about the payment),',
  '  "amount": the amount paid in rupees as a number (no currency sign, no commas), or null,',
  '  "utr": the 12-digit UPI reference number (also called UTR, UPI Ref No, UPI transaction ID or RRN) as a string of digits, or null,',
  '  "payee_upi": the UPI ID the money was paid TO (like name@bank), exactly as shown, or null,',
  '  "payee_name": the name the money was paid TO, or null,',
  '  "paid_on": the date of the payment as YYYY-MM-DD, or null',
  '}',
].join('\n')

export function canReadPictures(provider: AiConfig['provider']): boolean {
  return provider === 'gemini' || provider === 'openai'
}

/** Download the screenshot (only from a public https address, and not a huge file). */
export async function fetchProofImage(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    if (!/^https:\/\//.test(url)) return null
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
    return { bytes, mime }
  } catch {
    return null
  }
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim().slice(0, max)
  return clean && clean.toLowerCase() !== 'null' ? clean : null
}

/** Turn the model's answer into a reading, trusting nothing about its shape. */
export function parseProofReading(answer: string): ProofReading | null {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  let amount: number | null = null
  if (typeof raw.amount === 'number' && Number.isFinite(raw.amount)) amount = raw.amount
  else if (typeof raw.amount === 'string') {
    const n = Number(raw.amount.replace(/[^\d.]/g, ''))
    if (raw.amount.trim() && Number.isFinite(n)) amount = n
  }
  if (amount != null && (amount <= 0 || amount > 10_000_000)) amount = null

  const utrDigits = (typeof raw.utr === 'string' || typeof raw.utr === 'number' ? String(raw.utr) : '').replace(/\D/g, '')
  const paidOn = str(raw.paid_on, 10)
  const status = raw.status === 'success' || raw.status === 'failed' || raw.status === 'pending' ? raw.status : 'unknown'

  return {
    is_payment: raw.is_payment === true,
    status,
    amount: amount == null ? null : Math.round(amount * 100) / 100,
    utr: utrDigits.length === 12 ? utrDigits : null,
    payee_upi: str(raw.payee_upi, 120)?.toLowerCase() ?? null,
    payee_name: str(raw.payee_name, 120),
    paid_on: paidOn && /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : null,
  }
}

/** Ask the model what the screenshot says. Null when it cannot be read. */
export async function readPaymentScreenshot(
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey'>,
  image: { bytes: Buffer; mime: string },
): Promise<ProofReading | null> {
  if (!canReadPictures(config.provider)) return null
  const gemini = config.provider === 'gemini'
  try {
    const res = await fetch(gemini ? GEMINI_OPENAI_COMPAT_URL : OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        ...(gemini ? { reasoning_effort: 'low' } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn('[events] screenshot could not be read:', res.status, (await res.text().catch(() => '')).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    return parseProofReading(data.choices?.[0]?.message?.content ?? '')
  } catch (err) {
    console.warn('[events] screenshot could not be read:', err instanceof Error ? err.message : err)
    return null
  }
}
