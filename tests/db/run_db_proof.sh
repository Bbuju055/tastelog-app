#!/usr/bin/env bash
# tests/db/run_db_proof.sh
# Real-PostgreSQL proof harness for migrations 026 (Issue 1) and 027
# (Issue 3).
#
# Spins up the Supabase Postgres image at production's version (17.6),
# rebuilds the pre-026 schema (reconstructed base + the repo's actual
# migration chain 003..025), seeds production-shaped data, applies
# migration 026, then runs:
#   - the single-session proof batteries (proof_migration_026.sql)
#   - three genuinely concurrent batteries (two psql sessions each)
# then (Issue 3): plants privilege bypass seeds, applies migration 027,
# runs the U0..U18 batteries (proof_migration_027.sql) and the C-ED1..
# C-ED3 concurrent edit batteries.
#
# Usage: tests/db/run_db_proof.sh   (from the repo root or anywhere)
# Requires: docker. Exit 0 = every battery passed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMG="public.ecr.aws/supabase/postgres:17.6.1.143"
NAME="tastelog-026-proof-$$"
PGPASSWORD_VAL="proof-password"

CHAIN=(
  003_search_index.sql
  # 004_search_function.sql superseded by v2 (return type changed; v2 is
  # the applied shape -- applying both fails on the changed OUT row type).
  004_search_function_v2.sql
  005_recipe_drafts.sql
  006_confirm_recipe_draft_rpc.sql
  007_capture_tokens.sql
  008_grocery_lists_updated_at.sql
  009_recipes_favorite.sql
  010_recipe_tags.sql
  011_grocery_consolidated.sql
  012_grocery_lists_user_name.sql
  013_multi_image_drafts.sql
  014_source_url.sql
  015_cook_events.sql
  016_search_fts_rpc_v3.sql
  017_lockdown_recipe_search_index.sql
  018_recipe_riff.sql
  019_riff_perf_hardening.sql
  020_riff_lineage_in_search.sql
  021_riff_usage.sql
  022_riff_draft_anchor.sql
  023_save_draft_riff_recipe.sql
  024_grocery_items_note.sql
  025_migration_ledger_rpc.sql
)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== starting $IMG as $NAME =="
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD="$PGPASSWORD_VAL" \
  "$IMG" >/dev/null

PSQL() {
  docker exec -i -e PGPASSWORD="$PGPASSWORD_VAL" "$NAME" \
    psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}
# Image superuser -- used ONLY for auth.users seeding (GoTrue's job in prod).
PSQLA() {
  docker exec -i -e PGPASSWORD="$PGPASSWORD_VAL" "$NAME" \
    psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== waiting for postgres =="
for i in $(seq 1 60); do
  if PSQL -c "SELECT 1" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "postgres never became ready"; exit 1; fi
  sleep 2
done
# The supabase image restarts once during init; require stability.
sleep 5
PSQL -c "SELECT 1" >/dev/null

echo "== platform ledger table (Supabase-owned in prod; needed by 025) =="
PSQLA -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations
    (version TEXT PRIMARY KEY, name TEXT, statements TEXT[]);
  GRANT USAGE ON SCHEMA supabase_migrations TO postgres;
  GRANT SELECT ON supabase_migrations.schema_migrations TO postgres;"

echo "== base schema (reconstructed pre-003) =="
PSQL < "$REPO/db/bootstrap/000_base_schema.sql"

echo "== migration chain 003..025 =="
for f in "${CHAIN[@]}"; do
  echo "   -> $f"
  PSQL < "$REPO/migrations/$f"
done

echo "== seed users (as supabase_admin -- GoTrue's job in prod) =="
PSQLA -c "INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'user-a@proof.local'),
  ('00000000-0000-4000-8000-00000000000b', 'user-b@proof.local');"

echo "== seed production-shaped pre-026 data =="
PSQL < "$HERE/seed_pre026.sql"

echo "== APPLY MIGRATION 026 =="
PSQL < "$REPO/migrations/026_step_ingredient_mapping.sql"

echo "== single-session proof batteries =="
PSQL < "$HERE/proof_migration_026.sql"

# ---------------------------------------------------------------------------
# Concurrency batteries. Session A holds the recipe lock inside an open
# transaction while session B attempts the conflicting operation; B must
# block until A commits and the final state must be exactly one winner's.
# ---------------------------------------------------------------------------
R="00000000-0000-4000-8000-0000000000a1"

echo "== C0: concurrency fixtures =="
# After the single-session batteries, recipe A1 holds exactly one
# ingredient ('vanilla', position 4). Add two named ingredients so the
# concurrency batteries have distinct positions 2 and 3 to fight over.
PSQL -c "INSERT INTO recipe_ingredients (recipe_id, position, name) VALUES
  ('$R', 91, 'c-a'), ('$R', 92, 'c-b');" >/dev/null

echo "== C1: concurrent attach vs attach (no union, single winner) =="
PSQL -c "SET ROLE service_role; SELECT attach_step_ingredient_mapping('$R'::uuid,
  '[{\"step_position\":2,\"ingredient_positions\":[1]}]'::jsonb);" >/dev/null
