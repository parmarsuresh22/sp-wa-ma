import { NextResponse } from 'next/server'
import { fomsAccess } from '@/lib/foms/api'

/**
 * GET /api/aeda-forms/access
 *
 * Tells the menu whether to show AEDA Forms: yes for the platform
 * admin, 404 for everyone else, while the module is being tried out.
 */
export async function GET() {
  const allowed = await fomsAccess().catch(() => null)
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ allowed: true }, { headers: { 'Cache-Control': 'no-store' } })
}
