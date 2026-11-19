import { NextResponse } from 'next/server'
import { getSuperAdmin, loadPlatformBridge } from '@/lib/admin/super-admin'

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/**
 * GET /api/admin8085/overview   (platform admin only)
 *
 * Every account with its usage counts, the WhatsApp Web number requests
 * waiting for a decision (plus the latest decided ones), and whether a
 * platform bridge is configured. Anyone else gets a plain 404 — the
 * route does not admit to existing.
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NOT_FOUND()
  const { db } = admin

  const [{ data: accounts, error: statsErr }, { data: requests, error: reqErr }, bridge] =
    await Promise.all([
      db.rpc('platform_account_stats'),
      db
        .from('web_number_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100),
      loadPlatformBridge(db).catch(() => null),
    ])
  if (statsErr || reqErr) {
    return NextResponse.json(
      { error: statsErr?.message ?? reqErr?.message ?? 'Failed to load' },
      { status: 500 },
    )
  }

  // Who asked: requester emails for the request list.
  const requesterIds = [
    ...new Set(((requests ?? []) as { requested_by: string }[]).map((r) => r.requested_by)),
  ]
  const emailById = new Map<string, string>()
  if (requesterIds.length > 0) {
    const { data: profiles } = await db
      .from('profiles')
      .select('user_id, email, full_name')
      .in('user_id', requesterIds)
    for (const p of (profiles ?? []) as { user_id: string; email: string | null }[]) {
      if (p.email) emailById.set(p.user_id, p.email)
    }
  }

  return NextResponse.json({
    accounts: accounts ?? [],
    requests: ((requests ?? []) as Record<string, unknown>[]).map((r) => ({
      ...r,
      requested_by_email: emailById.get(r.requested_by as string) ?? null,
    })),
    bridge: bridge ? { configured: true, url: bridge.baseUrl, source: bridge.source } : { configured: false },
  })
}
