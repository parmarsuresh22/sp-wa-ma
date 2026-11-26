import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'
import { parsePlanInput } from '@/lib/plans/plans'
import { forgetPlans, listPlans } from '@/lib/plans/server'

/**
 * GET /api/admin8085/plans   (platform admin only)
 * Every plan with its modules, Settings features and limits, and how
 * many accounts are on it.
 */
export async function GET() {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const plans = await listPlans(admin.db)
    const { data } = await admin.db.from('accounts').select('plan_key').limit(10000)
    const counts: Record<string, number> = {}
    for (const row of (data ?? []) as { plan_key: string }[]) counts[row.plan_key] = (counts[row.plan_key] ?? 0) + 1
    return NextResponse.json({ plans: plans.map((p) => ({ ...p, accounts: counts[p.key] ?? 0 })) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * PUT /api/admin8085/plans   (platform admin only)
 *
 * Body: { key, name, description, web_number_limit, sections, features,
 *         max_admins, max_agents, max_viewers }
 *
 * Changes what one plan includes. Every account on the plan follows at
 * once, and their WhatsApp Web number limit is set to the plan's.
 */
export async function PUT(request: Request) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const key = typeof body?.key === 'string' ? body.key : ''
  const parsed = parsePlanInput(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await admin.db
    .from('plans')
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('key', key)
    .select('key')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  const { error: limitError } = await admin.db
    .from('accounts')
    .update({ web_number_limit: parsed.value.web_number_limit })
    .eq('plan_key', key)
  if (limitError) return NextResponse.json({ error: limitError.message }, { status: 500 })
  forgetPlans()
  return NextResponse.json({ success: true })
}
