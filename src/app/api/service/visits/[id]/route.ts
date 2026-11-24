import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ServiceError, isUuid, removeServiceVisit, updateServiceVisit } from '@/lib/service/service'

type Params = { params: Promise<{ id: string }> }

const fail = (err: unknown) =>
  err instanceof ServiceError
    ? NextResponse.json({ ok: false, error: err.message }, { status: err.status })
    : toErrorResponse(err)

/**
 * PATCH /api/service/visits/[id]   (agent+)   — "service-visit-update"
 * Same body as a new entry. Nothing is sent; reminders follow the new date.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('agent', 'service')
    const { id } = await params
    if (!isUuid(id)) throw new ServiceError('Visit not found', 404)
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const visit = await updateServiceVisit(supabaseAdmin(), accountId, id, body ?? {})
    return NextResponse.json({ ok: true, visit })
  } catch (err) {
    return fail(err)
  }
}

/**
 * DELETE /api/service/visits/[id]   (agent+)   — "service-visit-delete"
 * The visit is hidden and its reminders stop.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('agent', 'service')
    const { id } = await params
    if (!isUuid(id) || !(await removeServiceVisit(supabaseAdmin(), accountId, id))) {
      throw new ServiceError('Visit not found', 404)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return fail(err)
  }
}
