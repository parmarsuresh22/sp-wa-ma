import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  decodeEntities,
  fetchWebsiteText,
  htmlToText,
  isSpreadsheetFilename,
  normalizeSourceUrl,
  spreadsheetToText,
} from './sources'

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

describe('spreadsheetToText', () => {
  it('turns each row into a header: value line', () => {
    const text = spreadsheetToText(
      workbook({ Prices: [['Product', 'Price', 'Stock'], ['Widget', 120, 'yes'], ['Gadget', 99.5, '']] }),
      'prices.xlsx',
    )
    expect(text).toBe(
      '## prices.xlsx\nProduct: Widget | Price: 120 | Stock: yes\nProduct: Gadget | Price: 99.5',
    )
  })

  it('names sheets when there are several and skips empty ones', () => {
    const text = spreadsheetToText(
      workbook({ A: [['h'], ['1']], Empty: [[]], B: [['x', 'y'], ['2', '3']] }),
      'two.xlsx',
    )
    expect(text).toContain('## A\nh: 1')
    expect(text).toContain('## B\nx: 2 | y: 3')
    expect(text).not.toContain('Empty')
  })

  it('reads CSV too and rejects a file with nothing in it', () => {
    const csv = new TextEncoder().encode('name,phone\nAsha,+91 1\n')
    expect(spreadsheetToText(csv, 'contacts.csv')).toBe('## contacts.csv\nname: Asha | phone: +91 1')
    expect(() => spreadsheetToText(new TextEncoder().encode(''), 'empty.csv')).toThrow(/no readable rows/)
  })

  it('recognises spreadsheet filenames', () => {
    expect(isSpreadsheetFilename('a.XLSX')).toBe(true)
    expect(isSpreadsheetFilename('a.csv')).toBe(true)
    expect(isSpreadsheetFilename('a.pdf')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('keeps prose, drops chrome and scripts, decodes entities', () => {
    const { title, text } = htmlToText(`
      <html><head><title>Help &amp; FAQ</title><style>p{}</style></head>
      <body><nav><a href="/">Home</a></nav>
      <main><h1>Returns</h1><p>Items can be returned within <b>30 days</b>.</p>
      <ul><li>Keep the receipt</li><li>Unused only</li></ul>
      <script>alert(1)</script></main><footer>© 2026</footer></body></html>`)
    expect(title).toBe('Help & FAQ')
    expect(text).toContain('Returns\nItems can be returned within 30 days.')
    expect(text).toContain('• Keep the receipt')
    expect(text).not.toContain('Home')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('2026')
  })

  it('decodes numeric and named entities', () => {
    expect(decodeEntities('a&#39;b &#x41; &nbsp;&hellip;')).toBe("a'b A  …")
  })
})

describe('normalizeSourceUrl', () => {
  it('accepts public http(s) and strips fragments', () => {
    expect(normalizeSourceUrl(' https://example.com/faq#top ')).toBe('https://example.com/faq')
  })
  it('refuses private hosts, credentials and other schemes', () => {
    expect(() => normalizeSourceUrl('http://localhost/x')).toThrow(/private/)
    expect(() => normalizeSourceUrl('http://10.0.0.5/x')).toThrow(/private/)
    expect(() => normalizeSourceUrl('http://169.254.169.254/latest')).toThrow(/private/)
    expect(() => normalizeSourceUrl('https://u:p@example.com')).toThrow(/credentials/)
    expect(() => normalizeSourceUrl('ftp://example.com')).toThrow(/http/)
    expect(() => normalizeSourceUrl('not a url')).toThrow(/full web address/)
  })
})

describe('fetchWebsiteText', () => {
  it('returns the page text and title', async () => {
    const fetchImpl = (async () =>
      new Response('<html><title>T</title><body><p>Hello world</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch
    const out = await fetchWebsiteText('https://example.com', fetchImpl)
    expect(out).toEqual({ url: 'https://example.com/', title: 'T', text: 'Hello world' })
  })

  it('rejects non-page content and HTTP errors', async () => {
    const pdf = (async () =>
      new Response('x', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch
    await expect(fetchWebsiteText('https://example.com/a.pdf', pdf)).rejects.toThrow(/not a web page/)
    const nf = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(fetchWebsiteText('https://example.com/missing', nf)).rejects.toThrow(/HTTP 404/)
  })
})
