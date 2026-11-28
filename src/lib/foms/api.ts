// ============================================================
// AEDA Forms (FOMS): the API of the original Python backend, route
// for route, on Supabase. The original screens call it unchanged
// (their addresses only gain the /api/aeda prefix).
//
// Every request first passes `fomsContext()`: while the module is
// being tried out only the platform admin may use it, and everyone
// else gets "not found". All data is scoped to the caller's account
// by hand, because the server uses the service role here.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { getSuperAdmin } from '@/lib/admin/super-admin'
import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  computeNextRun,
  executeButton,
  fieldsList,
  findHttpComponent,
  genUuid,
  nowParts,
  str,
  type EngineStore,
  type Json,
  type RunContext,
} from './engine'
import { buildTableFile, deliverEmail, httpCall, parseTableFile, type EmailAccount } from './services'

export class FomsError extends Error {
  readonly status: number
  constructor(status: number, description: string) {
    super(description)
    this.status = status
  }
}
const abort = (status: number, description: string): never => {
  throw new FomsError(status, description)
}

export interface FomsContext {
  db: SupabaseClient
  accountId: string
}

/**
 * The caller, if they may use AEDA Forms; null for everyone else.
 *
 * On a developer's own computer (`next dev`, never a deployment)
 * FOMS_DEV_ACCOUNT_ID names an account to work in without signing in,
 * so the module can be tried and tested locally.
 */
export async function fomsAccess(): Promise<FomsContext | null> {
  const devAccount = process.env.NODE_ENV === 'development' ? process.env.FOMS_DEV_ACCOUNT_ID?.trim() : ''
  if (devAccount) return { db: supabaseAdmin(), accountId: devAccount }
  const admin = await getSuperAdmin()
  if (!admin) return null
  const account = await getCurrentAccount()
  return { db: admin.db, accountId: account.accountId }
}

/** The caller, if they may use AEDA Forms; otherwise a 404. */
export async function fomsContext(): Promise<FomsContext> {
  return (await fomsAccess()) ?? abort(404, 'Not found')
}

/** The original answers errors as { description }; its screens read that. */
export function fomsErrorResponse(err: unknown): NextResponse {
  if (err instanceof FomsError) return NextResponse.json({ description: err.message, error: err.message }, { status: err.status })
  const status = (err as { status?: number } | null)?.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : 'Not allowed'
    return NextResponse.json({ description: message, error: message }, { status })
  }
  console.error('[foms]', err)
  return NextResponse.json({ description: 'Something went wrong on the server', error: 'server_error' }, { status: 500 })
}

// ------------------------------------------------------------
// Rows
// ------------------------------------------------------------

type Row = Record<string, unknown>

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const intId = (raw: string | undefined): number => {
  if (!raw || !/^\d{1,15}$/.test(raw)) throw new FomsError(404, 'Not found')
  return Number(raw)
}

const BLANK_RULES = () => ({ visibleRoles: [], visibleStages: [], readonlyRoles: [], readonlyStages: [] })
const defaultSchema = (): Json => ({
  elements: [{ id: 'btn_submit', type: 'button', key: 'submit', label: 'Submit', style: 'primary', rules: BLANK_RULES() }],
  roles: [{ id: 'role_user', name: 'User' }],
  stages: [
    { id: 'stage_draft', name: 'Draft' },
    { id: 'stage_review', name: 'In Review' },
    { id: 'stage_done', name: 'Completed' },
  ],
  emails: [],
  summaryColumns: [],
})

async function getProject(ctx: FomsContext, id: number): Promise<Row> {
  const row = check(await ctx.db.from('foms_projects').select('*').eq('id', id).eq('account_id', ctx.accountId).maybeSingle())
  return (row as Row | null) ?? abort(404, `Project ${id} not found`)
}
async function getForm(ctx: FomsContext, id: number): Promise<Row> {
  const row = check(await ctx.db.from('foms_forms').select('*').eq('id', id).eq('account_id', ctx.accountId).maybeSingle())
  return (row as Row | null) ?? abort(404, `Form ${id} not found`)
}
async function getVersion(ctx: FomsContext, id: unknown): Promise<Row | null> {
  if (id === null || id === undefined) return null
  const row = check(await ctx.db.from('foms_form_versions').select('*').eq('id', id).eq('account_id', ctx.accountId).maybeSingle())
  return (row as Row | null) ?? null
}
async function getSubmission(ctx: FomsContext, id: number): Promise<Row> {
  const row = check(await ctx.db.from('foms_submissions').select('*').eq('id', id).eq('account_id', ctx.accountId).maybeSingle())
  return (row as Row | null) ?? abort(404, `Submission ${id} not found`)
}

/** How many rows of a table each form has. */
async function countByForm(ctx: FomsContext, table: string, formIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (formIds.length === 0) return counts
  await Promise.all(
    formIds.map(async (id) => {
      const { count } = await ctx.db.from(table).select('id', { count: 'exact', head: true }).eq('form_id', id).eq('account_id', ctx.accountId)
      counts.set(id, count ?? 0)
    }),
  )
  return counts
}

async function formsToDicts(ctx: FomsContext, forms: Row[]): Promise<Json[]> {
  const ids = forms.map((f) => Number(f.id))
  const [versions, subs] = await Promise.all([countByForm(ctx, 'foms_form_versions', ids), countByForm(ctx, 'foms_submissions', ids)])
  return forms.map((f) => ({
    id: f.id,
    project_id: f.project_id,
    name: f.name,
    status: f.status,
    archived: f.archived === true,
    published_version_id: f.published_version_id ?? null,
    version_count: versions.get(Number(f.id)) ?? 0,
    submission_count: subs.get(Number(f.id)) ?? 0,
    created_at: f.created_at ?? null,
    updated_at: f.updated_at ?? null,
  }))
}
const formToDict = async (ctx: FomsContext, form: Row): Promise<Json> => (await formsToDicts(ctx, [form]))[0]

