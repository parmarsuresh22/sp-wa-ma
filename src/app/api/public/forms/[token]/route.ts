import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { accountIsBlocked } from '@/lib/auth/blocked-server'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { newSubmissionRef, toFormRow, type FormRow } from '@/lib/aeda-forms/server'
import { checkAnswers } from '@/lib/aeda-forms/schema'

type Params = { params: Promise<{ token: string }> }

/** Per address: reading a form, and sending an answer. */
const READ_LIMIT = { limit: 60, windowMs: 60_000 }
const SUBMIT_LIMIT = { limit: 10, windowMs: 60_000 }
const MAX_BODY = 200_000

function callerIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/** The published form behind a public link, or null (same answer for every reason). */
async function publicForm(token: string): Promise<FormRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
  const { data } = await supabaseAdmin().from('aeda_forms').select('*').eq('public_token', token).maybeSingle()
  if (!data) return null
  const form = toFormRow(data as Record<string, unknown>)
  if (form.status !== 'published' || !form.published_schema || !form.public_enabled || form.archived_at) return null
  if (await accountIsBlocked(form.account_id)) return null
  return form
}

/**
 * GET  /api/public/forms/[token]   the published design of a form (no sign-in)
 * POST /api/public/forms/[token]   { data }  — send an answer
 *
 * The long random token in the address is the permission, and it
 * reaches only this one form. Nothing but the design is ever returned:
 * answers of other people cannot be read here.
 */
export async function GET(request: Request, { params }: Params) {
  const limit = checkRateLimit(`aeda-form-read:${callerIp(request)}`, READ_LIMIT)
  if (!limit.success) return rateLimitResponse(limit)
  const form = await publicForm((await params).token)
  if (!form) return NextResponse.json({ error: 'This form is not available.' }, { status: 404 })
  return NextResponse.json({ name: form.name, schema: form.published_schema }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request, { params }: Params) {
  const limit = checkRateLimit(`aeda-form-submit:${callerIp(request)}`, SUBMIT_LIMIT)
  if (!limit.success) return rateLimitResponse(limit)
  const form = await publicForm((await params).token)
  if (!form || !form.published_schema) return NextResponse.json({ error: 'This form is not available.' }, { status: 404 })

  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'The answer is too large.' }, { status: 413 })
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  // A hidden box people never see; a filled one is a robot. Answer as
  // if it worked, and save nothing.
  if (typeof body?.website === 'string' && body.website.trim()) {
    return NextResponse.json({ ref: newSubmissionRef(), message: form.published_schema.successMessage })
  }

  const checked = checkAnswers(form.published_schema, body?.data)
  if (!checked.ok) return NextResponse.json({ error: 'Some answers need attention.', errors: checked.errors }, { status: 422 })

  const ref = newSubmissionRef()
  const { error } = await supabaseAdmin().from('aeda_form_submissions').insert({
    account_id: form.account_id,
    form_id: form.id,
    version: form.published_version,
    ref,
    data: checked.values,
    stage: form.published_schema.stages[0] ?? null,
    source: 'link',
  })
  if (error) {
    console.error('[public form] save failed:', error.message)
    return NextResponse.json({ error: 'Could not save your answer. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ref, message: form.published_schema.successMessage })
}
