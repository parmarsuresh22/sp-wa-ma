// ============================================================
// Meta webhook fan-out — re-deliver the raw Meta payload elsewhere.
//
// Meta allows exactly one callback URL per Meta App. When wacrm owns
// that URL, anything else that used to receive the webhook directly
// (an n8n WhatsApp Trigger, a Make scenario, a custom bot) stops
// getting events. This module forwards every verified delivery, byte
// for byte, to the URLs listed in `WEBHOOK_FORWARD_URL`, together with
// Meta's own `X-Hub-Signature-256` header. Because neither the body nor
// the header is altered, a receiver that validates Meta's signature
// against the same App Secret keeps accepting the request as if Meta
// had sent it.
//
// Behaviour
//   - `WEBHOOK_FORWARD_URL` unset or empty → no-op.
//   - Several targets: comma-separated, whitespace trimmed.
//   - Best effort, one attempt per target, short timeout, redirects are
//     not followed. Failures are logged and never affect wacrm's own
//     processing or the 200 already returned to Meta.
//   - Only runs after `verifyMetaWebhookSignature` passed in the route,
//     so forged requests are never relayed.
// ============================================================

/** Per-target timeout. n8n answers a trigger almost instantly. */
export const FORWARD_TIMEOUT_MS = 10_000

/** Parse the env value into a de-duplicated list of target URLs. */
export function forwardTargets(
  raw: string | undefined = process.env.WEBHOOK_FORWARD_URL
): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const url = part.trim()
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<{ ok: boolean; status: number }>

/**
 * Forward `rawBody` (the exact bytes Meta signed) to every configured
 * target. `headers` are the inbound request headers; only
 * `content-type` and `x-hub-signature-256` are copied.
 *
 * Resolves once every target has been attempted. Never throws.
 */
export async function forwardMetaWebhook(
  rawBody: string,
  headers: Headers,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const targets = forwardTargets()
  if (targets.length === 0) return

  const outbound: Record<string, string> = {
    'content-type': headers.get('content-type') ?? 'application/json',
    'user-agent': 'wacrm-webhook-forward/1.0',
  }
  const signature = headers.get('x-hub-signature-256')
  if (signature) outbound['x-hub-signature-256'] = signature

  await Promise.all(
    targets.map(async (url) => {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: outbound,
          body: rawBody,
          redirect: 'manual',
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        })
        if (!res.ok) {
          console.warn(
            `[webhook-forward] ${url} responded ${res.status}; event not delivered there`
          )
        }
      } catch (error) {
        console.warn(`[webhook-forward] delivery to ${url} failed:`, error)
      }
    })
  )
}
