// ============================================================
// AEDA Forms (FOMS): the workflow engine.
//
// A line-for-line port of the engine in the original Python backend
// (foms/web-automation_app.py): {{token}} templating, the If / Switch
// conditions, walking a button's Drawflow graph, and what each node
// does. Reading and writing (submissions, emails, HTTP calls) go
// through `EngineStore`, so the rules here can be tested without a
// database.
// ============================================================

import crypto from 'node:crypto'

export type Json = Record<string, unknown>

/** The time zone "now" tokens are written in (the original ran on a PC in India). */
export const FOMS_TIMEZONE = process.env.FOMS_TIMEZONE?.trim() || 'Asia/Kolkata'

const UUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** A 40-character alphanumeric id, unique across projects and forms. */
export function genUuid(length = 40): string {
  let out = ''
  while (out.length < length) {
    for (const b of crypto.randomBytes(length)) {
      // 248 = 4 × 62: bytes above it would favour the first letters.
      if (b < 248 && out.length < length) out += UUID_ALPHABET[b % 62]
    }
  }
  return out
}

/** Python's str() for the values a form holds. */
export function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return String(v)
}

/** The wall clock in the portal's FOMS time zone. */
export function nowParts(at: Date = new Date(), timeZone: string = FOMS_TIMEZONE) {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
  } catch {
    return nowParts(at, 'UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${get('hour')}:${get('minute')}:${get('second')}`
  return { date, time, datetime: `${date} ${time}`, iso: `${date}T${time}` }
}

/** Built-in {{_token}} values available everywhere {{field}} tokens work. */
export function systemTokens(data: Json | null | undefined, at?: Date): Record<string, string> {
  const n = nowParts(at)
  return {
    _date: n.date,
    _time: n.time,
    _datetime: n.datetime,
    _timestamp: n.datetime,
    _now: n.datetime,
    _uuid: str((data ?? {}).uuid),
  }
}

export function template(text: unknown, data: Json, at?: Date): string {
  if (text === null || text === undefined || text === '') return typeof text === 'string' ? text : ''
  const sys = systemTokens(data, at)
  return str(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const k = key.trim()
    if (k in sys) return sys[k]
    return str(data[k])
  })
}

// ------------------------------------------------------------
// The Drawflow graph of a button
// ------------------------------------------------------------

export interface GraphNode {
  name?: string
  data?: Json
  inputs?: Record<string, { connections?: { node: string | number }[] }>
  outputs?: Record<string, { connections?: { node: string | number }[] }>
}
export type GraphNodes = Record<string, GraphNode>

export function graphNodes(graph: unknown): GraphNodes {
  const modules = (graph as { drawflow?: Record<string, { data?: GraphNodes }> } | null)?.drawflow
  if (!modules || typeof modules !== 'object') return {}
  for (const mod of Object.values(modules)) {
    if (mod?.data && Object.keys(mod.data).length > 0) return mod.data
  }
  return {}
}

export function startNode(nodes: GraphNodes): string | null {
  for (const [id, node] of Object.entries(nodes)) {
    if (node.name === 'button_start') return id
  }
  for (const [id, node] of Object.entries(nodes)) {
    const inputs = node.inputs ?? {}
    if (!Object.values(inputs).some((p) => (p.connections ?? []).length > 0)) return id
  }
  return Object.keys(nodes)[0] ?? null
}

export function nextId(node: GraphNode): string | null {
  for (const port of Object.values(node.outputs ?? {})) {
    const conns = port.connections ?? []
    if (conns.length > 0) return String(conns[0].node)
  }
  return null
}

export function portTarget(node: GraphNode, port: string): string | null {
  const conns = node.outputs?.[port]?.connections ?? []
  return conns.length > 0 ? String(conns[0].node) : null
}

// ------------------------------------------------------------
// Conditions
// ------------------------------------------------------------

const two = (n: string) => n.padStart(2, '0')

/** A date or time as milliseconds, in any of the formats the original accepts; null otherwise. */
export function parseDt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const s = str(v).trim()
  let m: RegExpMatchArray | null
  const utc = (y: string, mo: string, d: string, h = '0', mi = '0', se = '0') => {
    const [yy, mm, dd, hh, mn, ss] = [y, mo, d, h, mi, se].map(Number)
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mn > 59 || ss > 59) return null
    const t = Date.UTC(yy, mm - 1, dd, hh, mn, ss)
    // 31 February and the like roll over; the original refuses them.
    return new Date(t).getUTCDate() === dd ? t : null
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/))) return utc(m[1], m[2], m[3], m[4], m[5], m[6] ?? '0')
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return utc(m[1], m[2], m[3])
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    // Day first, then month first, as the original tries them.
    return utc(m[3], m[2], m[1]) ?? utc(m[3], m[1], m[2])
  }
  if ((m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/))) return utc('1900', '1', '1', two(m[1]), two(m[2]), two(m[3] ?? '0'))
  return null
}

