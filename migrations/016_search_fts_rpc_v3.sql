-- migrations/016_search_fts_rpc_v3.sql
-- Phase 11.C.2: Fix search_recipes_fts contract drift
--
-- Adds source_url, favorite, and updated_at to the FTS read path.
-- These columns were added to the recipes table in earlier migrations
-- (009 favorite, 014 source_url, plus updated_at from the initial
-- schema) but were never propagated to the recipe_search_index
-- materialized view or the search_recipes_fts RPC return shape.
--
-- Consequence before this migration:
--   - recipe_search_index does not expose source_url/favorite/updated_at
--   - search_recipes_fts RETURNS TABLE omits them
--   - When the RPC returns rows, Pydantic RecipeSearchResult validation
--     at the route layer fails on the missing updated_at (no default,
--     inherited from UTCTimestampModel) → HTTP 500
--
-- This is a pure contract fix. No ranking changes, no new joins, no
-- trigger changes, no refresh function changes. Tags remain out of
-- the view (they live in recipe_tags and are attached post-RPC by
-- _attach_tags in api/core/search.py).
--
-- NOTE: Hard cut — non-reversible. Rollback requires restoring the
-- old view + RPC from migrations 003 + 004_v2.


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
-- the view. The refresh_recipe_search_index trigger function is NOT
-- affected — its body references the view by name and is resolved
-- lazily at execution time. Triggers on recipes and recipe_ingredients
-- remain on the source tables and are untouched.

DROP MATERIALIZED VIEW IF EXISTS recipe_search_index CASCADE;


-- =========================================================================
-- Part 3: Recreate the materialized view
-- =========================================================================
-- Column order (stable and logical):
--   id, user_id, title, source_url, servings, prep_time, cook_time,
--   confidence_score, favorite, created_at, updated_at, search_vector
--
-- Changes from migration 003:
--   - Added source_url, favorite, updated_at to the SELECT
--   - Added the same three columns to the GROUP BY (required because
--     of the string_agg aggregation over recipe_ingredients)
--   - Column order rearranged for readability (no semantic effect)
--
-- Unchanged from migration 003:
--   - search_vector weighting (title 'A' + ingredients 'B')
--   - LEFT JOIN on recipe_ingredients
--   - No tags join (tags are attached post-RPC by _attach_tags in Python)

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
  r.updated_at;


-- =========================================================================
-- Part 4: Recreate the supporting indexes
-- =========================================================================
-- All three required for the same reasons as migration 003:
--   - GIN on search_vector: fast full-text matching
--   - B-tree on user_id: fast per-user filtering in the RPC WHERE clause
--   - Unique on id: required by REFRESH MATERIALIZED VIEW CONCURRENTLY
--     (the refresh_recipe_search_index trigger uses CONCURRENTLY)

CREATE INDEX recipe_search_vector_idx ON recipe_search_index USING GIN(search_vector);

CREATE INDEX recipe_search_user_idx ON recipe_search_index(user_id);

CREATE UNIQUE INDEX recipe_search_id_idx ON recipe_search_index(id);


-- =========================================================================
-- Part 5: Recreate the search_recipes_fts RPC
-- =========================================================================
-- Parameters unchanged from 004/004_v2. RETURNS TABLE expanded to
-- include source_url, favorite, and updated_at — the three fields
-- needed for the RecipeSearchResult wire contract to validate.
--
-- confidence_score::real cast preserved from v2 (view column inherits
-- the recipes.confidence_score source type; the RPC exposes it as real).
--
-- Ranking, filter, and LIMIT logic preserved verbatim from v2.

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
  updated_at timestamptz
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
    r.updated_at
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
-- Migration 004/004_v2 never included an explicit GRANT. Adding one
-- here is safe regardless of whether the default Supabase role setup
-- already permitted authenticated to call the function.

GRANT EXECUTE ON FUNCTION search_recipes_fts(text, uuid, int) TO authenticated;
