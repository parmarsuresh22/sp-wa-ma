import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  fetchGoogleSheet,
  replaceTableFromSheet,
  TableImportError,
} from '@/lib/data-tables/import'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/data-tables/[id]/refresh  (admin)
 *
 * Re-import a table that came from a Google Sheet: its columns and rows
 * are replaced by the sheet's current content. Edits made in the app
 * since the last import are overwritten — the sheet is the source.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`data-tables:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: table } = await supabase
      .from('data_tables')
      .select('id, source_type, source_url, source_sheet, phone_column, access')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!table) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 })
    }
    if (table.source_type !== 'google_sheet' || !table.source_url) {
      return NextResponse.json(
        { error: 'Only a table imported from Google Sheets can be refreshed' },
        { status: 400 },
      )
    }

    const { sheets } = await fetchGoogleSheet(table.source_url)
    const sheet = sheets.find((s) => s.name === table.source_sheet) ?? sheets[0]
    const rows = await replaceTableFromSheet(supabase, table, sheet)
    return NextResponse.json({ success: true, rows, truncated: sheet.truncated })
  } catch (err) {
    if (err instanceof TableImportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
