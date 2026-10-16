-- ============================================================================
-- LOADTEST HELPERS — Phase 14.2C
-- ============================================================================
--
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- DO NOT APPLY TO PRODUCTION.
-- LOAD TARGET ONLY.
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
--
-- These functions exist solely to support loadtests/cleanup/run.py
-- against an isolated Supabase project. They are NOT a migration. They
-- MUST NOT live under migrations/. The operator applies this file ONCE
-- to the load target during setup (via Supabase MCP, psql, or the
-- Supabase SQL editor).
--
-- If you are reading this in a production project, something has gone
-- wrong — abort and revoke the functions.
-- ============================================================================

-- Truncate all load-test app data. auth.users is intentionally NOT in
-- the list — users persist across runs so seed remains idempotent.
--
-- The CASCADE keyword clears FK-referencing tables. Child tables
-- (recipe_ingredients, recipe_steps, recipe_tags, cook_events,
-- riff_sessions, riff_messages, grocery_items) are listed explicitly
-- belt-and-suspenders.
CREATE OR REPLACE FUNCTION loadtest_truncate_all()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  TRUNCATE TABLE
    public.recipes,
    public.recipe_ingredients,
    public.recipe_steps,
    public.recipe_tags,
    public.recipe_drafts,
    public.grocery_lists,
    public.grocery_items,
    public.cook_events,
    public.riff_sessions,
    public.riff_messages,
    public.riff_usage_daily
  CASCADE;
END;
$$;

REVOKE ALL ON FUNCTION public.loadtest_truncate_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loadtest_truncate_all() TO service_role;

COMMENT ON FUNCTION public.loadtest_truncate_all() IS
  'Phase 14.2C load-test cleanup. DO NOT APPLY TO PRODUCTION.';

-- Refresh the recipe_search_index materialized view after truncate.
-- Plain REFRESH (not CONCURRENTLY) because the view is empty
-- post-truncate.
CREATE OR REPLACE FUNCTION loadtest_refresh_search_index()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.recipe_search_index;
END;
$$;

REVOKE ALL ON FUNCTION public.loadtest_refresh_search_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loadtest_refresh_search_index() TO service_role;

COMMENT ON FUNCTION public.loadtest_refresh_search_index() IS
  'Phase 14.2C load-test cleanup. DO NOT APPLY TO PRODUCTION.';
