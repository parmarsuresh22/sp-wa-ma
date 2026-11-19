// ============================================================
// Spreadsheet → data tables. One sheet becomes one table: the first
// non-empty row is the header, every later row a record keyed by a
// stable column key (`Student Name` → `student_name`). Pure; no I/O.
// ============================================================

import * as XLSX from 'xlsx'

import { columnKey, type DataColumn } from './columns'

export { columnKey, type DataColumn }

export interface ParsedSheet {
  name: string
  columns: DataColumn[]
  rows: Record<string, string>[]
  /** True when rows were dropped to stay under MAX_ROWS. */
  truncated: boolean
}

export const MAX_ROWS = 20_000
export const MAX_COLUMNS = 60
export const MAX_CELL_CHARS = 2_000

export class TableParseError extends Error {}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)
  }
  return String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_CHARS)
}

const PHONE_HEADER = /phone|mobile|whats\s*app|contact\s*(no|num)|cell|parent.*(no|num)/i

/** The column that most looks like a phone number, by header then by content. */
export function guessPhoneColumn(sheet: Pick<ParsedSheet, 'columns' | 'rows'>): string | null {
  const byHeader = sheet.columns.find((c) => PHONE_HEADER.test(c.name))
  if (byHeader) return byHeader.key
  const sample = sheet.rows.slice(0, 50)
  if (sample.length < 3) return null
  for (const c of sheet.columns) {
    const filled = sample.map((r) => r[c.key] ?? '').filter(Boolean)
    if (filled.length < sample.length * 0.8) continue
    const phones = filled.filter((v) => {
      const digits = v.replace(/\D/g, '')
      return digits.length >= 10 && digits.length <= 15 && /^[+\d\s()-]+$/.test(v)
    })
    if (phones.length >= filled.length * 0.9) return c.key
  }
  return null
}

/** Every non-empty sheet of a workbook (xlsx, xls, csv, tsv, ods). */
export function parseWorkbook(buffer: ArrayBuffer | Uint8Array, filename: string): ParsedSheet[] {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'array', cellDates: true, raw: false })
  } catch (err) {
    throw new TableParseError(
      `Could not read "${filename}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const out: ParsedSheet[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    })
    const grid = raw
      .map((r) => (Array.isArray(r) ? r.map(cellText) : []))
      .filter((r) => r.some((c) => c !== ''))
    if (grid.length === 0) continue

    const width = Math.min(MAX_COLUMNS, Math.max(...grid.map((r) => r.length)))
    const used = new Set<string>()
    const columns: DataColumn[] = []
    for (let i = 0; i < width; i++) {
      const header = grid[0][i] || `Column ${i + 1}`
      columns.push({ key: columnKey(header, used), name: header })
    }

    const body = grid.slice(1)
    const rows: Record<string, string>[] = []
    for (const r of body.slice(0, MAX_ROWS)) {
      const row: Record<string, string> = {}
      for (let i = 0; i < width; i++) {
        const v = r[i] ?? ''
        if (v !== '') row[columns[i].key] = v
      }
      if (Object.keys(row).length > 0) rows.push(row)
    }
    out.push({ name, columns, rows, truncated: body.length > MAX_ROWS })
  }

  if (out.length === 0) throw new TableParseError(`"${filename}" has no data in it`)
  return out
}

/** The spreadsheet id out of any Google Sheets link, or null. */
export function googleSheetId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') return null
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(parsed.pathname)
  return m ? m[1] : null
}
