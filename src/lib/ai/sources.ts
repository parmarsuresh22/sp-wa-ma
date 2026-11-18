// ============================================================
// Knowledge-base sources beyond typed text: spreadsheets and web
// pages. Both end as plain text in `ai_knowledge_documents.content`,
// so chunking, keyword search and embeddings stay exactly as they are.
// ============================================================

import * as XLSX from 'xlsx'

/** Hard cap on extracted text per document (≈ 300 chunks). */
export const MAX_SOURCE_CHARS = 350_000
/** Upload cap. A 5 MB spreadsheet is already tens of thousands of rows. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** Web page cap before we stop reading the response. */
export const MAX_PAGE_BYTES = 3 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods'] as const

export class SourceError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SourceError'
    this.status = status
  }
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function isSpreadsheetFilename(name: string): boolean {
  return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(fileExtension(name))
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)
  return String(v).replace(/\s+/g, ' ').trim()
}

/**
 * Spreadsheet → text the model can read like a table of facts.
 *
 * Each sheet becomes a heading; each data row becomes one line of
 * `Header: value | Header: value`, using the sheet's first non-empty
 * row as headers. A row-per-line layout is what makes keyword search
 * return the right row for "price of X" and lets a chunk hold many
 * complete records instead of half a table.
 */
export function spreadsheetToText(buffer: ArrayBuffer | Uint8Array, filename: string): string {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'array', cellDates: true, raw: false })
  } catch (err) {
    throw new SourceError(
      `Could not read "${filename}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const out: string[] = []
  let chars = 0
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    })
    const nonEmpty = rows
      .map((r) => (Array.isArray(r) ? r.map(cellText) : []))
      .filter((r) => r.some((c) => c !== ''))
    if (nonEmpty.length === 0) continue
    const headers = nonEmpty[0]
    const dataRows = nonEmpty.slice(1)
    const section: string[] = [wb.SheetNames.length > 1 ? `## ${name}` : `## ${filename}`]
    if (dataRows.length === 0) {
      section.push(headers.filter(Boolean).join(' | '))
    }
    for (const row of dataRows) {
      const parts: string[] = []
      for (let i = 0; i < Math.max(headers.length, row.length); i++) {
        const v = row[i] ?? ''
        if (v === '') continue
        const h = headers[i] || `Column ${i + 1}`
        parts.push(`${h}: ${v}`)
      }
      if (parts.length > 0) section.push(parts.join(' | '))
    }
    const text = section.join('\n')
    if (chars + text.length > MAX_SOURCE_CHARS) {
      out.push(text.slice(0, Math.max(0, MAX_SOURCE_CHARS - chars)))
      break
    }
    out.push(text)
    chars += text.length + 2
  }
  const result = out.join('\n\n').trim()
  if (!result) throw new SourceError(`"${filename}" has no readable rows`)
  return result
}

// ------------------------------------------------------------
// Web pages
// ------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

/**
 * HTML → readable text. Drops script/style/nav/footer/header blocks,
 * turns block elements into line breaks and list items into bullets,
 * decodes entities and collapses whitespace. Deliberately simple: a
 * page's main prose survives; chrome mostly does not.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null

  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|template|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  s = s
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|section|article|main|h[1-6]|li|ul|ol|tr|table|blockquote|pre|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<\s*(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ +([.,;:!?%)\]])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: s }
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  if (h.includes(':')) return true // IPv6 literal — not worth the risk
  return false
}

/** Validate a user-supplied page URL: http(s), public host, no creds. */
export function normalizeSourceUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new SourceError('Enter a full web address, e.g. https://example.com/faq')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceError('Only http(s) addresses can be imported')
  }
  if (url.username || url.password) throw new SourceError('Addresses with credentials are not allowed')
  if (isPrivateHost(url.hostname)) throw new SourceError('That address points at a private network')
  url.hash = ''
  return url.toString()
}

/**
 * Fetch a public web page and return its text. Follows redirects,
 * refuses non-HTML/text, stops reading past `MAX_PAGE_BYTES`.
 */
export async function fetchWebsiteText(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; title: string | null; text: string }> {
  const url = normalizeSourceUrl(rawUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; wacrm-knowledge/1.0)',
      },
    })
  } catch (err) {
    clearTimeout(timer)
    throw new SourceError(
      `Could not fetch the page: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
  try {
    if (!res.ok) throw new SourceError(`The page answered HTTP ${res.status}`, 502)
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (ctype && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/.test(ctype)) {
      throw new SourceError(`That address is not a web page (${ctype.split(';')[0]})`)
    }
    const buf = await res.arrayBuffer()
    const bytes = buf.byteLength > MAX_PAGE_BYTES ? buf.slice(0, MAX_PAGE_BYTES) : buf
    const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const { title, text } = ctype.includes('text/plain')
      ? { title: null, text: body.trim() }
      : htmlToText(body)
    if (!text) throw new SourceError('The page has no readable text')
    return { url, title, text: text.slice(0, MAX_SOURCE_CHARS) }
  } finally {
    clearTimeout(timer)
  }
}