async function projectToDict(ctx: FomsContext, p: Row): Promise<Json> {
  const { count } = await ctx.db
    .from('foms_forms')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', p.id)
    .eq('account_id', ctx.accountId)
    .eq('archived', false)
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    archived: p.archived === true,
    created_at: p.created_at ?? null,
    form_count: count ?? 0,
  }
}

const versionToDict = (v: Row, payload = false): Json => ({
  id: v.id,
  form_id: v.form_id,
  version_no: v.version_no,
  published_at: v.published_at ?? null,
  ...(payload ? { schema: obj(v.schema_json), workflow: obj(v.workflow_json) } : {}),
})

const submissionToDict = (s: Row): Json => ({
  id: s.id,
  uuid: s.uuid ?? '',
  form_id: s.form_id,
  version_id: s.version_id ?? null,
  data: obj(s.data),
  stage: s.stage ?? '',
  status: s.status ?? '',
  modified_by: s.modified_by ?? '',
  last_ok: s.last_ok !== false,
  last_trace: s.last_trace ?? null,
  traces: arr(s.traces),
  created_at: s.created_at ?? null,
  updated_at: s.updated_at ?? null,
})

const emailToDict = (e: Row): Json => ({
  id: e.id,
  form_id: e.form_id,
  submission_id: e.submission_id ?? null,
  sender: e.sender ?? '',
  recipient: e.recipient ?? '',
  subject: e.subject ?? '',
  body: e.body ?? '',
  attachment: e.attachment ?? '',
  sent_at: e.sent_at ?? null,
})

const taskToDict = (t: Row): Json => ({
  id: t.id,
  form_id: t.form_id,
  name: t.name,
  columns: arr(t.columns),
  file_type: t.file_type,
  folder_path: t.folder_path ?? '',
  schedule: t.schedule,
  minute: t.minute,
  hour: t.hour,
  weekday: t.weekday,
  day: t.day,
  timezone: t.timezone,
  active: t.active === true,
  last_run: t.last_run ?? null,
  next_run: t.next_run ?? null,
})

const lookupToDict = (lt: Row, includeRows = false): Json => ({
  id: lt.id,
  form_id: lt.form_id,
  name: lt.name,
  key_column: lt.key_column ?? '',
  key_component: lt.key_component ?? '',
  columns: arr(lt.columns),
  mappings: arr(lt.mappings),
  row_count: arr(lt.rows).length,
  ...(includeRows ? { rows: arr(lt.rows) } : {}),
})

// ------------------------------------------------------------
// Settings: email sender accounts (kept encrypted)
// ------------------------------------------------------------

async function emailAccounts(ctx: FomsContext): Promise<EmailAccount[]> {
  const { data } = await ctx.db.from('foms_settings').select('value').eq('account_id', ctx.accountId).eq('key', 'email_accounts').maybeSingle()
  const raw = (data as { value?: string } | null)?.value
  if (!raw) return []
  try {
    const parsed = JSON.parse(decrypt(raw))
    return Array.isArray(parsed) ? (parsed as EmailAccount[]) : []
  } catch {
    console.error('[foms] the saved email accounts could not be read — check ENCRYPTION_KEY')
    return []
  }
}

const maskAccount = (a: EmailAccount): Json => ({
  id: a.id,
  name: a.name || a.from_email || 'Account',
  provider: a.provider || 'none',
  from_email: a.from_email || '',
  from_name: a.from_name || '',
  smtp_host: a.smtp_host || '',
  smtp_port: a.smtp_port || '587',
  smtp_user: a.smtp_user || '',
  smtp_tls: a.smtp_tls ?? '1',
  has_sendgrid_key: !!a.sendgrid_api_key,
  has_smtp_pass: !!a.smtp_pass,
})

// ------------------------------------------------------------
// The engine's view of the database
// ------------------------------------------------------------

function engineStore(ctx: FomsContext, form: Row): EngineStore {
  return {
    async hasDuplicate(key, value, currentId) {
      const rows = check(await ctx.db.from('foms_submissions').select('id, data').eq('form_id', form.id).eq('account_id', ctx.accountId)) as Row[]
      return rows.some((r) => Number(r.id) !== currentId && str(obj(r.data)[key]).trim() === value)
    },
    async saveSubmission(id, patch) {
      const now = new Date().toISOString()
      if (id === null) {
        const row = check(
          await ctx.db
            .from('foms_submissions')
            .insert({
              account_id: ctx.accountId,
              form_id: form.id,
              version_id: form.published_version_id ?? null,
              uuid: patch.uuid ?? genUuid(),
              data: patch.data,
              stage: patch.stage,
              status: patch.status ?? 'submitted',
            })
            .select('id, uuid')
            .single(),
        ) as Row
        return { id: Number(row.id), uuid: str(row.uuid) }
      }
      const update: Row = { data: patch.data, updated_at: now }
      // As in the original: a run only moves the stage when it set one.
      if (patch.status !== undefined || patch.stage) update.stage = patch.stage
      if (patch.status !== undefined) update.status = patch.status
      const row = check(
        await ctx.db.from('foms_submissions').update(update).eq('id', id).eq('account_id', ctx.accountId).select('id, uuid').maybeSingle(),
      ) as Row | null
      if (!row) throw new FomsError(404, `Submission ${id} not found`)
      return { id: Number(row.id), uuid: str(row.uuid) }
    },
    async sendEmail(mail, attachments, accountId, submissionId) {
      const row = check(
        await ctx.db
          .from('foms_email_logs')
          .insert({ account_id: ctx.accountId, form_id: form.id, submission_id: submissionId, ...mail })
          .select('*')
          .single(),
      ) as Row
      const [sent, detail] = await deliverEmail(await emailAccounts(ctx), mail, attachments, accountId)
      return { row: emailToDict(row), sent, detail }
    },
    httpCall,
    async saveTrace(id, entry) {
      const { data } = await ctx.db.from('foms_submissions').select('traces').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()
      if (!data) return
      const history = [entry, ...arr((data as Row).traces)].slice(0, 50)
      await ctx.db
        .from('foms_submissions')
        .update({ traces: history, last_trace: entry, last_ok: (entry.errors as unknown[]).length === 0 })
        .eq('id', id)
        .eq('account_id', ctx.accountId)
    },
  }
}

