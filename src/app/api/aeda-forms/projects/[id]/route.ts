import { NextResponse } from 'next/server'
import {
  assertId,
  cleanName,
  formsContext,
  formsErrorResponse,
  FormsError,
  newPublicToken,
  toFormRow,
} from '@/lib/aeda-forms/server'
import { emptySchema } from '@/lib/aeda-forms/schema'

type Params = { params: Promise<{ id: string }> }

/**
 * GET    /api/aeda-forms/projects/[id]   the project and its forms (with answer counts)
 * POST   /api/aeda-forms/projects/[id]   { name }  — a new form in the project
 * PATCH  /api/aeda-forms/projects/[id]   { name?, description?, archived? }
 * DELETE /api/aeda-forms/projects/[id]   the project, its forms and their answers, for good
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const id = assertId((await params).id)
    const { data: project } = await ctx.db.from('aeda_form_projects').select('*').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()
    if (!project) throw new FormsError('Project not found', 404)
    const { data: rows, error } = await ctx.db
      .from('aeda_forms')
      .select('*')
      .eq('project_id', id)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    const forms = ((rows ?? []) as Record<string, unknown>[]).map(toFormRow)
    const counts = await Promise.all(
      forms.map((f) =>
        ctx.db.from('aeda_form_submissions').select('id', { count: 'exact', head: true }).eq('form_id', f.id).then((r) => r.count ?? 0),
      ),
    )
    return NextResponse.json({
      project,
      forms: forms.map((f, i) => ({
        id: f.id,
        name: f.name,
        status: f.status,
        published_version: f.published_version,
        archived_at: f.archived_at,
        updated_at: f.updated_at,
        field_count: f.schema.fields.length,
        submission_count: counts[i],
      })),
    })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const id = assertId((await params).id)
    const { data: project } = await ctx.db.from('aeda_form_projects').select('id').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()
    if (!project) throw new FormsError('Project not found', 404)
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const name = cleanName(body?.name)
    if (!name) throw new FormsError('Give the form a name')
    const { data, error } = await ctx.db
      .from('aeda_forms')
      .insert({
        account_id: ctx.accountId,
        project_id: id,
        name,
        schema: emptySchema(),
        public_token: newPublicToken(),
        created_by: ctx.userId,
      })
      .select('*')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'insert failed')
    return NextResponse.json({ form: toFormRow(data as Record<string, unknown>) })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const id = assertId((await params).id)
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body && 'name' in body) {
      const name = cleanName(body.name)
      if (!name) throw new FormsError('Give the project a name')
      patch.name = name
    }
    if (body && 'description' in body) patch.description = cleanName(body.description, 300) || null
    if (body && typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null
    const { data, error } = await ctx.db
      .from('aeda_form_projects')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new FormsError('Project not found', 404)
    return NextResponse.json({ project: data })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const id = assertId((await params).id)
    const { error } = await ctx.db.from('aeda_form_projects').delete().eq('id', id).eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true })
  } catch (err) {
    return formsErrorResponse(err)
  }
}
