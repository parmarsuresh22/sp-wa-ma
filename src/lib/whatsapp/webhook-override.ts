// ============================================================
// WABA-level alternate callback URL — pure, no I/O.
//
// Meta lets a WhatsApp Business Account carry its own webhook callback
// URL that takes precedence over the Meta App's default one
// (`POST /{waba_id}/subscribed_apps` with `override_callback_uri` +
// `verify_token`). wacrm uses it when something else keeps rewriting
// the app-level URL — typically an n8n WhatsApp Trigger node, which
// re-registers its own URL on the app every time its workflow is
// activated or n8n restarts. With the override in place the WABA's
// `messages` webhooks come to wacrm regardless of what the app-level
// setting says, and wacrm relays them onward via WEBHOOK_FORWARD_URL.
//
// Opt-in via `META_WEBHOOK_OVERRIDE_URL`. Unset → wacrm keeps the
// plain subscribe call, which (per Meta's docs) clears any existing
// override — so once you rely on this, keep the variable set.
// ============================================================

/** Meta caps `override_callback_uri` at 200 characters. */
export const OVERRIDE_URL_MAX_LENGTH = 200

/**
 * Validate and normalise the env value. Returns `null` when unset or
 * unusable (not https, local host, too long) so callers simply skip the
 * override rather than hand Meta a URL it would reject or that could
 * never receive a webhook.
 */
export function resolveOverrideCallbackUrl(
  raw: string | undefined = process.env.META_WEBHOOK_OVERRIDE_URL
): string | null {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  if (value.length > OVERRIDE_URL_MAX_LENGTH) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return null
  }
  // Meta must be able to reach it from the public internet.
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return null
  }
  return value
}
