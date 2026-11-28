import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'

/** Where Form Studio runs when nothing else is configured: the admin's own computer. */
const DEFAULT_FOMS_URL = 'http://127.0.0.1:5000'

/**
 * GET /api/foms/access
 *
 * Form Studio (FOMS, the `foms/` folder of this repository) is a
 * separate service for the platform admin only. This tells the menu
 * whether to show its link: the address for the platform admin, 404
 * for everyone else.
 *
 * FOMS has no sign-in of its own, so by default it is reached on the
 * admin's own computer. `FOMS_URL` points the link elsewhere.
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const configured = process.env.FOMS_URL?.trim()
  const url = configured && /^https?:\/\//i.test(configured) ? configured : DEFAULT_FOMS_URL
  return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } })
}