/** What a run answers with: the context, less the (possibly large) PDF. */
function runResult(ctx: RunContext): Json {
  const { pdf: _pdf, ...rest } = ctx
  void _pdf
  return rest as unknown as Json
}

// ------------------------------------------------------------
// Extracts
// ------------------------------------------------------------

const META_COLS: Record<string, string> = { id: 'ID', stage: 'Stage', status: 'Status', created_at: 'Created', modified_by: 'Modified By' }
const EMAIL_LABELS: Record<string, string> = {
  id: 'ID',
  sender: 'Sender',
  recipient: 'Recipient',
  subject: 'Subject',
  body: 'Body',
  attachment: 'Attachment',
  sent_at: 'Sent At',
}

const defaultColumns = (schema: Json): string[] => ['id', ...fieldsList(schema).map((f) => str(f.key)), 'stage', 'status', 'created_at', 'modified_by']

function columnLabel(schema: Json, key: string): string {
  if (META_COLS[key]) return META_COLS[key]
  const field = fieldsList(schema).find((f) => f.key === key)
  return field ? str(field.label) || key : key
}

function cell(sub: Row, key: string): unknown {
  if (key === 'id') return sub.id
  if (key === 'stage') return sub.stage ?? ''
  if (key === 'status') return sub.status ?? ''
  if (key === 'created_at') return sub.created_at ?? ''
  if (key === 'modified_by') return sub.modified_by ?? ''
  const v = obj(sub.data)[key]
  // An uploaded file is stored as { name, type, data }: its name is what a table shows.
  if (v && typeof v === 'object' && !Array.isArray(v)) return (v as Json).name ?? ''
  return v ?? ''
}

async function buildExtract(ctx: FomsContext, form: Row, columns: string[], fileType: string) {
  const schema = obj(form.working_schema)
  const subs = check(
    await ctx.db.from('foms_submissions').select('*').eq('form_id', form.id).eq('account_id', ctx.accountId).order('id', { ascending: false }),
  ) as Row[]
  return buildTableFile(
    columns.map((c) => columnLabel(schema, c)),
    subs.map((s) => columns.map((c) => cell(s, c))),
    fileType,
    'Submissions',
  )
}

const fileName = (name: unknown) => str(name).replace(/ /g, '_').replace(/[^\w.-]+/g, '_') || 'form'
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' }

function download(content: Buffer | string, mime: string, name: string): Response {
  return new Response(typeof content === 'string' ? content : new Uint8Array(content), {
    headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  })
}

function applyTaskFields(task: Row, d: Json): Row {
  const int = (v: unknown, fallback: number) => {
    const n = Number.parseInt(str(v), 10)
    return Number.isFinite(n) ? n : fallback
  }
  const out: Row = {
    name: str(d.name ?? task.name) || 'Extract',
    file_type: d.file_type === 'xlsx' ? 'xlsx' : 'csv',
    folder_path: str(d.folder_path ?? task.folder_path ?? ''),
    schedule: str(d.schedule ?? task.schedule) || 'daily',
    minute: Math.min(59, Math.max(0, int(d.minute ?? task.minute, 0))),
    hour: Math.min(23, Math.max(0, int(d.hour ?? task.hour, 0))),
    weekday: Math.min(6, Math.max(0, int(d.weekday ?? task.weekday, 0))),
    day: Math.min(31, Math.max(1, int(d.day ?? task.day, 1))),
    timezone: str(d.timezone ?? task.timezone) || 'UTC',
  }
  if ('columns' in d) out.columns = arr(d.columns)
  if ('active' in d) out.active = !!d.active
  const next = computeNextRun({
    schedule: str(out.schedule),
    minute: Number(out.minute),
    hour: Number(out.hour),
    weekday: Number(out.weekday),
    day: Number(out.day),
    timezone: str(out.timezone),
  })
  out.next_run = next ? next.toISOString() : null
  return out
}

/**
 * Run one extract task: build the file, keep it in private storage and
 * book the next run. The original wrote to a folder of the computer it
 * ran on; the portal has no such folder, so the answer carries a link
 * to download the file (good for 7 days) instead of a path.
 */
