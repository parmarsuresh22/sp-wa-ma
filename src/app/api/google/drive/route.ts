import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { driveStatus } from '@/lib/google/drive'

/**
 * GET /api/google/drive
 *
 * Whether Google Drive is available on this site (`configured`) and
 * connected for this account (`connected`, `email`). Any member.
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    return NextResponse.json(await driveStatus(supabaseAdmin(), accountId))
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/google/drive   (admin+)
 *
 * Disconnect: forget the saved Google access. Files already saved stay
 * in the person's Drive.
 */
export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    const { error } = await supabaseAdmin()
      .from('google_drive_connections')
      .delete()
      .eq('account_id', accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