export function toBool(v: unknown): boolean {
  return ['1', 'true', 'yes', 'y', 'on', 'checked'].includes(str(v).trim().toLowerCase())
}

/** A raw value made comparable for its data type; null when it cannot be. */
export function coerce(v: unknown, dtype: string | null | undefined): number | string | null {
  const type = (dtype || 'string').toLowerCase()
  if (type === 'number') {
    const s = str(v).trim()
    if (!s) return null
    const n = Number(s)
    return Number.isNaN(n) ? null : n
  }
  if (type === 'date' || type === 'datetime') return parseDt(v)
  if (type === 'boolean') return toBool(v) ? 1 : 0
  if (type === 'email') return str(v).trim().toLowerCase()
  return str(v)
}

export function evalCondition(field: unknown, op: unknown, value: unknown, data: Json, dtype: unknown = 'string'): boolean {
  const a = str(data[str(field)])
  const b = str(value)
  const operator = (str(op) || '==').toLowerCase()
  const type = (str(dtype) || 'string').toLowerCase()
  if (operator === 'empty') return a.trim() === ''
  if (operator === 'notempty' || operator === 'not_empty') return a.trim() !== ''
  if (operator === 'contains') {
    if (type === 'email') return a.trim().toLowerCase().includes(b.trim().toLowerCase())
    return a.toLowerCase().includes(b.toLowerCase())
  }
  const ca = coerce(a, type)
  const cb = coerce(b, type)
  if (['==', 'eq', 'equals', '!=', 'ne'].includes(operator)) {
    const eq = ca !== null && cb !== null ? ca === cb : a === b
    return ['==', 'eq', 'equals'].includes(operator) ? eq : !eq
  }
  if (ca === null || cb === null) return false
  if (operator === '>') return ca > cb
  if (operator === '<') return ca < cb
  if (operator === '>=') return ca >= cb
  if (operator === '<=') return ca <= cb
  return false
}

/** Drawflow lower-cases df-* attribute names, so node data keys come back lower-cased. */
export function lowerKeys(data: Json | null | undefined): Json {
  const out: Json = {}
  for (const [k, v] of Object.entries(data ?? {})) out[String(k).toLowerCase()] = v
  return out
}

// ------------------------------------------------------------
// The design: fields, sections, visibility
// ------------------------------------------------------------

export const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'select', 'radio', 'checkbox'])

export interface SchemaElement extends Json {
  id?: string
  type?: string
  key?: string
  label?: string
  required?: boolean
  rules?: { visibleRoles?: string[]; visibleStages?: string[] }
  children?: SchemaElement[]
}

export function schemaElements(schema: Json): SchemaElement[] {
  const elements = schema.elements ?? schema.components ?? []
  return Array.isArray(elements) ? (elements as SchemaElement[]) : []
}

/** Every element with its parent section (or null), descending into sections. */
export function iterFields(schema: Json): [SchemaElement, SchemaElement | null][] {
  const out: [SchemaElement, SchemaElement | null][] = []
  for (const el of schemaElements(schema)) {
    if (el?.type === 'section') {
      for (const child of Array.isArray(el.children) ? el.children : []) out.push([child, el])
    } else if (el) {
      out.push([el, null])
    }
  }
  return out
}

export function ruleVisible(el: SchemaElement | null, role: string, stage: string): boolean {
  const r = el?.rules ?? {}
  const vr = Array.isArray(r.visibleRoles) ? r.visibleRoles : []
  const vs = Array.isArray(r.visibleStages) ? r.visibleStages : []
  return (vr.length === 0 || vr.includes(role)) && (vs.length === 0 || vs.includes(stage))
}

export function effectiveVisible(field: SchemaElement, section: SchemaElement | null, role: string, stage: string): boolean {
  if (section !== null && !ruleVisible(section, role, stage)) return false
  return ruleVisible(field, role, stage)
}

