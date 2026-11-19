import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import type { PostRow } from '@/lib/posts/post'
import { broadcastNextChunk } from '@/lib/posts/publish'

// A chunk is a handful of sends with a short pause between them.
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/posts/[id]/broadcast   (agent+)
 *
 * Send the post to the next few contacts of its audience and return the
 * running tally `{ total, sent, failed, done }`. The Posts page calls
 * this in a loop until `done`; calling it again after that is a no-op.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { accountId, userId } = await requireRole('agent')
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const db = supabaseAdmin()
    const { data } = await db
      .from('posts')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const post = data as PostRow | null
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    if (!post.audience || !post.results?.broadcast) {
      return NextResponse.json({ error: 'This post has no broadcast' }, { status: 400 })
    }
    if (post.results.broadcast.done) {
      return NextResponse.json({ broadcast: post.results.broadcast })
    }

    const channel = await loadChannel(db, accountId, post.audience.channel_id)
    if (!channel || channel.provider !== 'waha') {
      const stopped = {
        ...post.results.broadcast,
        done: true,
        last_error: 'The WhatsApp Web number this broadcast was leaving from was removed',
      }
      await db
        .from('posts')
        .update({ results: { ...post.results, broadcast: stopped } })
        .eq('id', post.id)
      return NextResponse.json({ broadcast: stopped })
    }
    if (channel.status !== 'connected') {
      return NextResponse.json(
        { error: 'That WhatsApp Web number is not connected. Reconnect it and continue.' },
        { status: 409 },
      )
    }

    const broadcast = await broadcastNextChunk(db, post, channel, userId)
    await db
      .from('posts')
      .update({
        results: { ...post.results, broadcast },
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id)

    return NextResponse.json({ broadcast })
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[posts] broadcast chunk failed:', err)
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    return toErrorResponse(err)
  }
}
