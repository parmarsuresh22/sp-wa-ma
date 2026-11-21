import { NextResponse } from 'next/server'
import { getSuperAdmin, loadPlatformBridge } from '@/lib/admin/super-admin'
import { bridgeInfo, emailsByUserId, loadNumberRequests } from '@/lib/admin/overview'

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/**
 * GET /api/admin8085/overview   (platform admin only)
 *
 * Every account with its usage counts, the WhatsApp Web number requests
 * waiting for a decision (plus the latest decided ones), and whether a
 * platform bridge is configured. Anyone else gets a plain 404 — the
 * route does not admit to existing.
 *
 * The page itself is drawn from `loadAdminHome` (names and requests
 * only); this fills in the counts afterwards and serves "Refresh".
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NOT_FOUND()
  const { db } = admin

  try {
    const [{ data: accounts, error: statsErr }, requests, bridge] = await Promise.all([
      db.rpc('platform_account_stats'),
      loadNumberRequests(db),
      loadPlatformBridge(db).catch(() => null),
    ])
    if (statsErr) return NextResponse.json({ error: statsErr.message }, { status: 500 })

    const emailById = await emailsByUserId(db, requests.requesterIds)
    return NextResponse.json({
      accounts: accounts ?? [],
      requests: requests.rows.map((r) => ({
        ...r,
        requested_by_email: emailById.get(r.requested_by as string) ?? null,
      })),
      bridge: bridgeInfo(bridge),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load' },
      { status: 500 },
    )
  }
}