PSQL <<'SQL' &
SET ROLE service_role;
BEGIN;
SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1'::uuid,
  '[{"step_position":2,"ingredient_positions":[1]}]'::jsonb);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
PSQL -c "SET ROLE service_role; SELECT attach_step_ingredient_mapping('$R'::uuid,
  '[{\"step_position\":2,\"ingredient_positions\":[2]}]'::jsonb);" >/dev/null
wait "$A_PID"
PSQL <<'SQL'
SELECT _assert(
  (SELECT array_agg(ri.name ORDER BY ri.name)
   FROM recipe_step_ingredients rsi
   JOIN recipe_ingredients ri ON ri.id = rsi.ingredient_id
   WHERE rsi.step_id = '00000000-0000-4000-8000-0000000000a3') = ARRAY['c-a'],
  'C1: second attach fully replaced the first (no union)');
SELECT _assert(
  (SELECT ingredient_mapping_version FROM recipe_steps
   WHERE id = '00000000-0000-4000-8000-0000000000a3') = 1,
  'C1: winner mapping is authoritative');
SQL

echo "== C2: concurrent ingredient insert vs attach (no stale authority) =="
PSQL <<'SQL' &
SET ROLE service_role;
BEGIN;
SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1'::uuid,
  '[{"step_position":2,"ingredient_positions":[1]}]'::jsonb);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
# Blocks on the recipe lock held by the open attach; its demotion must
# land AFTER the attach's promotion, leaving the step honestly unknown.
PSQL -c "INSERT INTO recipe_ingredients (recipe_id, position, name)
         VALUES ('$R', 90, 'late-added-spice');" >/dev/null
wait "$A_PID"
PSQL <<'SQL'
SELECT _assert(
  (SELECT ingredient_mapping_version FROM recipe_steps
   WHERE id = '00000000-0000-4000-8000-0000000000a3') IS NULL,
  'C2: concurrent ingredient insert demoted the freshly attached mapping');
SQL

echo "== C3: concurrent identical riff saves (exactly one recipe) =="
PSQL <<'SQL'
INSERT INTO riff_sessions (id, user_id, source_recipe_id)
VALUES ('00000000-0000-4000-8000-0000000000c5',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000a1');
INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-0000000000e5',
        '00000000-0000-4000-8000-0000000000c5',
        'assistant', 'Race target.',
        '{"title":"Race Riff","servings":null,"prep_time":null,"cook_time":null,
          "confidence":1.0,
          "ingredients":[{"quantity":null,"unit":null,"name":"x","prep":null}],
          "steps":[{"position":1,"instruction":"y"}]}'::jsonb);
SQL
PSQL <<'SQL' &
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SET ROLE authenticated;
BEGIN;
SELECT save_riff_recipe_atomic('00000000-0000-4000-8000-0000000000a1'::uuid,
  '00000000-0000-4000-8000-0000000000c5'::uuid,
  '00000000-0000-4000-8000-0000000000e5'::uuid, NULL);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
B_OUT="$(PSQL -t -A <<'SQL'
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SET ROLE authenticated;
SELECT save_riff_recipe_atomic('00000000-0000-4000-8000-0000000000a1'::uuid,
  '00000000-0000-4000-8000-0000000000c5'::uuid,
  '00000000-0000-4000-8000-0000000000e5'::uuid, NULL) ->> 'status';