export function fieldsList(schema: Json): SchemaElement[] {
  return iterFields(schema)
    .map(([f]) => f)
    .filter((f) => FIELD_TYPES.has(str(f.type)))
}

export function findEmail(schema: Json, emailId: unknown): Json | null {
  for (const e of Array.isArray(schema.emails) ? (schema.emails as Json[]) : []) {
    if (str(e.id) === str(emailId)) return e
  }
  return null
}

/** An in-form API Fetch element (type "http") by key, including inside sections. */
export function findHttpComponent(schema: Json, key: unknown): SchemaElement | null {
  for (const [el] of iterFields(schema)) {
    if (el.type === 'http' && str(el.key) === str(key)) return el
  }
  return null
}

// ------------------------------------------------------------
// Running a button
// ------------------------------------------------------------

export interface Attachment {
  name: string
  type: string
  b64: string
}

export interface MailDraft {
  sender: string
  recipient: string
  subject: string
  body: string
  body_html: string
  attachment: string
}

export interface HttpResult extends Json {
  method: string
  url: string
  status: number | null
  error: string | null
  text: string | null
  json: unknown
}

export interface SubmissionRef {
  id: number
  uuid: string
}

/** Everything the engine needs from the outside world. */
export interface EngineStore {
  /** The submission with the same single-submission key value, other than `currentId`; null if none. */
  hasDuplicate(key: string, value: string, currentId: number | null): Promise<boolean>
  /** Create (id null) or update a submission; returns its id and reference. */
  saveSubmission(id: number | null, patch: { data: Json; stage: string; status?: string; uuid?: string }): Promise<SubmissionRef>
  /** Write the email to the log and try to send it. */
  sendEmail(mail: MailDraft, attachments: Attachment[], accountId: unknown, submissionId: number | null): Promise<{ row: Json; sent: boolean; detail: string }>
  httpCall(cfg: Json, data: Json): Promise<HttpResult>
  /** Add a run to the submission's trace history. */
  saveTrace(id: number, entry: Json): Promise<void>
}

export interface RunContext {
  data: Json
  stage: string
  role: string
  preview: boolean
  visible_keys: string[] | null
  pdf?: { name: string; b64: string } | null
  errors: string[]
  log: string[]
  emails: Json[]
  http: Json[]
  dialogs: Json[]
  navigate: Json | null
  saved_submission_id: number | null
  stopped: boolean
}

export interface RunInput {
  schema: Json
  workflow: Json
  buttonKey: string
  data: Json | null | undefined
  role: string
  stage: string
  submission?: (SubmissionRef & { exists: true }) | null
  visibleKeys?: string[] | null
  pdfBase64?: string | null
  pdfFilename?: string | null
  preview?: boolean
  now?: Date
}

/** Which submission value a single-submission form is keyed on, and its label. */
function singleSubmissionRule(schema: Json, data: Json): { key: string; value: string; label: string } | null {
  const cfg = (schema.submission ?? {}) as Json
  if (cfg.mode !== 'single' || !cfg.key) return null
  const key = str(cfg.key)
  const value = str(data[key]).trim()
  if (value === '') return null
  let label = key
  for (const [f] of iterFields(schema)) {
    if (f.key === key) {
      label = str(f.label) || key
      break
    }
  }
  return { key, value, label }
}

