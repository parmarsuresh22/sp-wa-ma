// ============================================================
// AEDA Forms on the server (migration 089).
//
// While the module is being tried out, only the platform admin may use
// it: `formsContext()` is the gate of every route, and answers "not
// found" to anyone else, so the module does not exist for them. The
// data is still stored per account, ready for the day the module is
// opened to everyone.
// ============================================================

import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { getSuperAdmin } from '@/lib/admin/super-admin'
import { getCurrentAccount } from '@/lib/auth/account'
import { cleanSchema, type FormSchema } from './schema'

export class FormsError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'FormsError'
    this.status = status
  }
}

export interface FormsContext {
  /** Service-role client: every query below is scoped by `accountId` by hand. */
  db: SupabaseClient
  accountId: string
  userId: string
  email: string
}

/** The caller, if they may use AEDA Forms; otherwise a 404. */
export async function formsContext(): Promise<FormsContext> {
  const admin = await getSuperAdmin()
  if (!admin) throw new FormsError('Not found', 404)
  const account = await getCurrentAccount()
  return { db: admin.db, accountId: account.accountId, userId: admin.userId, email: admin.email }
}

export function formsErrorResponse(err: unknown): NextResponse {
  if (err instanceof FormsError) return NextResponse.json({ error: err.message }, { status: err.status })
  const status = (err as { status?: number } | null)?.status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Not allowed' }, { status })
  }
  console.error('[aeda-forms]', err)
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
}

export const cleanName = (raw: unknown, max = 80): string => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** The long random part of a form's public link. */
export function newPublicToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** The reference shown for an answer, e.g. "K7QM-2XHD-9FPA". */
export function newSubmissionRef(): string {
  const bytes = crypto.randomBytes(12)
  const chars = [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

export interface FormRow {
  id: string
  account_id: string
  project_id: string
  name: string
  schema: FormSchema
  status: 'draft' | 'published'
  published_schema: FormSchema | null
  published_version: number
  published_at: string | null
  public_token: string
  public_enabled: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

export function toFormRow(row: Record<string, unknown>): FormRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    project_id: String(row.project_id),
    name: String(row.name ?? ''),
    schema: cleanSchema(row.schema),
    status: row.status === 'published' ? 'published' : 'draft',
    published_schema: row.published_schema ? cleanSchema(row.published_schema) : null,
    published_version: typeof row.published_version === 'number' ? row.published_version : 0,
    published_at: (row.published_at as string | null) ?? null,
    public_token: String(row.public_token ?? ''),
    public_enabled: row.public_enabled !== false,
    archived_at: (row.archived_at as string | null) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

export async function loadForm(ctx: FormsContext, formId: string): Promise<FormRow> {
  const { data, error } = await ctx.db.from('aeda_forms').select('*').eq('id', formId).eq('account_id', ctx.accountId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new FormsError('Form not found', 404)
  return toFormRow(data as Record<string, unknown>)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function assertId(id: string): string {
  if (!UUID.test(id)) throw new FormsError('Not found', 404)
  return id
}
