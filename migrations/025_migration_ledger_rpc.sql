-- Migration 025: read-only migration-ledger RPC for the deployment drift guard
-- (15.2.4-CF-MD1)
--
-- Installs public.migration_ledger(), a restricted read-only window onto
-- supabase_migrations.schema_migrations so the API's service-role client can
-- compare the packaged repository migration inventory against what production
-- has actually applied (see docs/migrations.md and api/core/migration_guard.py).
--
-- SECURITY DEFINER because supabase_migrations is not exposed through
-- PostgREST; the function body is a single fixed SELECT with an empty
-- search_path, so the definer privilege cannot be steered anywhere else.
-- EXECUTE is revoked from PUBLIC/anon/authenticated and granted to
-- service_role only: the ledger is deployment metadata, not user data.

-- Drop-then-create (not CREATE OR REPLACE): replacing a function preserves
-- any pre-existing ACL, so a stray earlier grant would silently survive.
-- Dropping first resets the ACL to defaults before the explicit grants below.
DROP FUNCTION IF EXISTS public.migration_ledger();

CREATE FUNCTION public.migration_ledger()
RETURNS TABLE (version text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.version::text, m.name::text
  FROM supabase_migrations.schema_migrations AS m
  ORDER BY m.version;
$$;

REVOKE ALL ON FUNCTION public.migration_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.migration_ledger() FROM anon;
REVOKE ALL ON FUNCTION public.migration_ledger() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migration_ledger() TO service_role;

-- PostgREST must pick up the new function before the guard can call it.
NOTIFY pgrst, 'reload schema';
