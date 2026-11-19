// ============================================================
// Server-side import: write parsed sheets into data_tables /
// data_table_rows, and fetch a Google Sheet as a workbook.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  googleSheetId,
  guessPhoneColumn,
  parseWorkbook,
  TableParseError,
  type ParsedSheet,
} from './parse'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const INSERT_CHUNK = 500

export class TableImportError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Download a Google Sheet (shared "anyone with the link") as xlsx. */
export async function fetchGoogleSheet(url: string): Promise<{ sheets: ParsedSheet[]; url: string }> {
  const id = googleSheetId(url)
  if (!id) {
    throw new TableImportError('Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…)')
  }
  const canonical = `https://docs.google.com/spreadsheets/d/${id}`
  let res: Response
  try {
    res = await fetch(`${canonical}/export?format=xlsx`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new TableImportError('Could not reach Google Sheets. Try again in a moment.', 502)
  }
  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (!res.ok || type.includes('text/html')) {
    throw new TableImportError(
      'Google did not hand over the sheet. In Google Sheets choose Share → General access → "Anyone with the link" (Viewer), then try again.',
    )
  }
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new TableImportError(`The sheet is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  }
  try {
    return { sheets: parseWorkbook(buffer, 'Google Sheet'), url: canonical }
  } catch (err) {
    if (err instanceof TableParseError) throw new TableImportError(err.message)
    throw err
  }
}

async function insertRows(
  db: SupabaseClient,
  tableId: string,
  rows: Record<string, string>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((data) => ({ table_id: tableId, data }))
    const { error } = await db.from('data_table_rows').insert(chunk)
    if (error) throw new TableImportError(`Could not save the rows: ${error.message}`, 500)
  }
}

export interface CreatedTable {
  id: string
  name: string
  rows: number
  truncated: boolean
}

/**
 * One table per sheet. A sheet with a recognisable phone column starts
 * out `private` — the safe default for personal records; the user can
 * switch it to general.
 */
export async function createTablesFromSheets(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    channelId: string | null
    baseName: string
    sheets: ParsedSheet[]
    source:
      | { type: 'upload'; filename: string }
      | { type: 'google_sheet'; url: string }
  },
): Promise<CreatedTable[]> {
  const created: CreatedTable[] = []
  for (const sheet of args.sheets) {
    const phoneColumn = guessPhoneColumn(sheet)
    const name = (
      args.sheets.length > 1 ? `${args.baseName} – ${sheet.name}` : args.baseName
    ).slice(0, 120)
    const { data, error } = await db
      .from('data_tables')
      .insert({
        account_id: args.accountId,
        channel_id: args.channelId,
        name,
        columns: sheet.columns,
        access: phoneColumn ? 'private' : 'general',
        phone_column: phoneColumn,
        source_type: args.source.type,
        source_url: args.source.type === 'google_sheet' ? args.source.url : null,
        source_filename: args.source.type === 'upload' ? args.source.filename : null,
        source_sheet: sheet.name,
        created_by: args.userId,
      })
      .select('id')
      .single()
    if (error || !data) {
      throw new TableImportError(`Could not create the table: ${error?.message ?? 'unknown error'}`, 500)
    }
    try {
      await insertRows(db, data.id, sheet.rows)
    } catch (err) {
      await db.from('data_tables').delete().eq('id', data.id)
      throw err
    }
    created.push({ id: data.id, name, rows: sheet.rows.length, truncated: sheet.truncated })
  }
  return created
}

/** Replace a table's columns and rows with a fresh copy of its sheet. */
export async function replaceTableFromSheet(
  db: SupabaseClient,
  table: { id: string; phone_column: string | null; access: string },
  sheet: ParsedSheet,
): Promise<number> {
  const keepPhone =
    table.phone_column && sheet.columns.some((c) => c.key === table.phone_column)
      ? table.phone_column
      : guessPhoneColumn(sheet)
  // A private table must keep a phone column; without one nobody matches,
  // which is the safe failure.
  const { error: metaError } = await db
    .from('data_tables')
    .update({ columns: sheet.columns, phone_column: keepPhone })
    .eq('id', table.id)
  if (metaError) throw new TableImportError(metaError.message, 500)

  const { error: delError } = await db.from('data_table_rows').delete().eq('table_id', table.id)
  if (delError) throw new TableImportError(delError.message, 500)
  await insertRows(db, table.id, sheet.rows)
  return sheet.rows.length
}
