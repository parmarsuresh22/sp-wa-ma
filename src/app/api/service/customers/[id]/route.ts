import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ServiceError, isUuid, removeServiceCustomer } from '@/lib/service/service'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/service/customers/[id]   (agent+)   — "service-customer-delete"
 * The customer leaves the list and every reminder for them stops at
 * once. Saving an entry for the same number later brings them back.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('agent', 'service')
    const { id } = await params
    if (!isUuid(id) || !(await removeServiceCustomer(supabaseAdmin(), accountId, id))) {
      throw new ServiceError('Customer not found', 404)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof ServiceError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
