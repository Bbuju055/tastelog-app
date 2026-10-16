-- migrations/020_riff_lineage_in_search.sql
-- Phase 13.6.4-FU: Saved Riff Lineage in recipe list/search read paths
--
-- Adds parent_recipe_id, riff_session_id, riff_label to:
--   1. The recipe_search_index materialized view column list
--   2. The search_recipes_fts RPC RETURNS TABLE shape and SELECT projection
--
-- These columns were added to the recipes table by migration 018
-- (Phase 13.1) and are populated by save_riff_recipe (Phase 13.2). The
-- non-FTS read paths (get_recipe, list_recipes, search_recipes_simple)
-- already select them after this ticket. This migration closes the gap
-- so that FTS search results carry the same lineage and the mobile
-- indicator behaves identically across list, simple search, and FTS.
--
-- Mirrors migration 016 in shape (DROP FUNCTION → DROP MATERIALIZED VIEW
-- CASCADE → recreate view → recreate 3 indexes → recreate function →
-- grant) and re-issues migration 017's REVOKE so the materialized view
-- stays internal-only (PostgREST lockdown preserved). No ranking, no
-- joins, no trigger, no refresh-function changes.
--
-- NOTE: Hard cut — non-reversible. Rollback requires restoring the
-- view + RPC from migration 016.


-- =========================================================================
-- Part 1: Drop the existing function
-- =========================================================================
-- RETURNS TABLE is part of the function signature — CREATE OR REPLACE
-- cannot change the return type, so we must drop first.

DROP FUNCTION IF EXISTS search_recipes_fts(text, uuid, int);


-- =========================================================================
-- Part 2: Drop the existing materialized view (with its indexes)
-- =========================================================================
-- CASCADE drops the GIN, user_id, and unique-id indexes that depend on
-- the view. Triggers on recipes and recipe_ingredients remain on the
-- source tables and are untouched. The refresh function body resolves
-- the view name lazily.

DROP MATERIALIZED VIEW IF EXISTS recipe_search_index CASCADE;


-- =========================================================================
-- Part 3: Recreate the materialized view
-- =========================================================================
-- Column order extends migration 016 by appending the three lineage
-- columns at the end (before search_vector). Lineage columns also added
-- to GROUP BY because of the string_agg over recipe_ingredients.
--
-- Unchanged from migration 016:
--   - search_vector weighting (title 'A' + ingredients 'B')
--   - LEFT JOIN on recipe_ingredients
--   - No tags join (tags attached post-RPC by _attach_tags in Python)

CREATE MATERIALIZED VIEW recipe_search_index AS
SELECT
  r.id,
  r.user_id,
  r.title,
  r.source_url,
  r.servings,
  r.prep_time,
  r.cook_time,
  r.confidence_score,
  r.favorite,
  r.created_at,
  r.updated_at,
  r.parent_recipe_id,
  r.riff_session_id,
  r.riff_label,
  setweight(to_tsvector('english', r.title), 'A') ||
  setweight(to_tsvector('english', coalesce(string_agg(ri.name, ' '), '')), 'B') as search_vector
FROM recipes r
LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
GROUP BY
  r.id,
  r.user_id,
  r.title,
  r.source_url,
  r.servings,
  r.prep_time,
  r.cook_time,
  r.confidence_score,
  r.favorite,
  r.created_at,
  r.updated_at,
  r.parent_recipe_id,
  r.riff_session_id,
  r.riff_label;


-- =========================================================================
-- Part 4: Recreate the supporting indexes
-- =========================================================================
-- Same three required for the same reasons as migrations 003 and 016:
--   - GIN on search_vector: fast full-text matching
--   - B-tree on user_id: fast per-user filtering in the RPC WHERE clause
--   - Unique on id: required by REFRESH MATERIALIZED VIEW CONCURRENTLY

CREATE INDEX recipe_search_vector_idx ON recipe_search_index USING GIN(search_vector);

CREATE INDEX recipe_search_user_idx ON recipe_search_index(user_id);

CREATE UNIQUE INDEX recipe_search_id_idx ON recipe_search_index(id);


-- =========================================================================
-- Part 5: Recreate the search_recipes_fts RPC
-- =========================================================================
-- Parameters unchanged from migration 016. RETURNS TABLE extended to
-- include parent_recipe_id, riff_session_id, riff_label. SELECT
-- projection extended to match.
--
-- confidence_score::real cast preserved from v2 (view column inherits
-- the recipes.confidence_score source type; RPC exposes it as real).
--
-- Ranking, filter, and LIMIT logic preserved verbatim.

CREATE FUNCTION search_recipes_fts(
  search_query text,
  user_id_filter uuid,
  result_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  source_url text,
  servings text,
  prep_time text,
  cook_time text,
  confidence_score real,
  favorite boolean,
  created_at timestamptz,
  updated_at timestamptz,
  parent_recipe_id uuid,
  riff_session_id uuid,
  riff_label text
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.title,
    r.source_url,
    r.servings,
    r.prep_time,
    r.cook_time,
    r.confidence_score::real,
    r.favorite,
    r.created_at,
    r.updated_at,
    r.parent_recipe_id,
    r.riff_session_id,
    r.riff_label
  FROM recipe_search_index r
  WHERE r.user_id = user_id_filter
    AND r.search_vector @@ websearch_to_tsquery('english', search_query)
  ORDER BY ts_rank(r.search_vector, websearch_to_tsquery('english', search_query)) DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;


-- =========================================================================
-- Part 6: Grant execute to authenticated
-- =========================================================================
-- Mirrors migration 016. The FastAPI backend uses the service_role
-- client (get_db) for all reads, so this grant is defensive only —
-- mobile hits search through FastAPI, never the Supabase Data API
-- directly. Keeping it consistent with 016 avoids accidental drift.

GRANT EXECUTE ON FUNCTION search_recipes_fts(text, uuid, int) TO authenticated;


-- =========================================================================
-- Part 7: Re-issue migration 017's lockdown (PostgREST internal-only)
-- =========================================================================
-- Materialized view recreation in Part 2 dropped any prior REVOKE state
-- along with the view itself. Supabase auto-grants SELECT on public-
-- schema objects to anon and authenticated, exposing them via the
-- PostgREST Data API. recipe_search_index bypasses source-table RLS,
-- so this re-revoke is required to preserve the 11.C.3 internal-only
-- posture. Without it, an authenticated user could query
-- /rest/v1/recipe_search_index directly and see other users' recipe
-- metadata.

REVOKE SELECT ON recipe_search_index FROM anon, authenticated;
