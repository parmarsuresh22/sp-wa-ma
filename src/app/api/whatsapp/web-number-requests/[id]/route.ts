import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/whatsapp/web-number-requests/[id]   (admin+)
 *
 * Withdraw a pending request, or dismiss a rejected one from the list.
 * An approved request is history — its number is removed like any
 * other number.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { accountId } = await requireRole('admin')
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }

    const { data, error } = await supabaseAdmin()
      .from('web_number_requests')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('account_id', accountId)
      .in('status', ['pending', 'rejected'])
      .select('id')
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Request not found or already decided' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
