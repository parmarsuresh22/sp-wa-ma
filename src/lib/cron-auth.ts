import { timingSafeEqual } from 'node:crypto'

/**
 * Shared-secret check for the cron routes.
 *
 * Two ways in, so both an external pinger (n8n, curl) and Vercel Cron
 * work:
 *   - `x-cron-secret: <AUTOMATION_CRON_SECRET>` — the header the docs
 *     have always described;
 *   - `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron sends
 *     automatically when the `CRON_SECRET` env var is set (it also
 *     accepts `AUTOMATION_CRON_SECRET` as the bearer value).
 *
 * `unconfigured` when neither secret is set, so a route can answer 503
 * and the operator sees the missing env var rather than a silent 401.
 */
export type CronAuthState = 'ok' | 'unauthorized' | 'unconfigured'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function cronAuthState(request: Request): CronAuthState {
  const header = process.env.AUTOMATION_CRON_SECRET?.trim() || ''
  const vercel = process.env.CRON_SECRET?.trim() || ''
  if (!header && !vercel) return 'unconfigured'

  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (supplied && header && safeEqual(supplied, header)) return 'ok'

  const auth = request.headers.get('authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (bearer && vercel && safeEqual(bearer, vercel)) return 'ok'
  if (bearer && header && safeEqual(bearer, header)) return 'ok'

  return 'unauthorized'
}
