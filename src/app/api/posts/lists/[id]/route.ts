import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/posts/lists/[id]   (agent+)
 *
 * Remove a saved recipient list. Posts already sent with it are not
 * affected; a broadcast still running from it stops at the next batch.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('agent', 'posts')
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'List not found' }, { status: 404 })
    const { error } = await supabaseAdmin()
      .from('post_recipient_lists')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
