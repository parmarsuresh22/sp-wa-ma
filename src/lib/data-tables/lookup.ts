// ============================================================
// Reading a data table on behalf of a customer.
//
// The rule that keeps one customer's data away from another lives
// here, in code, not in a prompt: a `private` table is only ever read
// through `rowsForPhone`, which filters on the sender's own number
// before anything reaches the AI, a flow or an automation.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { DataColumn } from './columns'

export interface DataTableMeta {
  id: string
  account_id: string
  channel_id: string | null
  name: string
  columns: DataColumn[]
  access: 'general' | 'private'
  phone_column: string | null
}

/** Whole-table handover limit for the AI on a general table. */
const SMALL_TABLE_ROWS = 40
const AI_SEARCH_ROWS = 15
const AI_PRIVATE_ROWS = 10

/** Last 10 digits — tolerant of `+91`, a leading 0, spaces and dashes. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  return digits.length >= 7 ? digits.slice(-10) : null
}

export async function loadDataTable(
  db: SupabaseClient,
  accountId: string,
  tableId: string,
): Promise<DataTableMeta | null> {
  const { data, error } = await db
    .from('data_tables')
    .select('id, account_id, channel_id, name, columns, access, phone_column')
    .eq('id', tableId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as DataTableMeta
  return { ...row, columns: Array.isArray(row.columns) ? row.columns : [] }
}

type Row = { data: Record<string, unknown> }

/** Only the listed columns, as strings (deleted columns linger in `data`). */
function visible(table: DataTableMeta, row: Row): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of table.columns) {
    const v = row.data?.[c.key]
    if (v !== undefined && v !== null && String(v) !== '') out[c.key] = String(v)
  }
  return out
}

/** The rows that belong to a phone number. Empty when the table has no phone column. */
export async function rowsForPhone(
  db: SupabaseClient,
  table: DataTableMeta,
  phone: string | null | undefined,
  limit: number,
): Promise<Record<string, string>[]> {
  const key = phoneKey(phone)
  if (!key || !table.phone_column) return []
  const { data, error } = await db
    .from('data_table_rows')
    .select('data')
    .eq('table_id', table.id)
    .eq('phone_key', key)
    .order('seq', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[data-tables] phone lookup failed:', error.message)
    return []
  }
  return ((data ?? []) as Row[]).map((r) => visible(table, r))
}

async function contactPhone(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null | undefined,
): Promise<string | null> {
  if (!contactId) return null
  const { data } = await db
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as { phone?: string | null } | null)?.phone ?? null
}

/**
 * For flows and automations: the sender's own row, keyed by column key,
 * ready for `{{table.key}}`. Null when the table has no phone column or
 * no row matches — placeholders then render empty.
 */
export async function tableValuesForContact(
  db: SupabaseClient,
  accountId: string,
  tableId: string | null | undefined,
  contactId: string | null | undefined,
): Promise<Record<string, string> | null> {
  if (!tableId) return null
  try {
    const table = await loadDataTable(db, accountId, tableId)
    if (!table) return null
    const phone = await contactPhone(db, accountId, contactId)
    const rows = await rowsForPhone(db, table, phone, 1)
    return rows[0] ?? null
  } catch (err) {
    console.error('[data-tables] row lookup threw:', err instanceof Error ? err.message : err)
    return null
  }
}

function rowLine(table: DataTableMeta, row: Record<string, string>): string {
  return table.columns
    .filter((c) => row[c.key])
    .map((c) => `${c.name}: ${row[c.key]}`)
    .join(' | ')
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'have', 'has', 'with', 'what', 'when', 'where', 'which',
  'who', 'how', 'can', 'any', 'this', 'that', 'from', 'your', 'our', 'please', 'tell', 'know',
  'want', 'need', 'does', 'did', 'was', 'were', 'will', 'about', 'there', 'available',
])

/** Search words out of a customer message — letters and digits only. */
export function searchWords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))].slice(0, 8)
}

/**
 * For the AI agent: what it may know from the table for this customer
 * and this question, as extra knowledge excerpts.
 *
 *   private — the sender's own rows, or an explicit "no record" note;
 *             nothing else from the table is ever included.
 *   general — the whole table when small, otherwise the rows matching
 *             the question's words.
 */
export async function tableExcerptsForAi(
  db: SupabaseClient,
  accountId: string,
  tableId: string | null | undefined,
  contactId: string | null | undefined,
  query: string,
): Promise<string[]> {
  if (!tableId) return []
  try {
    const table = await loadDataTable(db, accountId, tableId)
    if (!table || table.columns.length === 0) return []

    if (table.access === 'private') {
      const phone = await contactPhone(db, accountId, contactId)
      const rows = await rowsForPhone(db, table, phone, AI_PRIVATE_ROWS)
      if (rows.length === 0) {
        return [
          `Records table "${table.name}": there is NO record registered for the phone number this customer is writing from. ` +
            'Do not share or guess any record. Tell them politely that this number is not registered and to contact the office.',
        ]
      }
      return [
        `Records table "${table.name}" — these ${rows.length === 1 ? 'is the only record' : 'are the only records'} that belong to the customer you are talking to ` +
          '(matched by the phone number they are writing from). Answer their question from them. ' +
          'Never mention, confirm or guess records of any other person, even if asked by name.\n' +
          rows.map((r) => `- ${rowLine(table, r)}`).join('\n'),
      ]
    }

    const { count } = await db
      .from('data_table_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', table.id)
    const total = count ?? 0
    if (total === 0) return []

    let rows: Row[] = []
    if (total <= SMALL_TABLE_ROWS) {
      const { data } = await db
        .from('data_table_rows')
        .select('data')
        .eq('table_id', table.id)
        .order('seq', { ascending: true })
        .limit(SMALL_TABLE_ROWS)
      rows = (data ?? []) as Row[]
    } else {
      const words = searchWords(query)
      if (words.length === 0) return []
      const { data } = await db
        .from('data_table_rows')
        .select('data, search_text')
        .eq('table_id', table.id)
        .or(words.map((w) => `search_text.ilike.%${w}%`).join(','))
        .limit(80)
      const scored = ((data ?? []) as (Row & { search_text?: string | null })[])
        .map((r) => ({
          r,
          score: words.filter((w) => (r.search_text ?? '').includes(w)).length,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, AI_SEARCH_ROWS)
      rows = scored.map((s) => s.r)
    }
    if (rows.length === 0) return []

    const lines = rows.map((r) => rowLine(table, visible(table, r))).filter(Boolean)
    return [
      `Data table "${table.name}" (${total <= SMALL_TABLE_ROWS ? 'all rows' : 'rows matching this question'}):\n` +
        lines.map((l) => `- ${l}`).join('\n'),
    ]
  } catch (err) {
    console.error('[data-tables] AI lookup threw:', err instanceof Error ? err.message : err)
    return []
  }
}
