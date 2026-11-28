import { NextResponse } from 'next/server'
import { assertId, cleanName, formsContext, formsErrorResponse, FormsError, loadForm, toFormRow } from '@/lib/aeda-forms/server'
import { cleanSchema, publishProblems } from '@/lib/aeda-forms/schema'

type Params = { params: Promise<{ id: string }> }

/**
 * GET    /api/aeda-forms/forms/[id]   the form and its published versions
 * PATCH  /api/aeda-forms/forms/[id]   one or more of:
 *          { name }             rename
 *          { schema }           save the working design (refused while published)
 *          { publish: true }    publish the working design as a new version
 *          { publish: false }   unpublish, so the design can be edited
 *          { restore: number }  load a published version back into the working design
 *          { public_enabled }   switch the public link on or off
 *          { archived }         archive or restore the form
 * DELETE /api/aeda-forms/forms/[id]   the form and its answers, for good
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const form = await loadForm(ctx, assertId((await params).id))
    const { data: versions } = await ctx.db
      .from('aeda_form_versions')
      .select('version, published_at')
      .eq('form_id', form.id)
      .order('version', { ascending: false })
    return NextResponse.json({ form, versions: versions ?? [] })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const form = await loadForm(ctx, assertId((await params).id))
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') throw new FormsError('Request body must be a JSON object')
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = { updated_at: now }

    if ('name' in body) {
      const name = cleanName(body.name)
      if (!name) throw new FormsError('Give the form a name')
      patch.name = name
    }
    if (typeof body.public_enabled === 'boolean') patch.public_enabled = body.public_enabled
    if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? now : null

    let working = form.schema
    if ('schema' in body) {
      // A published form is locked: what people are filling in must not
      // change under them. Unpublish first.
      if (form.status === 'published' && body.publish !== false) {
        throw new FormsError('This form is published. Unpublish it to change the design.', 409)
      }
      working = cleanSchema(body.schema)
      patch.schema = working
    }

    if (typeof body.restore === 'number') {
      if (form.status === 'published') throw new FormsError('Unpublish the form before restoring a version.', 409)
      const { data: version } = await ctx.db
        .from('aeda_form_versions')
        .select('schema')
        .eq('form_id', form.id)
        .eq('version', body.restore)
        .maybeSingle()
      if (!version) throw new FormsError('Version not found', 404)
      working = cleanSchema((version as { schema: unknown }).schema)
      patch.schema = working
    }

    if (body.publish === true) {
      const problems = publishProblems(working)
      if (problems.length > 0) throw new FormsError(problems.join(' '))
      const version = form.published_version + 1
      const { error: versionError } = await ctx.db.from('aeda_form_versions').insert({
        account_id: ctx.accountId,
        form_id: form.id,
        version,
        schema: working,
        published_by: ctx.userId,
      })
      if (versionError) throw new Error(versionError.message)
      Object.assign(patch, { status: 'published', published_schema: working, published_version: version, published_at: now })
    } else if (body.publish === false) {
      patch.status = 'draft'
    }

    const { data, error } = await ctx.db
      .from('aeda_forms')
      .update(patch)
      .eq('id', form.id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'update failed')
    return NextResponse.json({ form: toFormRow(data as Record<string, unknown>) })
  } catch (err) {
    return formsErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await formsContext()
    const id = assertId((await params).id)
    const { error } = await ctx.db.from('aeda_forms').delete().eq('id', id).eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true })
  } catch (err) {
    return formsErrorResponse(err)
  }
}