SQL
)"
wait "$A_PID"
echo "   second saver status: $(echo "$B_OUT" | tail -1)"
PSQL <<SQL
SELECT _assert(
  (SELECT count(*) FROM recipes
   WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e5') = 1,
  'C3: concurrent identical saves produced exactly one recipe');
SELECT _assert('$(echo "$B_OUT" | tail -1)' = 'already_saved',
  'C3: loser resolved to already_saved');
SQL

# ---------------------------------------------------------------------------
# Issue 3: migration 027 proof.
# ---------------------------------------------------------------------------

echo ""
echo "== ISSUE 3: plant privilege bypass seeds (pre-027) =="
# The 027 battery (U0b) proves these seeded grants are effectively revoked:
# PUBLIC inheritance, a column-level grant, and a direct role grant.
PSQL -c "GRANT INSERT ON recipes TO PUBLIC;
  GRANT UPDATE (title) ON recipes TO authenticated;
  GRANT DELETE ON recipe_steps TO anon;"

echo "== APPLY MIGRATION 027 =="
PSQL < "$REPO/migrations/027_recipe_content_editing.sql"

echo "== Issue 3 single-session proof batteries (U0..U18) =="
PSQL < "$HERE/proof_migration_027.sql"

echo "== C-ED helpers =="
PSQL <<'SQL'
CREATE OR REPLACE FUNCTION _try_edit(
    p_recipe uuid, p_user uuid, p_rev int, p_ops jsonb)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    PERFORM update_recipe_content(
        p_recipe, p_user, p_rev, gen_random_uuid(), p_ops, NULL, '[]'::jsonb);
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;
CREATE OR REPLACE FUNCTION _try_attach(p_recipe uuid, p_rev int, p_map jsonb)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    PERFORM attach_step_ingredient_mapping(p_recipe, p_rev, p_map);
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;
SQL

E1="00000000-0000-4000-8000-00000000ed01"
E2="00000000-0000-4000-8000-00000000ed02"
UA="00000000-0000-4000-8000-00000000000a"

echo "== C-ED1: attach computed against a superseded revision is refused =="
REV="$(PSQL -t -A -c "SELECT content_rev FROM recipes WHERE id = '$E1';")"
PSQL <<SQL &
BEGIN;
SELECT update_recipe_content('$E1'::uuid, '$UA'::uuid, $REV,
  gen_random_uuid(), '{"fields":{"title":"CED1 winner"}}'::jsonb,
  NULL, '[]'::jsonb);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
# Blocks on the edit's row lock; once the edit commits, the attach sees
# the advanced revision and must refuse (TL428), never promote.
B_OUT="$(PSQL -t -A -c "SELECT _try_attach('$E1'::uuid, $REV,
  '[{\"step_position\":1,\"ingredient_positions\":[1]}]'::jsonb);" | tail -1)"
wait "$A_PID"
echo "   stale attach outcome: $B_OUT"
PSQL <<SQL
SELECT _assert('$B_OUT' = 'TL428',
  'C-ED1: stale-revision attach refused with TL428');
SELECT _assert(
  (SELECT title = 'CED1 winner' AND content_rev = $REV + 1
   FROM recipes WHERE id = '$E1'),
  'C-ED1: the edit committed exactly once');
SQL

echo "== C-ED2: concurrent edits (second is a typed conflict) =="
REV="$(PSQL -t -A -c "SELECT content_rev FROM recipes WHERE id = '$E1';")"
PSQL <<SQL &
BEGIN;
SELECT update_recipe_content('$E1'::uuid, '$UA'::uuid, $REV,
  gen_random_uuid(), '{"fields":{"title":"CED2 A wins"}}'::jsonb,
  NULL, '[]'::jsonb);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
B_OUT="$(PSQL -t -A -c "SELECT _try_edit('$E1'::uuid, '$UA'::uuid, $REV,
  '{\"fields\":{\"title\":\"CED2 B stale\"}}'::jsonb);" | tail -1)"
wait "$A_PID"
echo "   stale edit outcome: $B_OUT"
PSQL <<SQL
SELECT _assert('$B_OUT' = 'TL409',
  'C-ED2: stale concurrent edit conflicts with TL409');
SELECT _assert(
  (SELECT title = 'CED2 A wins' AND content_rev = $REV + 1
   FROM recipes WHERE id = '$E1'),
  'C-ED2: exactly one winner, one revision advance');
SQL

echo "== C-ED3: delete/edit orderings (no resurrection, full convergence) =="
# Order A: delete completes first -> the edit is a truthful TL404.
REV="$(PSQL -t -A -c "SELECT content_rev FROM recipes WHERE id = '$E2';")"
PSQL -c "DELETE FROM recipe_steps WHERE recipe_id = '$E2';
  DELETE FROM recipe_ingredients WHERE recipe_id = '$E2';
  DELETE FROM recipes WHERE id = '$E2';" >/dev/null
B_OUT="$(PSQL -t -A -c "SELECT _try_edit('$E2'::uuid, '$UA'::uuid, $REV,
  '{\"fields\":{\"title\":\"after delete\"}}'::jsonb);" | tail -1)"
PSQL <<SQL
SELECT _assert('$B_OUT' = 'TL404',
  'C-ED3/A: edit after delete is a truthful not-found');
SQL

# Order B: edit commits first, delete wins later -> nothing resurrects.
REV="$(PSQL -t -A -c "SELECT content_rev FROM recipes WHERE id = '$E1';")"
B_OUT="$(PSQL -t -A -c "SELECT _try_edit('$E1'::uuid, '$UA'::uuid, $REV,
  '{\"fields\":{\"title\":\"pre-delete edit\"}}'::jsonb);" | tail -1)"
PSQL -c "DELETE FROM recipe_steps WHERE recipe_id = '$E1';
  DELETE FROM recipe_ingredients WHERE recipe_id = '$E1';
  DELETE FROM recipes WHERE id = '$E1';" >/dev/null
C_OUT="$(PSQL -t -A -c "SELECT _try_edit('$E1'::uuid, '$UA'::uuid, $((REV + 1)),
  '{\"fields\":{\"title\":\"resurrection attempt\"}}'::jsonb);" | tail -1)"
PSQL <<SQL
SELECT _assert('$B_OUT' = 'ok', 'C-ED3/B: pre-delete edit committed');
SELECT _assert('$C_OUT' = 'TL404',
  'C-ED3/B: post-delete edit cannot resurrect');
SELECT _assert(
  (SELECT count(*) FROM recipes WHERE id = '$E1')
  + (SELECT count(*) FROM recipe_ingredients WHERE recipe_id = '$E1')
  + (SELECT count(*) FROM recipe_steps WHERE recipe_id = '$E1')
  + (SELECT count(*) FROM recipe_step_ingredients WHERE recipe_id = '$E1') = 0,
  'C-ED3/B: recipe fully gone, no orphans');
SQL

# Middle interleaving: delete arrives while an edit transaction holds the
# row lock. The delete serializes behind it; the end state converges to
# fully-deleted with no partial resurrection.
CED3="00000000-0000-4000-8000-00000000ed99"
PSQL -c "INSERT INTO recipes (id, user_id, title)
    VALUES ('$CED3', '$UA', 'Middle Race');
  INSERT INTO recipe_ingredients (recipe_id, position, name)
    VALUES ('$CED3', 1, 'mid-ing');
  INSERT INTO recipe_steps (recipe_id, position, instruction)
    VALUES ('$CED3', 1, 'mid-step');" >/dev/null
REV="$(PSQL -t -A -c "SELECT content_rev FROM recipes WHERE id = '$CED3';")"
PSQL <<SQL &
BEGIN;
SELECT update_recipe_content('$CED3'::uuid, '$UA'::uuid, $REV,
  gen_random_uuid(), '{"fields":{"title":"mid edit"}}'::jsonb,
  NULL, '[]'::jsonb);
SELECT pg_sleep(4);
COMMIT;
SQL
A_PID=$!
sleep 1
PSQL -c "DELETE FROM recipe_steps WHERE recipe_id = '$CED3';
  DELETE FROM recipe_ingredients WHERE recipe_id = '$CED3';
  DELETE FROM recipes WHERE id = '$CED3';" >/dev/null
wait "$A_PID"
PSQL <<SQL
SELECT _assert(
  (SELECT count(*) FROM recipes WHERE id = '$CED3')
  + (SELECT count(*) FROM recipe_ingredients WHERE recipe_id = '$CED3')
  + (SELECT count(*) FROM recipe_steps WHERE recipe_id = '$CED3')
  + (SELECT count(*) FROM recipe_step_ingredients WHERE recipe_id = '$CED3') = 0,
  'C-ED3/middle: converged to fully deleted, no partial resurrection');
SQL

echo ""
echo "== ALL REAL-POSTGRESQL PROOF BATTERIES PASSED =="
