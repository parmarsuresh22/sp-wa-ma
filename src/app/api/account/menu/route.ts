import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { cleanSections } from '@/lib/auth/sections'

/**
 * PATCH /api/account/menu   (owner)
 *
 * Body: { hidden: string[] }  — module keys to leave out of the menu
 *
 * Menu modules (migration 087): the owner decides which modules the
 * menu shows for everyone in the account. Hiding a module only tidies
 * the menu; it does not switch the module off.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('owner')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const hidden = cleanSections(body?.hidden)
    if (!hidden) {
      return NextResponse.json({ error: 'hidden must be a list of module keys' }, { status: 400 })
    }

    // RLS allows this: accounts_update requires an admin of the account.
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update({ menu_hidden: hidden })
      .eq('id', ctx.accountId)
      .select('id, menu_hidden')
      .single()
    if (error || !data) {
      console.error('[PATCH /api/account/menu]', error)
      return NextResponse.json({ error: 'Could not save the menu' }, { status: 500 })
    }
    return NextResponse.json({ menu_hidden: data.menu_hidden })
  } catch (err) {
    return toErrorResponse(err)
  }
}