export async function executeButton(store: EngineStore, input: RunInput): Promise<RunContext> {
  const { schema, workflow } = input
  const ctx: RunContext = {
    data: { ...(input.data ?? {}) },
    stage: input.stage || '',
    role: input.role || '',
    preview: input.preview === true,
    visible_keys: Array.isArray(input.visibleKeys) ? input.visibleKeys : null,
    pdf: input.pdfBase64 ? { name: input.pdfFilename || 'form.pdf', b64: input.pdfBase64 } : null,
    errors: [],
    log: [],
    emails: [],
    http: [],
    dialogs: [],
    navigate: null,
    saved_submission_id: input.submission ? input.submission.id : null,
    stopped: false,
  }
  if (input.submission?.uuid && ctx.data.uuid === undefined) ctx.data.uuid = input.submission.uuid

  // {{now}} / {{today}} / {{now_time}} / {{now_iso}}; a real field of
  // the same key always wins.
  const ts = nowParts(input.now)
  for (const [k, v] of Object.entries({ now: ts.datetime, today: ts.date, now_time: ts.time, now_iso: ts.iso })) {
    if (ctx.data[k] === undefined) ctx.data[k] = v
  }

  const graph = workflow[input.buttonKey]
  if (!graph) {
    ctx.log.push(`No workflow defined for button '${input.buttonKey}'. Nothing to do.`)
    return ctx
  }
  const nodes = graphNodes(graph)
  if (Object.keys(nodes).length === 0) {
    ctx.log.push('Workflow graph is empty.')
    return ctx
  }

  let cur = startNode(nodes)
  let guard = 0
  while (cur !== null && !ctx.stopped) {
    guard += 1
    if (guard > 200) {
      ctx.log.push('Stopped: exceeded 200 steps (possible loop).')
      break
    }
    const node: GraphNode | undefined = nodes[cur]
    if (!node) break
    if (node.name === 'if' || node.name === 'switch') {
      cur = branchNext(node, ctx)
    } else {
      await runNode(store, schema, str(node.name), node.data ?? {}, ctx, input.now)
      cur = nextId(node)
    }
  }

  if (input.submission) {
    await store.saveSubmission(input.submission.id, { data: ctx.data, stage: ctx.stage || '' })
    ctx.saved_submission_id = input.submission.id
  }

  // The run is kept on the resulting submission (shown in the Database tab).
  if (ctx.saved_submission_id) {
    await store.saveTrace(ctx.saved_submission_id, {
      button: input.buttonKey,
      ok: ctx.errors.length === 0,
      log: ctx.log,
      errors: ctx.errors,
      emails: ctx.emails,
      http: ctx.http,
      stage: ctx.stage,
      at: (input.now ?? new Date()).toISOString(),
    })
  }
  return ctx
}

export function branchNext(node: GraphNode, ctx: Pick<RunContext, 'data' | 'log'>): string | null {
  const nd = lowerKeys(node.data)
  const dtype = str(nd.dtype) || 'string'
  if (node.name === 'if') {
    const ok = evalCondition(nd.field, nd.op, nd.value, ctx.data, dtype)
    ctx.log.push(`⎇ If '${str(nd.field)}' ${str(nd.op) || '=='} '${str(nd.value)}' (${dtype}) → ${ok ? 'TRUE' : 'FALSE'} branch`)
    return portTarget(node, ok ? 'output_1' : 'output_2')
  }
  // switch: case1..case3 → output_1..3, anything else → output_4
  const val = str(ctx.data[str(nd.field)])
  const cases = [nd.case1, nd.case2, nd.case3]
  for (let i = 0; i < cases.length; i++) {
    const cv = cases[i]
    if (cv !== null && cv !== undefined && cv !== '' && evalCondition(nd.field, '==', cv, ctx.data, dtype)) {
      ctx.log.push(`⎇ Switch '${str(nd.field)}' = '${val}' (${dtype}) → case ${i + 1}`)
      return portTarget(node, `output_${i + 1}`)
    }
  }
  ctx.log.push(`⎇ Switch '${str(nd.field)}' = '${val}' (${dtype}) → default`)
  return portTarget(node, 'output_4')
}

