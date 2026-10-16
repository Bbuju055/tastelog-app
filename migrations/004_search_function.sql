-- Migration 004: PostgreSQL function for full-text search
-- Allows Python client to call search via RPC

CREATE OR REPLACE FUNCTION search_recipes_fts(
  search_query text,
  user_id_filter uuid,
  result_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  servings text,
  prep_time text,
  cook_time text,
  confidence_score double precision,
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.id,
    r.title,
    r.servings,
    r.prep_time,
    r.cook_time,
    r.confidence_score,
    r.created_at
  FROM recipe_search_index r
  WHERE r.user_id = user_id_filter
    AND r.search_vector @@ websearch_to_tsquery('english', search_query)
  ORDER BY ts_rank(r.search_vector, websearch_to_tsquery('english', search_query)) DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;
