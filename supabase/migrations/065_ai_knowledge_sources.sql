-- ============================================================
-- 065: knowledge-base documents can come from a file or a website
--
-- Until now a document was text typed or pasted into the form. Two
-- more sources, each kept as a document whose `content` is the text
-- we extracted, so chunking, search and embeddings are unchanged:
--
--   * 'file' — an uploaded spreadsheet (.xlsx / .xls / .csv). Every
--              row becomes one "Header: value | Header: value" line, so
--              a price list or product table reads like a table of
--              facts to the model. "Replace file" re-uploads.
--   * 'url'  — a web page fetched by URL, tags stripped. "Refresh"
--              re-fetches the same address.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS source_filename TEXT,
  ADD COLUMN IF NOT EXISTS source_fetched_at TIMESTAMPTZ;

ALTER TABLE ai_knowledge_documents DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_type_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_type_check
  CHECK (source_type IN ('text', 'file', 'url'));

COMMENT ON COLUMN ai_knowledge_documents.source_type IS
  'text = typed in the form; file = uploaded spreadsheet (source_filename); url = fetched web page (source_url, source_fetched_at).';
