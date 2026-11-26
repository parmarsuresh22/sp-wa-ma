import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isSpreadsheetFilename } from '@/lib/ai/sources'
import {
  createTablesFromSheets,
  fetchGoogleSheet,
  MAX_UPLOAD_BYTES,
  TableImportError,
} from '@/lib/data-tables/import'
import { parseWorkbook, TableParseError } from '@/lib/data-tables/parse'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadChannel } from '@/lib/whatsapp/channels'

export const maxDuration = 60

/**
 * POST /api/data-tables/import  (admin)
 *
 * Creates data tables from a spreadsheet — one per sheet:
 *   - multipart: `file` (.xlsx, .xls, .csv, .tsv, .ods), `channel_id?`
 *   - JSON: `{ url, channel_id? }` — a Google Sheets link shared as
 *     "Anyone with the link"
 *
 * `channel_id` attaches the tables to one WhatsApp number.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin', 'data')
    const limit = checkRateLimit(`data-tables:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const ctype = (request.headers.get('content-type') || '').toLowerCase()
    let channelRaw: string | null = null
    let sheets
    let baseName: string
    let source: { type: 'upload'; filename: string } | { type: 'google_sheet'; url: string }

    if (ctype.includes('multipart/form-data')) {
      const form = await request.formData().catch(() => null)
      const file = form?.get('file')
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Choose a spreadsheet file to upload' }, { status: 400 })
      }
      if (!isSpreadsheetFilename(file.name)) {
        return NextResponse.json(
          { error: 'Upload a spreadsheet: .xlsx, .xls, .csv, .tsv or .ods' },
          { status: 400 },
        )
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
          { status: 400 },
        )
      }
      sheets = parseWorkbook(await file.arrayBuffer(), file.name)
      baseName = file.name.replace(/\.[^.]+$/, '') || 'Table'
      source = { type: 'upload', filename: file.name }
      const c = form?.get('channel_id')
      channelRaw = typeof c === 'string' && c ? c : null
    } else {
      const body = (await request.json().catch(() => null)) as
        | { url?: unknown; channel_id?: unknown; name?: unknown }
        | null
      const url = typeof body?.url === 'string' ? body.url : ''
      const fetched = await fetchGoogleSheet(url)
      sheets = fetched.sheets
      baseName =
        typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Google Sheet'
      source = { type: 'google_sheet', url: fetched.url }
      channelRaw = typeof body?.channel_id === 'string' && body.channel_id ? body.channel_id : null
    }

    let channelId: string | null = null
    if (channelRaw) {
      const channel = await loadChannel(supabase, accountId, channelRaw)
      if (!channel) {
        return NextResponse.json({ error: 'Number not found' }, { status: 404 })
      }
      channelId = channel.id
    }

    const tables = await createTablesFromSheets(supabase, {
      accountId,
      userId,
      channelId,
      baseName,
      sheets,
      source,
    })
    return NextResponse.json({ tables })
  } catch (err) {
    if (err instanceof TableImportError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof TableParseError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
