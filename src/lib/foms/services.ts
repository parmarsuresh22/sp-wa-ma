// ============================================================
// AEDA Forms (FOMS): the parts of the original backend that reach
// outside — sending email (SendGrid or SMTP), HTTP calls made by a
// workflow or an API Fetch field, and building CSV / Excel files.
// Ported from foms/web-automation_app.py.
// ============================================================

import nodemailer from 'nodemailer'
import * as XLSX from 'xlsx'

import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { str, template, type Attachment, type HttpResult, type Json, type MailDraft } from './engine'

// ------------------------------------------------------------
// Email
// ------------------------------------------------------------

export interface EmailAccount extends Json {
  id: string
  name: string
  provider: string
  from_email: string
  from_name: string
  sendgrid_api_key: string
  smtp_host: string
  smtp_port: string
  smtp_user: string
  smtp_pass: string
  smtp_tls: string
}

export function pickAccount(accounts: EmailAccount[], accountId: unknown): EmailAccount | null {
  if (accountId) {
    const hit = accounts.find((a) => str(a.id) === str(accountId))
    if (hit) return hit
  }
  return accounts[0] ?? null
}

export const recipients = (recipient: string): string[] =>
  (recipient || '')
    .split(/[;,]/)
    .map((r) => r.trim())
    .filter(Boolean)

async function sendSendgrid(cfg: EmailAccount, mail: MailDraft, attachments: Attachment[]): Promise<[boolean, string]> {
  const to = recipients(mail.recipient)
  if (to.length === 0) return [false, 'no recipient address']
  const fromEmail = cfg.from_email || mail.sender
  if (!fromEmail) return [false, "no 'From' address set in Settings"]
  const payload: Json = {
    personalizations: [{ to: to.map((email) => ({ email })) }],
    from: { email: fromEmail, name: cfg.from_name || '' },
    subject: mail.subject || '(no subject)',
    // SendGrid wants text/plain before text/html.
    content: [{ type: 'text/plain', value: mail.body || '' }, ...(mail.body_html.trim() ? [{ type: 'text/html', value: mail.body_html.trim() }] : [])],
  }
  const files = attachments.filter((a) => a.b64)
  if (files.length > 0) {
    payload.attachments = files.map((a) => ({
      content: a.b64,
      filename: a.name,
      type: a.type || 'application/octet-stream',
      disposition: 'attachment',
    }))
  }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.sendgrid_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return [true, `SendGrid accepted (${res.status})`]
    return [false, `SendGrid error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`]
  } catch (err) {
    return [false, `SendGrid failed: ${err instanceof Error ? err.message : String(err)}`]
  }
}

async function sendSmtp(cfg: EmailAccount, mail: MailDraft, attachments: Attachment[]): Promise<[boolean, string]> {
  const host = cfg.smtp_host
  if (!host) return [false, 'no SMTP host set in Settings']
  const to = recipients(mail.recipient)
  if (to.length === 0) return [false, 'no recipient address']
  // The mail server is somebody else's computer: never one inside this network.
  if (!(await isDeliverableUrl(`https://${host}`))) return [false, 'SMTP send failed: that mail server address is not allowed']
  const port = Number.parseInt(cfg.smtp_port || '587', 10) || 587
  const sender = cfg.from_email || cfg.smtp_user || mail.sender || ''
  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      // Port 465 speaks TLS from the first byte; the others upgrade with STARTTLS.
      secure: port === 465,
      requireTLS: port !== 465 && str(cfg.smtp_tls ?? '1') !== '0',
      ignoreTLS: str(cfg.smtp_tls ?? '1') === '0',
      auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 20_000,
    })
    await transport.sendMail({
      from: cfg.from_name && sender ? { name: cfg.from_name, address: sender } : sender,
      to: to.join(', '),
      subject: mail.subject || '(no subject)',
      text: mail.body || '',
      html: mail.body_html.trim() || undefined,
      attachments: attachments
        .filter((a) => a.b64)
        .map((a) => ({ filename: a.name || 'file', content: Buffer.from(a.b64, 'base64'), contentType: a.type || 'application/octet-stream' })),
    })
    return [true, `sent via ${host}`]
  } catch (err) {
    return [false, `SMTP send failed: ${err instanceof Error ? err.message : String(err)}`]
  }
}

