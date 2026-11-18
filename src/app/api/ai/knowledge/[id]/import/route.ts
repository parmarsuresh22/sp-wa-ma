import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { extractSourceFromRequest, indexDocument } from '@/lib/ai/knowledge-import'
import { fetchWebsiteText, SourceError } from '@/lib/ai/sources'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/knowledge/[id]/import  (admin+)
 *
 * Replace a document's content from its source again:
 *   - a `file` document: multipart with the new spreadsheet;
 *   - a `url` document: JSON `{ url? }` — omitted → re-fetch the saved
 *     address ("Refresh"), given → switch to the new address.
 * The title is kept unless the request names one. Chunks are rebuilt.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { data: existing, error: loadErr } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, source_type, source_url')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (loadErr) {
      console.error('[ai/knowledge/[id]/import] load error:', loadErr)
      return NextResponse.json({ error: t('ai.knowledge.loadDocFailed') }, { status: 500 })
    }
    if (!existing) return NextResponse.json({ error: t('common.notFound') }, { status: 404 })

    const ctype = (request.headers.get('content-type') || '').toLowerCase()
    let title = existing.title as string
    let content: string
    let sourceType: 'file' | 'url'
    let sourceUrl: string | null = (existing.source_url as string | null) ?? null
    let sourceFilename: string | null = null

    if (ctype.includes('multipart/form-data')) {
      const src = await extractSourceFromRequest(request)
      content = src.content
      sourceType = 'file'
      sourceUrl = null
      sourceFilename = src.sourceFilename
      if (src.title && src.title !== src.sourceFilename) title = src.title
    } else {
      const body = (await request.json().catch(() => ({}))) as { url?: unknown; title?: unknown }
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : sourceUrl
      if (!url) throw new SourceError('This document has no web address to refresh')
      const page = await fetchWebsiteText(url)
      content = page.text
      sourceType = 'url'
      sourceUrl = page.url
      if (typeof body.title === 'string' && body.title.trim()) title = body.title.trim()
      else if (existing.source_type !== 'url' && page.title) title = page.title
    }

    const { error: updErr } = await supabase
      .from('ai_knowledge_documents')
      .update({
        title,
        content,
        source_type: sourceType,
        source_url: sourceUrl,
        source_filename: sourceFilename,
        source_fetched_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
    if (updErr) {
      console.error('[ai/knowledge/[id]/import] update error:', updErr)
      return NextResponse.json({ error: t('ai.knowledge.updateDocFailed') }, { status: 500 })
    }

    const outcome = await indexDocument(supabase, accountId, id, content, {
      indexingFailed: t('ai.knowledge.indexingFailed'),
      savedNotIndexed: (message) => t('ai.knowledge.updatedNotIndexed', { message }),
      savedIndexFailed: (message) => t('ai.knowledge.updatedIndexFailed', { message }),
      savedKeywordOnly: t('ai.knowledge.updatedKeywordOnly'),
    })
    return NextResponse.json({
      success: true,
      id,
      title,
      chars: content.length,
      ...(outcome.keywordOnly ? { keyword_only: true } : {}),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    })
  } catch (err) {
    if (err instanceof SourceError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