async function runNode(store: EngineStore, schema: Json, ntype: string, rawData: Json, ctx: RunContext, now?: Date): Promise<void> {
  const ndata = lowerKeys(rawData)
  const tpl = (text: unknown) => template(text, ctx.data, now)

  if (ntype === 'button_start') {
    ctx.log.push(`▶ Button clicked: ${str(ndata.label)}`)
    return
  }

  if (ntype === 'validate') {
    const missing: string[] = []
    for (const [field, section] of iterFields(schema)) {
      if (!FIELD_TYPES.has(str(field.type)) || !field.required) continue
      // Only what the person can actually see for this role and stage.
      if (!effectiveVisible(field, section, ctx.role, ctx.stage)) continue
      // The browser's own view of what is visible covers formula rules.
      if (ctx.visible_keys !== null && !ctx.visible_keys.includes(str(field.key))) continue
      if (!str(ctx.data[str(field.key)]).trim()) missing.push(str(field.label) || str(field.key))
    }
    if (missing.length > 0) {
      ctx.errors.push(...missing.map((m) => `'${m}' is required.`))
      ctx.log.push(`✖ Validation failed: ${missing.join(', ')}`)
      ctx.stopped = true
    } else {
      ctx.log.push('✔ Validation passed.')
    }
    return
  }

  if (ntype === 'set_stage') {
    ctx.stage = str(ndata.stage)
    ctx.log.push(`→ Stage set to '${ctx.stage}'.`)
    return
  }

  if (ntype === 'set_value') {
    const key = str(ndata.key)
    const val = tpl(ndata.value ?? '')
    if (key) {
      ctx.data[key] = val
      ctx.log.push(`= Set '${key}' = '${val}'.`)
    }
    return
  }

  if (ntype === 'save') {
    if (ctx.preview) {
      if (ctx.data.uuid === undefined) ctx.data.uuid = `PREVIEW-${crypto.randomBytes(4).toString('hex')}`
      ctx.log.push('💾 (preview) submission would be saved — not persisted.')
      return
    }
    // A single-submission form refuses a duplicate before saving.
    const rule = singleSubmissionRule(schema, ctx.data)
    if (rule && (await store.hasDuplicate(rule.key, rule.value, ctx.saved_submission_id))) {
      const dup = `This form allows a single submission per ${rule.label}. A submission with ${rule.label} = '${rule.value}' already exists.`
      ctx.errors.push(dup)
      ctx.log.push(`✖ ${dup} — flow stopped.`)
      ctx.stopped = true
      return
    }
    // The reference is part of the data, so a new answer gets its
    // reference first and is written once.
    const uuid = ctx.saved_submission_id && typeof ctx.data.uuid === 'string' && ctx.data.uuid ? ctx.data.uuid : genUuid()
    const creating = ctx.saved_submission_id === null
    if (creating) ctx.data.uuid = uuid
    const saved = await store.saveSubmission(ctx.saved_submission_id, {
      data: ctx.data,
      stage: ctx.stage,
      status: 'submitted',
      ...(creating ? { uuid } : {}),
    })
    if (ctx.data.uuid !== saved.uuid) {
      ctx.data.uuid = saved.uuid
      await store.saveSubmission(saved.id, { data: ctx.data, stage: ctx.stage, status: 'submitted' })
    }
    ctx.saved_submission_id = saved.id
    ctx.log.push(`💾 Saved submission ${saved.uuid.slice(0, 10)}… to database.`)
    return
  }

  if (ntype === 'send_email') {
    const tmpl = findEmail(schema, ndata.emailid)
    if (!tmpl) {
      ctx.errors.push('Send Email: no email template selected on the node.')
      ctx.log.push('✖ Send Email: no template selected — flow stopped.')
      ctx.stopped = true
      return
    }
    const attachments: Attachment[] = []
    if (tmpl.attachPdf && ctx.pdf?.b64) attachments.push({ name: ctx.pdf.name, type: 'application/pdf', b64: ctx.pdf.b64 })
    for (const key of Array.isArray(tmpl.attachFields) ? (tmpl.attachFields as unknown[]) : []) {
      const fv = ctx.data[str(key)] as Json | undefined
      if (fv && typeof fv === 'object' && fv.data) {
        let b64 = fv.data
        if (typeof b64 === 'string' && b64.startsWith('data:') && b64.includes(',')) b64 = b64.slice(b64.indexOf(',') + 1)
        attachments.push({ name: str(fv.name) || 'file', type: str(fv.type) || 'application/octet-stream', b64: str(b64) })
      }
    }
    const recipient = tpl(tmpl.recipient ?? '')
    const subject = tpl(tmpl.subject ?? '')
    const body = tpl(tmpl.body ?? '')
    const bodyHtml = tpl(tmpl.bodyHtml ?? '')
    if (ctx.preview) {
      ctx.emails.push({ recipient, subject, body, delivery: 'preview (not sent)' })
      ctx.log.push(`✉ (preview) would send '${str(tmpl.name)}' to ${recipient || '(no recipient)'}.`)
      return
    }
    const { row, sent, detail } = await store.sendEmail(
      {
        sender: tpl(tmpl.sender ?? ''),
        recipient,
        subject,
        body,
        body_html: bodyHtml,
        attachment: attachments.map((a) => a.name).join(', ') || str(tmpl.attachment),
      },
      attachments,
      tmpl.account,
      ctx.saved_submission_id,
    )
    ctx.emails.push({ ...row, delivered: sent, delivery: detail })
    ctx.log.push(`✉ Email '${str(tmpl.name)}' ${sent ? 'SENT' : 'NOT sent'} to ${recipient || '(no recipient)'} — ${detail}.`)
    // A configured send that failed stops the flow, so later nodes and dialogs do not run.
    if (!sent && !detail.startsWith('simulated')) {
      ctx.errors.push(`Email could not be sent: ${detail}`)
      ctx.stopped = true
    }
    return
  }

  if (ntype === 'http') {
    const result = await store.httpCall(ndata, ctx.data)
    result.response = (result.text ?? '').slice(0, 500)
    ctx.log.push(
      result.error
        ? `🌐 HTTP ${result.method} ${result.url} → error: ${result.error}`
        : `🌐 HTTP ${result.method} ${result.url} → ${result.status}`,
    )
    ctx.http.push(result)
    if (result.error || (result.status && result.status >= 400)) {
      ctx.errors.push(`HTTP request failed: ${result.error || `status ${result.status}`}`)
      ctx.stopped = true
    }
    return
  }

  if (ntype === 'navigate') {
    const url = tpl(ndata.url ?? '')
    ctx.navigate = { url, newtab: str(ndata.newtab ?? 'no') === 'yes' }
    ctx.log.push(`➡ Navigate to ${url}`)
    return
  }

  if (ntype === 'dialog') {
    const on = (key: string, fallback: string) => str(ndata[key] ?? fallback) !== 'no'
    ctx.dialogs.push({
      header: tpl(ndata.header ?? ''),
      body: tpl(ndata.body ?? ''),
      buttons: [
        { action: 'navigate', label: str(ndata.navigatelabel) || 'Navigate', url: tpl(ndata.navigateurl ?? ''), enabled: on('shownavigate', 'no') },
        { action: 'closeTab', label: str(ndata.closetablabel) || 'Close tab', enabled: on('showclosetab', 'yes') },
        { action: 'dismiss', label: str(ndata.dismisslabel) || 'OK', enabled: on('showdismiss', 'no') },
      ],
    })
    ctx.log.push(`🗔 Dialog shown: ${str(ndata.header)}`)
    return
  }

  ctx.log.push(`(skipped unknown node type '${ntype}')`)
}

