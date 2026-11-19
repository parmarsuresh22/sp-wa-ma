// ============================================================
// Google Drive for posts (migration 072).
//
// One Google OAuth client for the whole deployment (client id + secret
// in `internal_settings`, set on the platform admin page); one Google
// account connected per Atlas account (refresh token, encrypted, in
// `google_drive_connections`).
//
// Scope is `drive.file` only: Atlas can see the files it created itself
// and nothing else in the person's Drive. That is the scope Google
// treats as non-sensitive, and it is all this feature needs — media is
// saved into an "Atlas posts" folder and picked back from there.
//
// Server-only. Every function takes the service-role client.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

export const GOOGLE_CLIENT_ID_KEY = 'google_client_id'
export const GOOGLE_CLIENT_SECRET_KEY = 'google_client_secret'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_FOLDER_NAME = 'Atlas posts'
export const DRIVE_STATE_COOKIE = 'atlas_drive_state'

const TIMEOUT_MS = 30_000

export class DriveError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status = 502, code = 'drive_error') {
    super(message)
    this.name = 'DriveError'
    this.status = status
    this.code = code
  }
}

export interface GoogleOAuthClient {
  clientId: string
  clientSecret: string
}

/** The deployment's Google OAuth client, or null when none is saved. */
export async function loadGoogleClient(db: SupabaseClient): Promise<GoogleOAuthClient | null> {
  const { data } = await db
    .from('internal_settings')
    .select('key, value')
    .in('key', [GOOGLE_CLIENT_ID_KEY, GOOGLE_CLIENT_SECRET_KEY])
  const map = new Map(((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]))
  const clientId = map.get(GOOGLE_CLIENT_ID_KEY)?.trim()
  const secret = map.get(GOOGLE_CLIENT_SECRET_KEY)
  if (!clientId || !secret) return null
  try {
    return { clientId, clientSecret: decrypt(secret) }
  } catch {
    console.error('[drive] saved Google client secret could not be decrypted — check ENCRYPTION_KEY')
    return null
  }
}

export async function saveGoogleClient(
  db: SupabaseClient,
  input: { clientId: string; clientSecret: string },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db.from('internal_settings').upsert(
    [
      { key: GOOGLE_CLIENT_ID_KEY, value: input.clientId, updated_at: now },
      { key: GOOGLE_CLIENT_SECRET_KEY, value: encrypt(input.clientSecret), updated_at: now },
    ],
    { onConflict: 'key' },
  )
  if (error) throw new DriveError(error.message, 500)
}

/** Where Google sends the person back to after consent. */
export function driveRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/google/drive/callback`
}

export function newOAuthState(): string {
  return crypto.randomBytes(24).toString('hex')
}

export function driveAuthUrl(client: GoogleOAuthClient, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: driveRedirectUri(origin),
    response_type: 'code',
    scope: DRIVE_SCOPE,
    // offline + consent: Google only returns a refresh token on a
    // consent screen, and we need one to work when nobody is signed in.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new DriveError(
      `Could not reach Google: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }
}

