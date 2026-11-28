import { NextResponse } from 'next/server'
import { assertId, formsContext, formsErrorResponse, FormsError, loadForm, newSubmissionRef } from '@/lib/aeda-forms/server'
import { checkAnswers } from '@/lib/aeda-forms/schema'

type Params = { params: Promise<{ id: string }> }

const MAX_ROWS = 2000

/**
 * GET    /api/aeda-forms/forms/[id]/submissions          the answers, newest first
 * POST   /api/aeda-forms/forms/[id]/submissions          { data }  — fill the form in from the portal
 *          add `preview: true` to check a working design without saving anything
 * PATCH  /api/aeda-forms/forms/[id]/submissions          { id, data?, stage? }  — edit one answer
 * DELETE /api/aeda-forms/forms/[id]/submissions?sid=…    delete one answer
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const form = await loadForm(ctx, assertId((await params).id))
    const { data, error, count } = await ctx.db
      .from('aeda_form_submissions')
      .select('*', { count: 'exact' })
      .eq('form_id', form.id)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)
    if (error) throw new Error(error.message)
    return NextResponse.json({ submissions: data ?? [], total: count ?? (data ?? []).length, truncated: (count ?? 0) > MAX_ROWS })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const form = await loadForm(ctx, assertId((await params).id))
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const preview = body?.preview === true
    const schema = preview ? form.schema : form.status === 'published' ? form.published_schema : null
    if (!schema) throw new FormsError('Publish the form before filling it in.', 409)
    const checked = checkAnswers(schema, body?.data)
    if (!checked.ok) return NextResponse.json({ error: 'Some answers need attention.', errors: checked.errors }, { status: 422 })
    if (preview) return NextResponse.json({ preview: true, values: checked.values })
    const { data, error } = await ctx.db
      .from('aeda_form_submissions')
      .insert({
        account_id: ctx.accountId,
        form_id: form.id,
        version: form.published_version,
        ref: newSubmissionRef(),
        data: checked.values,
        stage: schema.stages[0] ?? null,
        source: 'portal',
        submitted_by: ctx.userId,
        modified_by: ctx.email,
      })
      .select('*')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'insert failed')
    return NextResponse.json({ submission: data })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const form = await loadForm(ctx, assertId((await params).id))
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const sid = assertId(typeof body?.id === 'string' ? body.id : '')
    const schema = form.published_schema ?? form.schema
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), modified_by: ctx.email }
    if (body && 'data' in body) {
      const checked = checkAnswers(schema, body.data)
      if (!checked.ok) return NextResponse.json({ error: 'Some answers need attention.', errors: checked.errors }, { status: 422 })
      patch.data = checked.values
    }
    if (body && 'stage' in body) {
      if (typeof body.stage !== 'string' || !schema.stages.includes(body.stage)) throw new FormsError('Choose one of the stages of the form')
      patch.stage = body.stage
    }
    const { data, error } = await ctx.db
      .from('aeda_form_submissions')
      .update(patch)
      .eq('id', sid)
      .eq('form_id', form.id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new FormsError('Answer not found', 404)
    return NextResponse.json({ submission: data })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const formId = assertId((await params).id)
    const sid = assertId(new URL(request.url).searchParams.get('sid') ?? '')
    const { error } = await ctx.db
      .from('aeda_form_submissions')
      .delete()
      .eq('id', sid)
      .eq('form_id', formId)
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true })
  } catch (err) {
    return formsErrorResponse(err)
  }
}
