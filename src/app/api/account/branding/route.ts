import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isAccountMediaUrl } from '@/lib/posts/post'

const MAX_NAME = 40

/**
 * PATCH /api/account/branding   (admin+)
 *
 * Body: { enabled: boolean, name?: string, logo_url?: string | null }
 *
 * Business branding (migration 079): the name and the one logo shown at
 * the top of the portal. The logo must be an image this account
 * uploaded to its own media folder — never an arbitrary address.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
    if (name.length > MAX_NAME) {
      return NextResponse.json({ error: `The business name can be at most ${MAX_NAME} characters` }, { status: 400 })
    }
    const logo = typeof body.logo_url === 'string' && body.logo_url ? body.logo_url : null
    if (logo && !isAccountMediaUrl(logo, process.env.NEXT_PUBLIC_SUPABASE_URL, ctx.accountId)) {
      return NextResponse.json({ error: 'Upload the logo again' }, { status: 400 })
    }
    const enabled = body.enabled === true
    if (enabled && !name && !logo) {
      return NextResponse.json({ error: 'Add a business name or a logo before switching branding on' }, { status: 400 })
    }

    // RLS allows this: accounts_update requires an admin of the account.
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update({ brand_enabled: enabled, brand_name: name || null, brand_logo_url: logo })
      .eq('id', ctx.accountId)
      .select('id, brand_enabled, brand_name, brand_logo_url')
      .single()
    if (error || !data) {
      console.error('[PATCH /api/account/branding]', error)
      return NextResponse.json({ error: 'Could not save the branding' }, { status: 500 })
    }
    return NextResponse.json({ branding: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