async function googleError(res: Response, what: string): Promise<DriveError> {
  let detail = ''
  try {
    const body = (await res.json()) as {
      error?: { message?: string } | string
      error_description?: string
    }
    detail =
      body.error_description ||
      (typeof body.error === 'string' ? body.error : (body.error?.message ?? ''))
  } catch {
    /* not JSON */
  }
  return new DriveError(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`, 502)
}

/** Trade the consent code for tokens. */
export async function exchangeDriveCode(
  client: GoogleOAuthClient,
  origin: string,
  code: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const res = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: driveRedirectUri(origin),
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw await googleError(res, 'Google sign-in')
  const body = (await res.json()) as { refresh_token?: string; access_token?: string }
  if (!body.refresh_token || !body.access_token) {
    throw new DriveError(
      'Google did not return a long-lived token. Remove Atlas under Google Account → Security → Third-party access and connect again.',
      400,
    )
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token }
}

export interface DriveConnection {
  accountId: string
  email: string | null
  folderId: string | null
  accessToken: string
}

interface ConnectionRow {
  account_id: string
  refresh_token: string
  email: string | null
  folder_id: string | null
}

/** Public facts about the connection — never the token. */
export async function driveStatus(
  db: SupabaseClient,
  accountId: string,
): Promise<{ configured: boolean; connected: boolean; email: string | null }> {
  const [client, { data }] = await Promise.all([
    loadGoogleClient(db),
    db.from('google_drive_connections').select('email').eq('account_id', accountId).maybeSingle(),
  ])
  return {
    configured: !!client,
    connected: !!data,
    email: (data as { email?: string | null } | null)?.email ?? null,
  }
}

/**
 * A usable connection (fresh access token) for the account. Throws a
 * `DriveError` with code `not_connected` when there is none, or when
 * Google has revoked it (the stale row is removed so the UI offers
 * "Connect" again).
 */
export async function openDrive(db: SupabaseClient, accountId: string): Promise<DriveConnection> {
  const client = await loadGoogleClient(db)
  if (!client) throw new DriveError('Google Drive is not set up on this site yet.', 400, 'not_configured')
  const { data } = await db
    .from('google_drive_connections')
    .select('account_id, refresh_token, email, folder_id')
    .eq('account_id', accountId)
    .maybeSingle()
  const row = data as ConnectionRow | null
  if (!row) throw new DriveError('Google Drive is not connected.', 400, 'not_connected')

  let refreshToken: string
  try {
    refreshToken = decrypt(row.refresh_token)
  } catch {
    throw new DriveError('The saved Google connection is unreadable. Connect again.', 400, 'not_connected')
  }
  const res = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      // invalid_grant: access was revoked or expired on Google's side.
      await db.from('google_drive_connections').delete().eq('account_id', accountId)
      throw new DriveError('Google Drive access was revoked. Connect again.', 400, 'not_connected')
    }
    throw await googleError(res, 'Google token refresh')
  }
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new DriveError('Google returned no access token', 502)
  return { accountId, email: row.email, folderId: row.folder_id, accessToken: body.access_token }
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'

/** The Google account's email address (shown as "connected as"). */
export async function driveUserEmail(accessToken: string): Promise<string | null> {
  const res = await googleFetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { user?: { emailAddress?: string } } | null
  return body?.user?.emailAddress ?? null
}

/** The "Atlas posts" folder: the saved one if it still exists, else new. */
export async function ensureDriveFolder(db: SupabaseClient, conn: DriveConnection): Promise<string> {
  const auth = { Authorization: `Bearer ${conn.accessToken}` }
  if (conn.folderId) {
    const check = await googleFetch(`${DRIVE_API}/files/${conn.folderId}?fields=id,trashed`, {
      headers: auth,
    })
    if (check.ok) {
      const f = (await check.json().catch(() => null)) as { id?: string; trashed?: boolean } | null
      if (f?.id && !f.trashed) return f.id
    }
  }
  const res = await googleFetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })
  if (!res.ok) throw await googleError(res, 'Creating the Drive folder')
  const created = (await res.json()) as { id?: string }
  if (!created.id) throw new DriveError('Google returned no folder id', 502)
  await db
    .from('google_drive_connections')
    .update({ folder_id: created.id })
    .eq('account_id', conn.accountId)
  conn.folderId = created.id
  return created.id
}

/** Save a file into the Atlas folder; returns its Drive file id. */
export async function uploadToDrive(
  db: SupabaseClient,
  conn: DriveConnection,
  file: { name: string; mime: string; bytes: Buffer; description?: string },
): Promise<string> {
  const folderId = await ensureDriveFolder(db, conn)
  const boundary = `atlas${crypto.randomBytes(12).toString('hex')}`
  const meta = JSON.stringify({
    name: file.name,
    parents: [folderId],
    ...(file.description ? { description: file.description.slice(0, 1000) } : {}),
  })
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const res = await googleFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
  )
  if (!res.ok) throw await googleError(res, 'Saving to Google Drive')
  const created = (await res.json()) as { id?: string }
  if (!created.id) throw new DriveError('Google returned no file id', 502)
  return created.id
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  createdTime: string | null
  thumbnailLink: string | null
  description: string | null
}

/** Images Atlas saved in its folder, newest first. */
export async function listDriveImages(
  db: SupabaseClient,
  conn: DriveConnection,
  pageToken?: string | null,
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const folderId = await ensureDriveFolder(db, conn)
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
    orderBy: 'createdTime desc',
    pageSize: '24',
    fields: 'nextPageToken, files(id, name, mimeType, createdTime, thumbnailLink, description)',
  })
  if (pageToken) params.set('pageToken', pageToken)
  const res = await googleFetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${conn.accessToken}` },
  })
  if (!res.ok) throw await googleError(res, 'Listing Google Drive')
  const body = (await res.json()) as { files?: Partial<DriveFile>[]; nextPageToken?: string }
  return {
    files: (body.files ?? []).map((f) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? 'image/jpeg',
      createdTime: f.createdTime ?? null,
      thumbnailLink: f.thumbnailLink ?? null,
      description: f.description ?? null,
    })),
    nextPageToken: body.nextPageToken ?? null,
  }
}

/** Download one file's bytes (only files Atlas can see, i.e. its own). */
export async function downloadDriveFile(
  conn: DriveConnection,
  fileId: string,
): Promise<{ bytes: Buffer; mime: string; name: string }> {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw new DriveError('Unknown file', 404)
  const auth = { Authorization: `Bearer ${conn.accessToken}` }
  const metaRes = await googleFetch(`${DRIVE_API}/files/${fileId}?fields=id,name,mimeType,size`, {
    headers: auth,
  })
  if (!metaRes.ok) throw await googleError(metaRes, 'Reading the Drive file')
  const meta = (await metaRes.json()) as { name?: string; mimeType?: string; size?: string }
  if (!(meta.mimeType ?? '').startsWith('image/')) {
    throw new DriveError('Only images can be used in a post', 400)
  }
  if (Number(meta.size ?? 0) > 16 * 1024 * 1024) {
    throw new DriveError('That file is larger than 16 MB', 400)
  }
  const res = await googleFetch(`${DRIVE_API}/files/${fileId}?alt=media`, { headers: auth })
  if (!res.ok) throw await googleError(res, 'Downloading from Google Drive')
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: meta.mimeType ?? 'image/jpeg',
    name: meta.name ?? 'image',
  }
}