// ------------------------------------------------------------
// Scheduled extracts: when is the next run
// ------------------------------------------------------------

export interface TaskSchedule {
  schedule: string
  minute: number
  hour: number
  /** 0 = Monday. */
  weekday: number
  day: number
  timezone: string
}

function zoneParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute') }
}

/** The moment a wall-clock time happens in a time zone. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const wanted = Date.UTC(y, mo - 1, d, h, mi)
  let guess = wanted
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(new Date(guess), timeZone)
    guess += wanted - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
  }
  return new Date(guess)
}

/** The next run of a scheduled extract after `now`; null for an unknown schedule. */
export function computeNextRun(task: TaskSchedule, now: Date = new Date()): Date | null {
  let tz = task.timezone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  } catch {
    tz = 'UTC'
  }
  const p = zoneParts(now, tz)
  const minute = task.minute || 0
  const hour = task.hour || 0
  const at = (y: number, mo: number, d: number, h: number, mi: number) => zonedToUtc(y, mo, d, h, mi, tz)
  // Date.UTC rolls days and months over, which is what "add a day" needs.
  const roll = (y: number, mo: number, d: number) => {
    const t = new Date(Date.UTC(y, mo - 1, d))
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
  }
  if (task.schedule === 'hourly') {
    let cand = at(p.y, p.mo, p.d, p.h, minute)
    if (cand <= now) cand = new Date(cand.getTime() + 3_600_000)
    return cand
  }
  if (task.schedule === 'daily') {
    let cand = at(p.y, p.mo, p.d, hour, minute)
    if (cand <= now) {
      const n = roll(p.y, p.mo, p.d + 1)
      cand = at(n.y, n.mo, n.d, hour, minute)
    }
    return cand
  }
  if (task.schedule === 'weekly') {
    // Monday = 0, as in the original.
    const today = (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7
    const ahead = ((((task.weekday || 0) - today) % 7) + 7) % 7
    let n = roll(p.y, p.mo, p.d + ahead)
    let cand = at(n.y, n.mo, n.d, hour, minute)
    if (cand <= now) {
      n = roll(n.y, n.mo, n.d + 7)
      cand = at(n.y, n.mo, n.d, hour, minute)
    }
    return cand
  }
  if (task.schedule === 'monthly') {
    const inMonth = (y: number, mo: number) => {
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
      return at(y, mo, Math.min(task.day || 1, last), hour, minute)
    }
    let cand = inMonth(p.y, p.mo)
    if (cand <= now) cand = p.mo === 12 ? inMonth(p.y + 1, 1) : inMonth(p.y, p.mo + 1)
    return cand
  }
  return null
}
