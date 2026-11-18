import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { extractSourceFromRequest, indexDocument } from '@/lib/ai/knowledge-import'
import { SourceError } from '@/lib/ai/sources'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Spreadsheet parsing + page fetching can take a few seconds.
export const maxDuration = 60

/**
 * POST /api/ai/knowledge/import  (admin+)
 *
 * Add a knowledge document from a source other than typed text:
 *   - multipart/form-data with `file` (.xlsx/.xls/.csv/.tsv/.ods) and
 *     optional `title` → every row becomes a "Header: value" line;
 *   - JSON `{ url, title? }` → the page's text, tags stripped.
 *
 * Same response shape as POST /api/ai/knowledge: `{ success, id }`
 * plus `warning` when the document was saved but indexing degraded.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const source = await extractSourceFromRequest(request)

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: accountId,
        created_by: userId,
        title: source.title,
        content: source.content,
        source_type: source.sourceType,
        source_url: source.sourceUrl,
        source_filename: source.sourceFilename,
        source_fetched_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/knowledge/import POST] insert error:', error)
      return NextResponse.json({ error: t('ai.knowledge.saveDocFailed') }, { status: 500 })
    }

    const outcome = await indexDocument(supabase, accountId, doc.id, source.content, {
      indexingFailed: t('ai.knowledge.indexingFailed'),
      savedNotIndexed: (message) => t('ai.knowledge.savedNotIndexed', { message }),
      savedIndexFailed: (message) => t('ai.knowledge.savedIndexFailed', { message }),
      savedKeywordOnly: t('ai.knowledge.savedKeywordOnly'),
    })
    return NextResponse.json({
      success: true,
      id: doc.id,
      title: source.title,
      chars: source.content.length,
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
