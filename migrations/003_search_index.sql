-- Migration 003: Full-text search with materialized view
-- Combines recipe titles and ingredients for fast searching

-- 1. Create materialized view that combines recipe data with all ingredients
CREATE MATERIALIZED VIEW recipe_search_index AS
SELECT 
  r.id,
  r.user_id,
  r.title,
  r.servings,
  r.prep_time,
  r.cook_time,
  r.confidence_score,
  r.created_at,
  -- Weighted tsvector: 'A' = highest priority (title), 'B' = medium (ingredients)
  setweight(to_tsvector('english', r.title), 'A') ||
  setweight(to_tsvector('english', coalesce(string_agg(ri.name, ' '), '')), 'B') as search_vector
FROM recipes r
LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
GROUP BY r.id, r.user_id, r.title, r.servings, r.prep_time, r.cook_time, r.confidence_score, r.created_at;

-- 2. Create GIN index on the search_vector for fast full-text search
CREATE INDEX recipe_search_vector_idx ON recipe_search_index USING GIN(search_vector);

-- 3. Create index on user_id for filtering
CREATE INDEX recipe_search_user_idx ON recipe_search_index(user_id);

-- 4. Function to refresh the materialized view
CREATE OR REPLACE FUNCTION refresh_recipe_search_index()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY recipe_search_index;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 5. Triggers to auto-refresh when recipes or ingredients change
-- Note: CONCURRENTLY requires a unique index
CREATE UNIQUE INDEX recipe_search_id_idx ON recipe_search_index(id);

-- Trigger on recipes table
CREATE TRIGGER refresh_search_on_recipe_change
AFTER INSERT OR UPDATE OR DELETE ON recipes
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_recipe_search_index();

-- Trigger on ingredients table
CREATE TRIGGER refresh_search_on_ingredient_change
AFTER INSERT OR UPDATE OR DELETE ON recipe_ingredients
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_recipe_search_index();

-- 6. Grant permissions (adjust as needed for your Supabase setup)
-- GRANT SELECT ON recipe_search_index TO authenticated;
-- GRANT SELECT ON recipe_search_index TO anon;
