/**
 * The public https origin this deployment is reachable at — what a
 * third party (the WAHA bridge) must call back to.
 *
 * `NEXT_PUBLIC_SITE_URL` wins when set (same variable the invitation
 * emails use). Otherwise trust the proxy's forwarded host (Vercel,
 * nginx), then the plain Host header.
 */
export function publicOrigin(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }
  return new URL(request.url).origin
}

/** Where the bridge posts events for one channel. */
export function bridgeWebhookUrl(origin: string, channelId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/whatsapp/bridge/webhook/${channelId}`
}
