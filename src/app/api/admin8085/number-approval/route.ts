import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'
import { numberApprovalRequired, setNumberApproval } from '@/lib/admin/number-approval'

/**
 * GET /api/admin8085/number-approval   (platform admin only)
 * { required }: whether a WhatsApp Web number waits for approval.
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ required: await numberApprovalRequired(admin.db) })
}

/**
 * PUT /api/admin8085/number-approval   (platform admin only)
 * Body: { required: boolean }
 */
export async function PUT(request: Request) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = (await request.json().catch(() => null)) as { required?: unknown } | null
  if (typeof body?.required !== 'boolean') {
    return NextResponse.json({ error: 'required must be true or false' }, { status: 400 })
  }
  try {
    await setNumberApproval(admin.db, body.required)
    return NextResponse.json({ success: true, required: body.required })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
