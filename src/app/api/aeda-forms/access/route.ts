import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'

/**
 * GET /api/aeda-forms/access
 *
 * Tells the menu whether to show AEDA Forms: yes for the platform
 * admin, 404 for everyone else, while the module is being tried out.
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ allowed: true }, { headers: { 'Cache-Control': 'no-store' } })
}
