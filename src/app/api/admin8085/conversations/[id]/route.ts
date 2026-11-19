import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'

type Params = { params: Promise<{ id: string }> }

const PAGE = 100

/**
 * GET /api/admin8085/conversations/[id]   (platform admin only)
 *
 * The messages of one conversation in any account, newest page first
 * (`?before=<ISO timestamp>` loads older ones). Returned oldest-first
 * within the page so the caller can render it top to bottom.
 */
export async function GET(request: Request, { params }: Params) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }
  const before = new URL(request.url).searchParams.get('before')

  let query = admin.db
    .from('messages')
    .select(
      'id, sender_type, content_type, content_text, media_url, template_name, status, ai_generated, error_title, created_at',
    )
    .eq('conversation_id', id)
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt('created_at', before)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(PAGE + 1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = data ?? []
  const hasMore = rows.length > PAGE
  return NextResponse.json({
    messages: rows.slice(0, PAGE).reverse(),
    hasMore,
  })
}
