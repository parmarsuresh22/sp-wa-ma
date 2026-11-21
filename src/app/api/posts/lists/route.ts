import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { guessPhoneColumn, parseWorkbook, TableParseError } from '@/lib/data-tables/parse'
import { extractMobileNumbers, MAX_BROADCAST_RECIPIENTS } from '@/lib/posts/post'

const UUID = /^[0-9a-f-]{36}$/i
const MAX_FILE_BYTES = 5 * 1024 * 1024
const LIST_COLUMNS = 'id, name, channel_id, rows_read, rejected, source_filename, created_at, numbers'

function summary(row: Record<string, unknown>) {
  const numbers = (row.numbers as string[] | null) ?? []
  return {
    id: row.id,
    name: row.name,
    count: numbers.length,
    rows_read: row.rows_read,
    rejected: row.rejected,
    source_filename: row.source_filename,
    created_at: row.created_at,
    // A few numbers so the business can see it is the right file.
    sample: numbers.slice(0, 5),
  }
}

/**
 * GET /api/posts/lists?channel_id=   (agent+)
 *
 * The saved recipient lists of one WhatsApp Web number, newest first.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent', 'posts')
    const channelId = new URL(request.url).searchParams.get('channel_id') ?? ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    const { data, error } = await supabaseAdmin()
      .from('post_recipient_lists')
      .select(LIST_COLUMNS)
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ lists: ((data ?? []) as Record<string, unknown>[]).map(summary) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/posts/lists   (agent+)   multipart: file, channel_id, name?
 *
 * Read a CSV or Excel file, keep only 10-digit mobile numbers (each
 * once), and save them as a list that can be used for this post and
 * again for later ones. The phone column is found by its heading or its
 * content; a file with no recognisable phone column is scanned cell by
 * cell.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent', 'posts')
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const channelId = String(form?.get('channel_id') ?? '')
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV or Excel file' }, { status: 400 })
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'The file is larger than 5 MB' }, { status: 400 })
    if (!/\.(csv|tsv|xlsx|xls|ods)$/i.test(file.name)) {
      return NextResponse.json({ error: 'Use a .csv, .xlsx or .xls file' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, channelId)
    if (!channel || channel.provider !== 'waha') {
      return NextResponse.json({ error: 'Choose a WhatsApp Web number of this account' }, { status: 400 })
    }

    let cells: string[] = []
    try {
      for (const sheet of parseWorkbook(new Uint8Array(await file.arrayBuffer()), file.name)) {
        const column = guessPhoneColumn(sheet)
        for (const row of sheet.rows) {
          if (column) cells.push(row[column] ?? '')
          else cells = cells.concat(Object.values(row))
        }
        // A phone column whose heading is itself a number (a file with
        // no header row) would lose that first number.
        if (column) {
          const heading = sheet.columns.find((c) => c.key === column)?.name ?? ''
          cells.push(heading)
        }
      }
    } catch (err) {
      const message = err instanceof TableParseError ? err.message : 'That file could not be read'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const found = extractMobileNumbers(cells)
    if (found.numbers.length === 0) {
      return NextResponse.json(
        { error: 'No 10-digit mobile numbers were found in that file' },
        { status: 400 },
      )
    }

    const rawName = String(form?.get('name') ?? '').trim() || file.name.replace(/\.[^.]+$/, '')
    const { data, error } = await db
      .from('post_recipient_lists')
      .insert({
        account_id: accountId,
        channel_id: channelId,
        name: rawName.slice(0, 80),
        numbers: found.numbers,
        rows_read: found.read,
        rejected: found.rejected,
        source_filename: file.name.slice(0, 200),
        created_by: userId,
      })
      .select(LIST_COLUMNS)
      .single()
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'Could not save the list' }, { status: 500 })

    return NextResponse.json(
      {
        list: summary(data as Record<string, unknown>),
        duplicates: found.duplicates,
        over_limit: Math.max(0, found.numbers.length - MAX_BROADCAST_RECIPIENTS),
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
