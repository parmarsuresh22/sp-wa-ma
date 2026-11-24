import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const STATUSES = ['valid', 'used', 'cancelled']

/**
 * GET /api/events/:id/passes?status=&q=&page=&size=   (viewer+)
 * The passes of one event; `q` searches the name, the phone number and
 * the pass code (for a guest whose screen will not scan).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('viewer', 'events')
    const { id } = await params
    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? ''
    const q = (url.searchParams.get('q') ?? '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 60)
    const size = Math.min(50, Math.max(1, Number(url.searchParams.get('size')) || 20))
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0)

    let query = supabaseAdmin()
      .from('event_passes')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .eq('event_id', id)
    if (STATUSES.includes(status)) query = query.eq('status', status)
    if (q) query = query.or(`holder_name.ilike.%${q}%,phone_key.ilike.%${q}%,code.ilike.%${q}%`)
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .order('seq', { ascending: true })
      .range(page * size, page * size + size - 1)
    if (error) throw error
    return NextResponse.json({ rows: data ?? [], total: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
