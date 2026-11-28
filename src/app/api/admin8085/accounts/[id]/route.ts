import { NextResponse } from 'next/server'
import { getSuperAdmin } from '@/lib/admin/super-admin'
import { forgetPlans } from '@/lib/plans/server'
import { BLOCK_DURATION } from '@/lib/auth/blocked'
import { forgetBlockedAccounts } from '@/lib/auth/blocked-server'

type Params = { params: Promise<{ id: string }> }

const PAGE = 50
const UUID = /^[0-9a-f-]{36}$/i

/** PostgREST `or` filters split on commas/parens — keep search plain. */
function cleanSearch(raw: string | null): string {
  return (raw ?? '').replace(/[^\p{L}\p{N} +@._-]/gu, ' ').trim().slice(0, 60)
}

/**
 * GET /api/admin8085/accounts/[id]   (platform admin only)
 *
 *   (no section)            members, numbers, AI agent, flows,
 *                           automations, broadcasts, data tables
 *   ?section=conversations  chats, newest first   (&offset=&limit=&q=)
 *   ?section=contacts       contacts, newest first (&offset=&q=)
 *
 * Secrets (tokens, API keys) are never selected.
 */
export async function GET(request: Request, { params }: Params) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { db } = admin

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const url = new URL(request.url)
  const section = url.searchParams.get('section')
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
  const q = cleanSearch(url.searchParams.get('q'))
  // Rows per page: the screen asks for 10 on a phone and 20 otherwise.
  const requested = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const pageSize = Number.isInteger(requested) && requested >= 1 && requested <= PAGE ? requested : PAGE

  if (section === 'conversations') {
    let query = db
      .from('conversations')
      .select(
        'id, status, channel_id, last_message_text, last_message_at, unread_count, created_at, contact:contacts!inner(id, name, phone)',
        { count: 'exact' },
      )
      .eq('account_id', id)
    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`, { referencedTable: 'contacts' })
    const { data, error, count } = await query
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rows: data ?? [], total: count ?? 0, pageSize })
  }

  if (section === 'contacts') {
    let query = db
      .from('contacts')
      .select('id, name, phone, email, company, created_at', { count: 'exact' })
      .eq('account_id', id)
      .eq('is_group', false)
    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rows: data ?? [], total: count ?? 0, pageSize })
  }

  const [account, members, channels, ai, flows, automations, broadcasts, tables] = await Promise.all([
    db.from('accounts').select('id, name, created_at, web_number_limit, plan_key, blocked_at').eq('id', id).maybeSingle(),
    db
      .from('profiles')
      .select('user_id, full_name, email, account_role, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: true }),
    db
      .from('whatsapp_config')
      .select('id, provider, label, display_phone, status, bridge_status, is_default, connected_at, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: true }),
    db
      .from('ai_configs')
      .select('provider, model, is_active, auto_reply_enabled, system_prompt, updated_at')
      .eq('account_id', id)
      .maybeSingle(),
    db
      .from('flows')
      .select('id, name, status, trigger_type, execution_count, last_executed_at, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    db
      .from('automations')
      .select('id, name, is_active, trigger_type, execution_count, last_executed_at, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, sent_count, delivered_count, read_count, failed_count, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    db
      .from('data_tables')
      .select('id, name, access, source_type, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
  ])
  if (!account.data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  // Last sign-in per member, from the auth admin API (best-effort).
  const memberRows = (members.data ?? []) as {
    user_id: string
    full_name: string | null
    email: string | null
    account_role: string
    created_at: string
  }[]
  const signIns = await Promise.all(
    memberRows.map(async (m) => {
      try {
        const { data } = await db.auth.admin.getUserById(m.user_id)
        return data.user?.last_sign_in_at ?? null
      } catch {
        return null
      }
    }),
  )

  return NextResponse.json({
    account: account.data,
    members: memberRows.map((m, i) => ({ ...m, last_sign_in_at: signIns[i] })),
    channels: channels.data ?? [],
    ai: ai.data ?? null,
    flows: flows.data ?? [],
    automations: automations.data ?? [],
    broadcasts: broadcasts.data ?? [],
    dataTables: tables.data ?? [],
  })
}

/**
 * PATCH /api/admin8085/accounts/[id]   (platform admin only)
 *
 * Body: { web_number_limit: number }  — 0 to 50, or
 *       { plan_key: string }          — the subscription. It replaces
 *       the plan the account had, and sets the number limit to the new
 *       plan's, or
 *       { blocked: boolean }          — block the account (none of its
 *       people can sign in or use the portal; they are told to write to
 *       support) or reactivate it. Nothing of the account is deleted.
 */
export async function PATCH(request: Request, { params }: Params) {
  const admin = await getSuperAdmin()
  if (!admin) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (typeof body?.blocked === 'boolean') {
    const blocked = body.blocked
    const { data: members, error: membersError } = await admin.db
      .from('profiles')
      .select('user_id')
      .eq('account_id', id)
    if (membersError) return NextResponse.json({ error: membersError.message }, { status: 500 })
    const userIds = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id)
    // Blocking the account you are signed in with would lock the
    // platform admin out of this very page.
    if (blocked && userIds.includes(admin.userId)) {
      return NextResponse.json({ error: 'This is your own account; it cannot be blocked.' }, { status: 400 })
    }
    const { data: changed, error: blockError } = await admin.db
      .from('accounts')
      .update({ blocked_at: blocked ? new Date().toISOString() : null })
      .eq('id', id)
      .select('id')
    if (blockError) return NextResponse.json({ error: blockError.message }, { status: 500 })
    if (!changed || changed.length === 0) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    forgetBlockedAccounts()
    // The sign-in service refuses each of its people from now on (and
    // stops renewing sessions they already have), or lets them back in.
    const refused: string[] = []
    await Promise.all(
      userIds.map(async (userId) => {
        const { error } = await admin.db.auth.admin.updateUserById(userId, {
          ban_duration: blocked ? BLOCK_DURATION : 'none',
        })
        if (error) refused.push(userId)
      }),
    )
    if (refused.length > 0) {
      console.error('[admin] sign-in state not changed for', refused.length, 'member(s) of account', id)
    }
    return NextResponse.json({ success: true, blocked, members: userIds.length, failed: refused.length })
  }
  if (typeof body?.plan_key === 'string') {
    const { data: plan } = await admin.db
      .from('plans')
      .select('key, name, web_number_limit')
      .eq('key', body.plan_key)
      .maybeSingle()
    if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 400 })
    const { data: changed, error: planError } = await admin.db
      .from('accounts')
      .update({ plan_key: plan.key, web_number_limit: plan.web_number_limit })
      .eq('id', id)
      .select('id')
    if (planError) return NextResponse.json({ error: planError.message }, { status: 500 })
    if (!changed || changed.length === 0) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    forgetPlans()
    return NextResponse.json({ success: true, plan_key: plan.key, web_number_limit: plan.web_number_limit })
  }

  const limit = body?.web_number_limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 50) {
    return NextResponse.json(
      { error: 'web_number_limit must be a whole number from 0 to 50' },
      { status: 400 },
    )
  }
  const { data, error } = await admin.db
    .from('accounts')
    .update({ web_number_limit: limit })
    .eq('id', id)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, web_number_limit: limit })
}
