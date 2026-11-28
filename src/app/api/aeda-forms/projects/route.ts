import { NextResponse } from 'next/server'
import { cleanName, formsContext, formsErrorResponse, FormsError } from '@/lib/aeda-forms/server'

/**
 * GET /api/aeda-forms/projects        every project, with its number of forms
 * POST /api/aeda-forms/projects       { name, description? }
 *
 * Platform admin only while the module is being tried out.
 */
export async function GET() {
  try {
    const ctx = await formsContext()
    const [{ data: projects, error }, { data: forms }] = await Promise.all([
      ctx.db.from('aeda_form_projects').select('*').eq('account_id', ctx.accountId).order('created_at', { ascending: false }),
      ctx.db.from('aeda_forms').select('project_id, archived_at').eq('account_id', ctx.accountId),
    ])
    if (error) throw new Error(error.message)
    const counts = new Map<string, number>()
    for (const f of (forms ?? []) as { project_id: string; archived_at: string | null }[]) {
      if (!f.archived_at) counts.set(f.project_id, (counts.get(f.project_id) ?? 0) + 1)
    }
    return NextResponse.json({
      projects: ((projects ?? []) as Record<string, unknown>[]).map((p) => ({ ...p, form_count: counts.get(String(p.id)) ?? 0 })),
    })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await formsContext()
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const name = cleanName(body?.name)
    if (!name) throw new FormsError('Give the project a name')
    const { data, error } = await ctx.db
      .from('aeda_form_projects')
      .insert({ account_id: ctx.accountId, name, description: cleanName(body?.description, 300) || null, created_by: ctx.userId })
      .select('*')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'insert failed')
    return NextResponse.json({ project: { ...data, form_count: 0 } })
  } catch (err) {
    return formsErrorResponse(err)
  }
}
