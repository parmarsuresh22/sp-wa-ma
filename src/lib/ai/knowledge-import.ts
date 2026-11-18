// ============================================================
// Shared server-side plumbing for the knowledge import routes: read a
// spreadsheet upload or a page URL out of the request, extract text,
// write the document row, chunk + embed, and shape the response the
// settings card already understands (`warning` = saved but indexing
// degraded).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import {
  fetchWebsiteText,
  isSpreadsheetFilename,
  MAX_UPLOAD_BYTES,
  SourceError,
  spreadsheetToText,
} from '@/lib/ai/sources'

export type KnowledgeSourceType = 'text' | 'file' | 'url'

export interface ExtractedSource {
  sourceType: 'file' | 'url'
  title: string
  content: string
  sourceUrl: string | null
  sourceFilename: string | null
}

/**
 * Pull the source out of the request. Multipart with a `file` field →
 * spreadsheet; JSON `{ url }` → web page. `title` is optional on both.
 */
export async function extractSourceFromRequest(request: Request): Promise<ExtractedSource> {
  const ctype = (request.headers.get('content-type') || '').toLowerCase()

  if (ctype.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) throw new SourceError('Choose a spreadsheet file to upload')
    if (!isSpreadsheetFilename(file.name)) {
      throw new SourceError('Upload a spreadsheet: .xlsx, .xls, .csv, .tsv or .ods')
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new SourceError(`The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
    }
    const buffer = await file.arrayBuffer()
    const content = spreadsheetToText(buffer, file.name)
    const titleRaw = form?.get('title')
    const title = typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim() : file.name
    return { sourceType: 'file', title, content, sourceUrl: null, sourceFilename: file.name }
  }

  const body = (await request.json().catch(() => null)) as { url?: unknown; title?: unknown } | null
  const url = typeof body?.url === 'string' ? body.url : ''
  if (!url.trim()) throw new SourceError('Enter the web address to import')
  const page = await fetchWebsiteText(url)
  const title =
    typeof body?.title === 'string' && body.title.trim()
      ? body.title.trim()
      : page.title || page.url
  return { sourceType: 'url', title, content: page.text, sourceUrl: page.url, sourceFilename: null }
}

export interface IndexOutcome {
  /** Null when fully indexed; otherwise the degradation to show. */
  warning: string | null
  keywordOnly: boolean
}

/** Chunk + embed a document; never throws. */
export async function indexDocument(
  db: SupabaseClient,
  accountId: string,
  documentId: string,
  content: string,
  messages: { indexingFailed: string; savedNotIndexed: (m: string) => string; savedIndexFailed: (m: string) => string; savedKeywordOnly: string },
): Promise<IndexOutcome> {
  const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(db, accountId)
  try {
    const ingest = await ingestDocument(db, accountId, { embeddingsApiKey }, documentId, content)
    if (ingest.keywordOnly) {
      const message =
        ingest.embedError instanceof AiError ? ingest.embedError.message : messages.indexingFailed
      console.error('[ai/knowledge import] embedding error:', ingest.embedError)
      return { warning: messages.savedIndexFailed(message), keywordOnly: true }
    }
  } catch (err) {
    const message = err instanceof AiError ? err.message : messages.indexingFailed
    console.error('[ai/knowledge import] ingest error:', err)
    return { warning: messages.savedNotIndexed(message), keywordOnly: true }
  }
  if (corrupt) return { warning: messages.savedKeywordOnly, keywordOnly: true }
  return { warning: null, keywordOnly: false }
}
