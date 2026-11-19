import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

type Params = { params: Promise<{ id: string }> }

/**
 * DELETE /api/posts/[id]   (agent+)
 *
 * Remove a post from the history. What was already published stays
 * published, and the image stays in storage (a chat message or another
 * post may be showing it).
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { accountId } = await requireRole('agent')
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }
    const { data, error } = await supabaseAdmin()
      .from('posts')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
