#!/usr/bin/env bash
# Bring a FRESH Postgres to the current schema: reconstructed base, then
# every migration in order (004_search_function.sql is superseded by its
# v2 and skipped, exactly as production applied them).
#
# Usage: db/bootstrap/apply.sh <psql connection args>
#   db/bootstrap/apply.sh "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
#   db/bootstrap/apply.sh -h 127.0.0.1 -U postgres -d postgres
#
# Needs: psql, and a database that already has Supabase's auth schema
# (auth.users, auth.uid()) and PostgREST roles -- `supabase start` or the
# supabase/postgres image provide both. Runs as the connecting role, which
# must be able to create objects in public (the postgres role is).
#
# The base schema is a reconstruction; see db/bootstrap/000_base_schema.sql.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <psql connection args>" >&2
  exit 2
fi

run() { psql -v ON_ERROR_STOP=1 -q "$@"; }

# Record a migration in the platform ledger the way the production workflow
# (Supabase MCP apply_migration) does, so api/core/migration_guard.py --
# /health/ready -- sees a fresh database as fully migrated. The version is
# synthetic ("2000000000_" + stem); only the name matters to the guard.
# Idempotent.
record() {  # record <stem> <note> <psql args...>
  local stem="$1" note="$2"
  shift 2
  local ledger_name="$stem"
  # Production ledgered 020 without its numeric prefix; the guard accepts
  # exactly that alias (LEDGER_NAME_ALIASES), so mirror it here.
  [ "$stem" = "020_riff_lineage_in_search" ] && ledger_name="riff_lineage_in_search"
  run "$@" -c "INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('2000000000_${stem}', '${ledger_name}', ARRAY['${note}'])
    ON CONFLICT (version) DO NOTHING;"
}

echo "== platform migration ledger (Supabase-owned in production; 025 reads it) =="
run "$@" -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations
    (version TEXT PRIMARY KEY, name TEXT, statements TEXT[]);"

echo "== base schema (reconstructed pre-003) =="
run "$@" < "$HERE/000_base_schema.sql"

echo "== migrations =="
for f in "$REPO"/migrations/*.sql; do
  name="$(basename "$f")"
  stem="${name%.sql}"
  if [ "$name" = "004_search_function.sql" ]; then
    echo "   skip $name (superseded by 004_search_function_v2.sql)"
    record "$stem" "-- not applied: superseded by 004_search_function_v2.sql; ledgered so the guard matches production" "$@"
    continue
  fi
  echo "   -> $name"
  run "$@" < "$f"
  record "$stem" "-- applied by db/bootstrap/apply.sh" "$@"
done

echo "== done: base + $(ls "$REPO"/migrations/*.sql | wc -l | tr -d ' ') migration files (one skipped) =="
