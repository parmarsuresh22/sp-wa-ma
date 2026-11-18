-- ============================================================
-- 064: forgiving lexical knowledge search
--
-- `match_ai_knowledge_fts` built its query with plainto_tsquery, which
-- ANDs every word of the customer's message. "Where he is working
-- currently" therefore matched nothing in a document that says
-- "Senior Data Analyst at …" because "currently" never appears, and
-- the bot answered that it had no information while the answer sat in
-- the knowledge base. The 'simple' config has no stemming or stop
-- words either, so any one unfamiliar word sank the whole query.
--
-- Now: every word of three or more characters is ORed, chunks are
-- ranked by how many of them they contain (ts_rank_cd), and the top
-- `p_match_count` come back. The semantic path (embeddings key) is
-- unchanged and still preferred when present.
--
-- Idempotent — same signature, CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH terms AS (
    SELECT DISTINCT lexeme
    FROM unnest(tsvector_to_array(to_tsvector('simple', coalesce(p_query, '')))) AS lexeme
    WHERE length(lexeme) >= 3
  ),
  q AS (
    -- One OR-query over every usable word; NULL when the message has
    -- none (then nothing matches, same as before).
    SELECT CASE WHEN count(*) > 0
      THEN to_tsquery('simple', string_agg(quote_literal(lexeme) || ':*', ' | '))
      ELSE NULL END AS tsq
    FROM terms
  )
  SELECT c.id,
         c.content,
         ts_rank_cd(c.fts, q.tsq) AS rank
  FROM ai_knowledge_chunks c, q
  WHERE c.account_id = p_account_id
    AND q.tsq IS NOT NULL
    AND c.fts @@ q.tsq
  ORDER BY rank DESC, c.chunk_index
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