/** Send through the chosen sender account. "simulated…" means nothing is configured. */
export async function deliverEmail(accounts: EmailAccount[], mail: MailDraft, attachments: Attachment[], accountId: unknown): Promise<[boolean, string]> {
  if (!mail.recipient) return [false, 'no recipient address']
  const acct = pickAccount(accounts, accountId)
  if (!acct) return [false, 'simulated (no email account configured in Settings)']
  if (acct.provider === 'sendgrid' && acct.sendgrid_api_key) return sendSendgrid(acct, mail, attachments)
  if (acct.provider === 'smtp' && acct.smtp_host) return sendSmtp(acct, mail, attachments)
  return [false, `simulated (account '${acct.name}' not fully configured)`]
}

// ------------------------------------------------------------
// HTTP calls (workflow node and API Fetch field)
// ------------------------------------------------------------

const BODY_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain',
}

/**
 * Perform the request described by `cfg` (method, url, auth*, body*),
 * filling {{field}} tokens from `data`. Runs on the server, so it is
 * limited to public addresses: a form must not be able to reach the
 * machines beside this one.
 */
export async function httpCall(cfg: Json, data: Json): Promise<HttpResult> {
  const method = (str(cfg.method) || 'GET').toUpperCase()
  const url = template(cfg.url ?? '', data)
  const bodytype = (str(cfg.bodytype) || 'none').toLowerCase()
  const bodytxt = template(cfg.body ?? '', data)
  const headers: Record<string, string> = {}
  if (BODY_TYPES[bodytype] && bodytxt) headers['Content-Type'] = BODY_TYPES[bodytype]
  const authtype = (str(cfg.authtype) || 'none').toLowerCase()
  if (authtype === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${str(cfg.authuser)}:${str(cfg.authpass)}`).toString('base64')}`
  } else if (authtype === 'bearer') {
    headers.Authorization = `Bearer ${str(cfg.authtoken)}`
  } else if (authtype === 'header') {
    const name = str(cfg.headername).trim()
    if (name) headers[name] = template(str(cfg.headervalue), data)
  }
  const out: HttpResult = { method, url, status: null, error: null, text: null, json: null, auth: authtype, body_type: bodytype }
  try {
    // Redirects are followed by hand, so each address on the way is checked.
    let target = url
    let res: Response | null = null
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:\/\//i.test(target)) throw new Error('The address must start with http:// or https://')
      if (!(await isDeliverableUrl(target))) throw new Error('That address is not allowed (only public internet addresses can be called)')
      res = await fetch(target, {
        method,
        headers,
        body: bodytxt && method !== 'GET' && method !== 'HEAD' ? bodytxt : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
      })
      const next: string | null = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!next) break
      target = new URL(next, target).toString()
    }
    if (!res) throw new Error('No response')
    out.status = res.status
    const raw = (await res.text().catch(() => '')).slice(0, 40_000)
    if (res.status >= 400) {
      out.error = `HTTP ${res.status}`
      out.text = raw.slice(0, 2000)
      return out
    }
    out.text = raw
    try {
      out.json = JSON.parse(raw)
    } catch {
      /* not JSON */
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
  }
  return out
}

// ------------------------------------------------------------
// CSV and Excel
// ------------------------------------------------------------

/** One CSV cell the way Python's csv.writer writes it. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A table as a file: CSV (with the mark Excel needs for Hindi and other scripts) or XLSX. */
export function buildTableFile(head: string[], rows: unknown[][], fileType: string, sheetName: string): { content: Buffer; ext: 'csv' | 'xlsx' } {
  if (fileType === 'xlsx') {
    const cells = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v)))
    const ws = XLSX.utils.aoa_to_sheet([head, ...cells])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
    return { content: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, ext: 'xlsx' }
  }
  const lines = [head, ...rows].map((r) => r.map(csvCell).join(','))
  return { content: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), ext: 'csv' }
}

/** Rows of a CSV text (quotes, commas and line breaks inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

/** An uploaded lookup file (CSV or XLSX) as column names and row objects. */
export function parseTableFile(filename: string, raw: Buffer): { headers: string[]; rows: Json[] } {
  if (filename.toLowerCase().endsWith('.xlsx')) {
    const wb = XLSX.read(raw, { type: 'buffer', cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const grid = ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][]) : []
    const first = grid[0] ?? []
    const headers = first.map((h, i) => (h !== null && h !== undefined && h !== '' ? String(h) : `col${i}`))
    const rows = grid.slice(1).map((r) => {
      const obj: Json = {}
      headers.forEach((h, i) => {
        const v = r[i]
        obj[h] = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : v
      })
      return obj
    })
    return { headers, rows }
  }
  const grid = parseCsv(raw.toString('utf8').replace(/^﻿/, ''))
  const headers = (grid[0] ?? []).map((h) => String(h))
  const rows = grid.slice(1).map((r) => {
    const obj: Json = {}
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? ''
    })
    return obj
  })
  return { headers, rows }
}