export async function runExtractTask(db: SupabaseClient, taskId: number, accountId?: string): Promise<string | null> {
  try {
    let query = db.from('foms_extract_tasks').select('*').eq('id', taskId)
    if (accountId) query = query.eq('account_id', accountId)
    const task = check(await query.maybeSingle()) as Row | null
    if (!task) return null
    const ctx: FomsContext = { db, accountId: str(task.account_id) }
    const form = check(await db.from('foms_forms').select('*').eq('id', task.form_id).eq('account_id', ctx.accountId).maybeSingle()) as Row | null
    if (!form) return null
    const columns = arr(task.columns).map(str)
    const { content, ext } = await buildExtract(ctx, form, columns.length > 0 ? columns : defaultColumns(obj(form.working_schema)), str(task.file_type))
    const stamp = nowParts().datetime.replace(/[-:]/g, '').replace(' ', '_')
    const path = `${ctx.accountId}/${form.id}/${fileName(form.name)}_${stamp}.${ext}`
    const up = await db.storage.from('foms-extracts').upload(path, content, { contentType: MIME[ext], upsert: true })
    if (up.error) throw new Error(up.error.message)
    const next = computeNextRun({
      schedule: str(task.schedule),
      minute: Number(task.minute),
      hour: Number(task.hour),
      weekday: Number(task.weekday),
      day: Number(task.day),
      timezone: str(task.timezone),
    })
    await db
      .from('foms_extract_tasks')
      .update({ last_run: new Date().toISOString(), next_run: next ? next.toISOString() : null, last_file: path })
      .eq('id', task.id)
    const signed = await db.storage.from('foms-extracts').createSignedUrl(path, 7 * 24 * 3600)
    return signed.data?.signedUrl ?? path
  } catch (err) {
    console.error('[foms extract] error:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Run the scheduled extracts that are due (called from the portal's scheduled job). */
export async function runDueExtractTasks(db: SupabaseClient, limit = 10): Promise<number> {
  try {
    const { data } = await db
      .from('foms_extract_tasks')
      .select('id')
      .eq('active', true)
      .not('next_run', 'is', null)
      .lte('next_run', new Date().toISOString())
      .limit(limit)
    let ran = 0
    for (const t of (data ?? []) as { id: number }[]) {
      if (await runExtractTask(db, Number(t.id))) ran++
    }
    return ran
  } catch {
    return 0
  }
}

// ------------------------------------------------------------
// The routes
// ------------------------------------------------------------

const json = (data: unknown, status = 200) => NextResponse.json(data, { status })

async function body(request: Request): Promise<Json> {
  try {
    return obj(await request.json())
  } catch {
    return {}
  }
}

/** One request of the FOMS API. `path` is what follows /api/aeda/. */
export async function handleFoms(request: Request, path: string[]): Promise<Response> {
  const ctx = await fomsContext()
  const { db, accountId } = ctx
  const m = request.method.toUpperCase()
  const [a, b, c, d, e] = path
  const url = new URL(request.url)

  // ---- Projects ----------------------------------------------------
  if (a === 'projects' && !b) {
    if (m === 'GET') {
      const rows = check(
        await db
          .from('foms_projects')
          .select('*')
          .eq('account_id', accountId)
          .eq('archived', url.searchParams.get('archived') === '1')
          .order('id', { ascending: false }),
      ) as Row[]
      return json(await Promise.all(rows.map((p) => projectToDict(ctx, p))))
    }
    if (m === 'POST') {
      const data = await body(request)
      const name = str(data.name).trim()
      if (!name) abort(400, 'Project name is required')
      const row = check(
        await db.from('foms_projects').insert({ account_id: accountId, name, description: str(data.description) }).select('*').single(),
      ) as Row
      return json(await projectToDict(ctx, row), 201)
    }
  }

  if (a === 'projects' && b) {
    const pid = intId(b)
    if (!c && m === 'GET') {
      const p = await getProject(ctx, pid)
      const forms = check(await db.from('foms_forms').select('*').eq('project_id', pid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      // Every form, with its archived flag: the screen decides what to show.
      return json({ ...(await projectToDict(ctx, p)), forms: await formsToDicts(ctx, forms) })
    }
    if (!c && m === 'DELETE') {
      await getProject(ctx, pid)
      check(await db.from('foms_projects').delete().eq('id', pid).eq('account_id', accountId))
      return json({ ok: true })
    }
    if (c === 'archive' && m === 'POST') {
      await getProject(ctx, pid)
      const data = await body(request)
      const row = check(
        await db.from('foms_projects').update({ archived: 'archived' in data ? !!data.archived : true }).eq('id', pid).eq('account_id', accountId).select('*').single(),
      ) as Row
      return json(await projectToDict(ctx, row))
    }
    if (c === 'restore-all' && m === 'POST') {
      await getProject(ctx, pid)
      const row = check(await db.from('foms_projects').update({ archived: false }).eq('id', pid).eq('account_id', accountId).select('*').single()) as Row
      check(await db.from('foms_forms').update({ archived: false }).eq('project_id', pid).eq('account_id', accountId))
      return json(await projectToDict(ctx, row))
    }
    if (c === 'forms' && m === 'POST') {
      const data = await body(request)
      const name = str(data.name).trim()
      if (!name) abort(400, 'Form name is required')
      await getProject(ctx, pid)
      const row = check(
        await db
          .from('foms_forms')
          .insert({ account_id: accountId, project_id: pid, name, working_schema: defaultSchema(), working_workflow: {} })
          .select('*')
          .single(),
      ) as Row
      return json(await formToDict(ctx, row), 201)
    }
    if (c === 'import' && m === 'POST') {
      const data = await body(request)
      await getProject(ctx, pid)
      const payload = data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? obj(data.payload) : data
      if (!('schema' in payload)) abort(400, 'Not a valid FOMS form export (missing schema).')
      const name = (str(data.name) || str(payload.name) || 'Imported form').trim()
      const form = check(
        await db
          .from('foms_forms')
          .insert({ account_id: accountId, project_id: pid, name, working_schema: obj(payload.schema), working_workflow: obj(payload.workflow) })
          .select('*')
          .single(),
      ) as Row
      const vmap = new Map<string, number>()
      for (const v of arr(payload.versions) as Json[]) {
        const nv = check(
          await db
            .from('foms_form_versions')
            .insert({
              account_id: accountId,
              form_id: form.id,
              version_no: Number(v.version_no) || vmap.size + 1,
              schema_json: obj(v.schema),
              workflow_json: obj(v.workflow),
            })
            .select('id')
            .single(),
        ) as Row
        vmap.set(str(v.id), Number(nv.id))
      }
      const subs = (arr(payload.submissions) as Json[]).map((s) => ({
        account_id: accountId,
        form_id: form.id,
        uuid: genUuid(),
        version_id: vmap.get(str(s.version_id)) ?? null,
        data: obj(s.data),
        stage: str(s.stage),
        status: str(s.status) || 'submitted',
        modified_by: str(s.modified_by),
      }))
      if (subs.length > 0) check(await db.from('foms_submissions').insert(subs))
      const lookups = (arr(payload.lookups) as Json[]).map((lt) => ({
        account_id: accountId,
        form_id: form.id,
        name: str(lt.name) || 'Lookup',
        key_column: str(lt.key_column),
        key_component: str(lt.key_component),
        columns: arr(lt.columns),
        rows: arr(lt.rows),
        mappings: arr(lt.mappings),
      }))
      if (lookups.length > 0) check(await db.from('foms_lookup_tables').insert(lookups))
      return json(await formToDict(ctx, form), 201)
    }
  }

  // ---- Forms -------------------------------------------------------
  if (a === 'forms' && b) {
    const fid = intId(b)
    const form = await getForm(ctx, fid)
    const touch = { updated_at: new Date().toISOString() }

    if (!c && m === 'GET') {
      const project = await getProject(ctx, Number(form.project_id))
      const versions = check(
        await db.from('foms_form_versions').select('id, form_id, version_no, published_at').eq('form_id', fid).eq('account_id', accountId).order('version_no', { ascending: false }),
      ) as Row[]
      return json({
        ...(await formToDict(ctx, form)),
        project_name: project.name,
        schema: obj(form.working_schema),
        workflow: obj(form.working_workflow),
        versions: versions.map((v) => versionToDict(v)),
      })
    }
    if (!c && m === 'DELETE') {
      check(await db.from('foms_forms').delete().eq('id', fid).eq('account_id', accountId))
      return json({ ok: true })
    }
    if (c === 'save' && m === 'POST') {
      const data = await body(request)
      if (form.status === 'published') abort(409, 'Form is published. Unpublish before editing.')
      const patch: Row = { ...touch }
      if ('schema' in data) patch.working_schema = obj(data.schema)
      if ('workflow' in data) patch.working_workflow = obj(data.workflow)
      if (str(data.name).trim()) patch.name = str(data.name).trim()
      const row = check(await db.from('foms_forms').update(patch).eq('id', fid).eq('account_id', accountId).select('*').single()) as Row
      return json(await formToDict(ctx, row))
    }
    if (c === 'publish' && m === 'POST') {
      const data = await body(request)
      const last = check(
        await db.from('foms_form_versions').select('version_no').eq('form_id', fid).eq('account_id', accountId).order('version_no', { ascending: false }).limit(1),
      ) as Row[]
      const nextNo = last.length > 0 ? Number(last[0].version_no) + 1 : 1
      const version = check(
        await db
          .from('foms_form_versions')
          .insert({ account_id: accountId, form_id: fid, version_no: nextNo, schema_json: obj(form.working_schema), workflow_json: obj(form.working_workflow) })
          .select('id')
          .single(),
      ) as Row
      const hadPrevious = form.published_version_id !== null && form.published_version_id !== undefined
      const row = check(
        await db.from('foms_forms').update({ ...touch, published_version_id: version.id, status: 'published' }).eq('id', fid).eq('account_id', accountId).select('*').single(),
      ) as Row
      let migrated = 0
      if (hadPrevious && data.migrate) {
        const moved = check(await db.from('foms_submissions').update({ version_id: version.id }).eq('form_id', fid).eq('account_id', accountId).select('id')) as Row[]
        migrated = moved.length
      }
      return json({
        ok: true,
        version_no: nextNo,
        published_version_id: version.id,
        had_previous: hadPrevious,
        migrated_submissions: migrated,
        form: await formToDict(ctx, row),
      })
    }
    if (c === 'unpublish' && m === 'POST') {
      const row = check(await db.from('foms_forms').update({ ...touch, status: 'draft' }).eq('id', fid).eq('account_id', accountId).select('*').single()) as Row
      return json(await formToDict(ctx, row))
    }
    if (c === 'versions' && d && e === 'restore' && m === 'POST') {
      const v = (await getVersion(ctx, intId(d))) ?? abort(404, `FormVersion ${d} not found`)
      if (Number(v.form_id) !== fid) abort(400, 'Version does not belong to this form')
      const row = check(
        await db
          .from('foms_forms')
          .update({ ...touch, working_schema: obj(v.schema_json), working_workflow: obj(v.workflow_json), status: 'draft' })
          .eq('id', fid)
          .eq('account_id', accountId)
          .select('*')
          .single(),
      ) as Row
      return json({ ok: true, restored_version_no: v.version_no, form: await formToDict(ctx, row) })
    }
    if (c === 'archive' && m === 'POST') {
      const data = await body(request)
      const row = check(
        await db.from('foms_forms').update({ ...touch, archived: 'archived' in data ? !!data.archived : true }).eq('id', fid).eq('account_id', accountId).select('*').single(),
      ) as Row
      return json(await formToDict(ctx, row))
    }
    if (c === 'restore-only' && m === 'POST') {
      // Bring the project back with only this form active.
      check(await db.from('foms_projects').update({ archived: false }).eq('id', form.project_id).eq('account_id', accountId))
      check(await db.from('foms_forms').update({ archived: true }).eq('project_id', form.project_id).eq('account_id', accountId).neq('id', fid))
      const row = check(await db.from('foms_forms').update({ ...touch, archived: false }).eq('id', fid).eq('account_id', accountId).select('*').single()) as Row
      return json(await formToDict(ctx, row))
    }
    if (c === 'duplicate' && m === 'POST') {
      const data = await body(request)
      const name = (str(data.name) || `${str(form.name)} (copy)`).trim()
      if (!name) abort(400, 'A name is required')
      const nf = check(
        await db
          .from('foms_forms')
          .insert({ account_id: accountId, project_id: form.project_id, name, working_schema: obj(form.working_schema), working_workflow: obj(form.working_workflow) })
          .select('*')
          .single(),
      ) as Row
      const lookups = check(await db.from('foms_lookup_tables').select('*').eq('form_id', fid).eq('account_id', accountId)) as Row[]
      if (lookups.length > 0) {
        check(
          await db.from('foms_lookup_tables').insert(
            lookups.map((lt) => ({
              account_id: accountId,
              form_id: nf.id,
              name: lt.name,
              key_column: lt.key_column,
              key_component: lt.key_component,
              columns: lt.columns,
              rows: lt.rows,
              mappings: lt.mappings,
            })),
          ),
        )
      }
      return json(await formToDict(ctx, nf), 201)
    }
    if (c === 'export' && (m === 'GET' || m === 'POST')) {
      const inc = m === 'POST' ? (await body(request)).include : null
      const want = (k: string) => (inc && typeof inc === 'object' && !Array.isArray(inc) ? !!(inc as Json)[k] : true)
      const payload: Json = { foms_export: true, export_version: 1, exported_at: new Date().toISOString(), name: form.name, status: form.status }
      if (want('schema')) payload.schema = obj(form.working_schema)
      if (want('workflow')) payload.workflow = obj(form.working_workflow)
      if (want('versions')) {
        const versions = check(await db.from('foms_form_versions').select('*').eq('form_id', fid).eq('account_id', accountId).order('version_no')) as Row[]
        payload.versions = versions.map((v) => versionToDict(v, true))
      }
      if (want('submissions')) {
        const subs = check(await db.from('foms_submissions').select('*').eq('form_id', fid).eq('account_id', accountId).order('id')) as Row[]
        const emails = check(await db.from('foms_email_logs').select('*').eq('form_id', fid).eq('account_id', accountId).order('id')) as Row[]
        payload.submissions = subs.map(submissionToDict)
        payload.email_logs = emails.map(emailToDict)
      }
      if (want('lookups')) {
        const lookups = check(await db.from('foms_lookup_tables').select('*').eq('form_id', fid).eq('account_id', accountId)) as Row[]
        const tasks = check(await db.from('foms_extract_tasks').select('*').eq('form_id', fid).eq('account_id', accountId)) as Row[]
        payload.lookups = lookups.map((lt) => lookupToDict(lt, true))
        payload.extract_tasks = tasks.map(taskToDict)
      }
      const name = str(form.name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'form'
      return download(JSON.stringify(payload, null, 2), 'application/json', `${name}_export.json`)
    }
    if (c === 'runtime' && m === 'GET') {
      const project = await getProject(ctx, Number(form.project_id))
      const version = await getVersion(ctx, form.published_version_id)
      const lookups = check(await db.from('foms_lookup_tables').select('*').eq('form_id', fid).eq('account_id', accountId)) as Row[]
      return json({
        form: await formToDict(ctx, form),
        project_name: project.name,
        schema: version ? obj(version.schema_json) : obj(form.working_schema),
        workflow: version ? obj(version.workflow_json) : obj(form.working_workflow),
        version_id: version ? version.id : null,
        lookups: lookups.filter((lt) => lt.key_column && lt.key_component).map((lt) => lookupToDict(lt, true)),
      })
    }
    if (c === 'lookups' && m === 'POST') {
      const formData = await request.formData().catch(() => null)
      const file = formData?.get('file')
      if (!file || typeof file === 'string') abort(400, 'No file uploaded')
      const upload = file as File
      if (upload.size > 4_000_000) abort(400, 'The file is too large (4 MB at most)')
      const { headers, rows } = parseTableFile(upload.name || '', Buffer.from(await upload.arrayBuffer()))
      if (headers.length === 0) abort(400, 'Could not read columns from the file')
      const row = check(
        await db
          .from('foms_lookup_tables')
          .insert({ account_id: accountId, form_id: fid, name: upload.name || 'Lookup', columns: headers, rows, key_column: headers[0] })
          .select('*')
          .single(),
      ) as Row
      return json(lookupToDict(row), 201)
    }
    if (c === 'lookups' && m === 'GET') {
      const rows = check(await db.from('foms_lookup_tables').select('*').eq('form_id', fid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      return json(rows.map((lt) => lookupToDict(lt, url.searchParams.get('rows') === '1')))
    }
    if (c === 'submissions' && m === 'GET') {
      const rows = check(await db.from('foms_submissions').select('*').eq('form_id', fid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      return json(rows.map(submissionToDict))
    }
    if (c === 'submissions' && m === 'POST') {
      const data = await body(request)
      const row = check(
        await db
          .from('foms_submissions')
          .insert({
            account_id: accountId,
            form_id: fid,
            version_id: form.published_version_id ?? null,
            uuid: genUuid(),
            data: obj(data.data),
            stage: str(data.stage),
            status: str(data.status) || 'draft',
          })
          .select('*')
          .single(),
      ) as Row
      return json(submissionToDict(row), 201)
    }
    if ((c === 'run-button' || c === 'preview-run') && m === 'POST') {
      const data = await body(request)
      const preview = c === 'preview-run'
      const version = preview ? null : await getVersion(ctx, form.published_version_id)
      let submission: Row | null = null
      if (!preview && data.submission_id) submission = await getSubmission(ctx, Number(data.submission_id))
      const result = await executeButton(engineStore(ctx, form), {
        schema: version ? obj(version.schema_json) : obj(form.working_schema),
        workflow: version ? obj(version.workflow_json) : obj(form.working_workflow),
        buttonKey: str(data.button_key),
        data: obj(data.data),
        role: str(data.role),
        stage: str(data.stage),
        submission: submission ? { id: Number(submission.id), uuid: str(submission.uuid), exists: true } : null,
        visibleKeys: Array.isArray(data.visible_keys) ? (data.visible_keys as unknown[]).map(str) : null,
        pdfBase64: preview ? null : (data.pdf_base64 as string | null | undefined),
        pdfFilename: preview ? null : (data.pdf_filename as string | null | undefined),
        preview,
      })
      return json(runResult(result))
    }
    if (c === 'http-fetch' && m === 'POST') {
      const data = await body(request)
      const version = await getVersion(ctx, form.published_version_id)
      const comp = findHttpComponent(version ? obj(version.schema_json) : obj(form.working_schema), data.key) ?? abort(404, 'API Fetch component not found')
      const res = await httpCall(comp, obj(data.data))
      return json({
        ok: res.error === null && (res.status ?? 0) < 400,
        status: res.status,
        error: res.error,
        json: res.json,
        text: (res.text ?? '').slice(0, 2000),
      })
    }
    if (c === 'emails' && !d && m === 'GET') {
      const rows = check(await db.from('foms_email_logs').select('*').eq('form_id', fid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      return json(rows.map(emailToDict))
    }
    if (c === 'extract' && m === 'POST') {
      const data = await body(request)
      const columns = arr(data.columns).map(str)
      const { content, ext } = await buildExtract(ctx, form, columns.length > 0 ? columns : defaultColumns(obj(form.working_schema)), data.file_type === 'xlsx' ? 'xlsx' : 'csv')
      return download(content, MIME[ext], `${fileName(form.name)}_submissions.${ext}`)
    }
    if (c === 'emails' && d === 'extract' && m === 'POST') {
      const data = await body(request)
      const given = arr(data.columns).map(str)
      const columns = given.length > 0 ? given : Object.keys(EMAIL_LABELS)
      const rows = check(await db.from('foms_email_logs').select('*').eq('form_id', fid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      const { content, ext } = buildTableFile(
        columns.map((col) => EMAIL_LABELS[col] ?? col),
        rows.map((row) => columns.map((col) => row[col] ?? '')),
        data.file_type === 'xlsx' ? 'xlsx' : 'csv',
        'Emails',
      )
      return download(content, MIME[ext], `${fileName(form.name)}_emails.${ext}`)
    }
    if (c === 'extract-tasks' && m === 'GET') {
      const rows = check(await db.from('foms_extract_tasks').select('*').eq('form_id', fid).eq('account_id', accountId).order('id', { ascending: false })) as Row[]
      return json(rows.map(taskToDict))
    }
    if (c === 'extract-tasks' && m === 'POST') {
      const data = await body(request)
      const row = check(
        await db
          .from('foms_extract_tasks')
          .insert({ account_id: accountId, form_id: fid, ...applyTaskFields({}, data) })
          .select('*')
          .single(),
      ) as Row
      return json(taskToDict(row), 201)
    }
  }

  // ---- Lookups -----------------------------------------------------
  if (a === 'lookups' && b && !c) {
    const lid = intId(b)
    const found = check(await db.from('foms_lookup_tables').select('id').eq('id', lid).eq('account_id', accountId).maybeSingle())
    if (!found) abort(404, `LookupTable ${lid} not found`)
    if (m === 'PUT') {
      const data = await body(request)
      const patch: Row = {}
      if ('name' in data) patch.name = str(data.name)
      if ('key_column' in data) patch.key_column = str(data.key_column)
      if ('key_component' in data) patch.key_component = str(data.key_component)
      if ('mappings' in data) patch.mappings = arr(data.mappings)
      const row =
        Object.keys(patch).length > 0
          ? (check(await db.from('foms_lookup_tables').update(patch).eq('id', lid).eq('account_id', accountId).select('*').single()) as Row)
          : (check(await db.from('foms_lookup_tables').select('*').eq('id', lid).single()) as Row)
      return json(lookupToDict(row))
    }
    if (m === 'DELETE') {
      check(await db.from('foms_lookup_tables').delete().eq('id', lid).eq('account_id', accountId))
      return json({ ok: true })
    }
  }

  // ---- Submissions -------------------------------------------------
  if (a === 'submissions' && b === 'resolve' && c && m === 'GET') {
    const ref = decodeURIComponent(c)
    let row = check(await db.from('foms_submissions').select('*').eq('uuid', ref).eq('account_id', accountId).maybeSingle()) as Row | null
    if (!row && /^\d{1,15}$/.test(ref)) {
      row = check(await db.from('foms_submissions').select('*').eq('id', Number(ref)).eq('account_id', accountId).maybeSingle()) as Row | null
    }
    if (!row) abort(404, 'Submission not found')
    return json(submissionToDict(row as Row))
  }
  if (a === 'submissions' && b && !c) {
    const sid = intId(b)
    const sub = await getSubmission(ctx, sid)
    if (m === 'GET') return json(submissionToDict(sub))
    if (m === 'PUT') {
      const data = await body(request)
      const patch: Row = { updated_at: new Date().toISOString() }
      if ('data' in data) patch.data = obj(data.data)
      if ('stage' in data) patch.stage = str(data.stage)
      if ('status' in data) patch.status = str(data.status)
      if ('modified_by' in data) patch.modified_by = str(data.modified_by)
      const row = check(await db.from('foms_submissions').update(patch).eq('id', sid).eq('account_id', accountId).select('*').single()) as Row
      return json(submissionToDict(row))
    }
    if (m === 'DELETE') {
      check(await db.from('foms_submissions').delete().eq('id', sid).eq('account_id', accountId))
      return json({ ok: true })
    }
  }

  // ---- Extract tasks -----------------------------------------------
  if (a === 'extract-tasks' && b) {
    const tid = intId(b)
    const task = (check(await db.from('foms_extract_tasks').select('*').eq('id', tid).eq('account_id', accountId).maybeSingle()) as Row | null) ?? abort(404, `ExtractTask ${tid} not found`)
    if (!c && m === 'PUT') {
      const row = check(
        await db.from('foms_extract_tasks').update(applyTaskFields(task, await body(request))).eq('id', tid).eq('account_id', accountId).select('*').single(),
      ) as Row
      return json(taskToDict(row))
    }
    if (!c && m === 'DELETE') {
      check(await db.from('foms_extract_tasks').delete().eq('id', tid).eq('account_id', accountId))
      return json({ ok: true })
    }
    if (c === 'run' && m === 'POST') {
      const path = await runExtractTask(db, tid, accountId)
      return json({ ok: !!path, path })
    }
  }

  // ---- Settings ----------------------------------------------------
  if (a === 'settings' && !b && m === 'GET') return json({ accounts: (await emailAccounts(ctx)).map(maskAccount) })
  if (a === 'email-accounts' && m === 'GET') {
    return json((await emailAccounts(ctx)).map((acct) => ({ id: acct.id, name: acct.name || acct.from_email, from_email: acct.from_email })))
  }
  if (a === 'settings' && !b && m === 'POST') {
    // Secrets left blank keep their previous value.
    const data = await body(request)
    const existing = new Map((await emailAccounts(ctx)).map((acct) => [str(acct.id), acct]))
    const out: EmailAccount[] = (arr(data.accounts) as Json[]).map((acct) => {
      const id = str(acct.id) || genUuid(8)
      const prev = existing.get(id)
      return {
        id,
        name: str(acct.name) || str(acct.from_email) || 'Account',
        provider: str(acct.provider) || 'none',
        from_email: str(acct.from_email),
        from_name: str(acct.from_name),
        sendgrid_api_key: str(acct.sendgrid_api_key) || prev?.sendgrid_api_key || '',
        smtp_host: str(acct.smtp_host),
        smtp_port: str(acct.smtp_port) || '587',
        smtp_user: str(acct.smtp_user),
        smtp_pass: str(acct.smtp_pass) || prev?.smtp_pass || '',
        smtp_tls: str(acct.smtp_tls ?? '1'),
      }
    })
    check(
      await db
        .from('foms_settings')
        .upsert({ account_id: accountId, key: 'email_accounts', value: encrypt(JSON.stringify(out)) }, { onConflict: 'account_id,key' }),
    )
    return json({ ok: true, accounts: out.map(maskAccount) })
  }
  if (a === 'settings' && b === 'test' && m === 'POST') {
    const data = await body(request)
    const to = str(data.to).trim()
    if (!to) abort(400, 'Provide a recipient address to test')
    const [sent, detail] = await deliverEmail(
      await emailAccounts(ctx),
      { sender: '', recipient: to, subject: 'FOMS test email', body: 'This is a test email sent from the FOMS portal Settings page.', body_html: '', attachment: '' },
      [],
      data.account_id,
    )
    return json({ sent, detail })
  }

  // ---- Master database (Settings) ------------------------------------
  if (a === 'master' && m === 'GET') {
    const [projects, forms, subs, emails] = (await Promise.all([
      db.from('foms_projects').select('*').eq('account_id', accountId).order('id').then(check),
      db.from('foms_forms').select('id, name, project_id, status, archived, updated_at').eq('account_id', accountId).order('id').then(check),
      db.from('foms_submissions').select('id, uuid, form_id, stage, status, modified_by, data, created_at, updated_at').eq('account_id', accountId).order('id', { ascending: false }).then(check),
      db.from('foms_email_logs').select('*').eq('account_id', accountId).order('id', { ascending: false }).then(check),
    ])) as Row[][]
    const projName = new Map(projects.map((p) => [Number(p.id), p.name]))
    const formName = new Map(forms.map((f) => [Number(f.id), f.name]))
    const formProj = new Map(forms.map((f) => [Number(f.id), Number(f.project_id)]))
    const subCount = new Map<number, number>()
    for (const s of subs) subCount.set(Number(s.form_id), (subCount.get(Number(s.form_id)) ?? 0) + 1)
    return json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? '',
        archived: p.archived === true,
        form_count: forms.filter((f) => f.project_id === p.id).length,
        created_at: p.created_at ?? null,
      })),
      forms: forms.map((f) => ({
        id: f.id,
        name: f.name,
        project_id: f.project_id,
        project_name: projName.get(Number(f.project_id)) ?? '',
        status: f.status,
        archived: f.archived === true,
        submission_count: subCount.get(Number(f.id)) ?? 0,
        updated_at: f.updated_at ?? null,
      })),
      submissions: subs.map((x) => ({
        id: x.id,
        uuid: x.uuid ?? '',
        form_id: x.form_id,
        form_name: formName.get(Number(x.form_id)) ?? '',
        project_name: projName.get(formProj.get(Number(x.form_id)) ?? -1) ?? '',
        stage: x.stage ?? '',
        status: x.status ?? '',
        modified_by: x.modified_by ?? '',
        data: obj(x.data),
        created_at: x.created_at ?? null,
        updated_at: x.updated_at ?? null,
      })),
      emails: emails.map(emailToDict),
    })
  }

  throw new FomsError(m === 'GET' ? 404 : 405, 'Not found')
}
