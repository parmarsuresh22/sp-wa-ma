import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { DriveError, downloadDriveFile, listDriveImages, openDrive } from '@/lib/google/drive'
import { isPostImageMime, storeAccountImage } from '@/lib/posts/publish'

export const maxDuration = 60

function driveErrorResponse(err: unknown) {
  if (err instanceof DriveError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  return toErrorResponse(err)
}

/**
 * GET /api/google/drive/files?page=<token>   (agent+)
 *
 * Images in the account's "Atlas posts" Drive folder, newest first.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const db = supabaseAdmin()
    const conn = await openDrive(db, accountId)
    const page = new URL(request.url).searchParams.get('page')
    return NextResponse.json(await listDriveImages(db, conn, page))
  } catch (err) {
    return driveErrorResponse(err)
  }
}

/**
 * POST /api/google/drive/files   (agent+)
 *
 * Body: { file_id }
 *
 * Bring one of those images into the post composer: it is copied into
 * the account's media storage (the bridge needs a public address to
 * fetch from, which a Drive link is not) and its URL is returned.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const fileId = typeof body?.file_id === 'string' ? body.file_id : ''
    if (!fileId) return NextResponse.json({ error: 'file_id is required' }, { status: 400 })

    const db = supabaseAdmin()
    const conn = await openDrive(db, accountId)
    const file = await downloadDriveFile(conn, fileId)
    if (!isPostImageMime(file.mime)) {
      return NextResponse.json(
        { error: 'Only PNG, JPEG and WebP images can be used in a post' },
        { status: 400 },
      )
    }
    const stored = await storeAccountImage(db, accountId, file, file.name.replace(/\.[^.]+$/, ''))
    return NextResponse.json({ media_url: stored.url, media_mime: stored.mime })
  } catch (err) {
    if (err instanceof Error && !(err instanceof DriveError) && !('status' in err)) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    return driveErrorResponse(err)
  }
}
