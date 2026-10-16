-- tests/db/proof_migration_026.sql
-- Real-PostgreSQL proof battery for migration 026 (Issue 1).
-- Runs AFTER base schema + migrations 003..025 + seed_pre026.sql +
-- migration 026 have been applied. Single-session batteries; the two
-- genuinely concurrent cases live in run_db_proof.sh.
--
-- Every check either raises (via _assert / _expect_err) or passes
-- silently; the driver treats any error as failure of the whole proof.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION _assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF cond IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'ASSERT FAILED: %', msg;
    END IF;
END;
$$;

-- Executes sql expecting SQLSTATE want_state; any mutation the statement
-- performed before failing is rolled back to the block's savepoint --
-- which is itself part of what the battery verifies afterwards.
CREATE OR REPLACE FUNCTION _expect_err(sql text, want_state text, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE sql;
        RAISE EXCEPTION 'ASSERT FAILED (no error raised): %', msg;
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM LIKE 'ASSERT FAILED%' THEN
                RAISE;
            END IF;
            IF SQLSTATE IS DISTINCT FROM want_state THEN
                RAISE EXCEPTION
                    'ASSERT FAILED (wanted % got % / %): %',
                    want_state, SQLSTATE, SQLERRM, msg;
            END IF;
    END;
END;
$$;

\echo '=== S0: environment sanity ==='
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SELECT _assert(auth.uid() = '00000000-0000-4000-8000-00000000000a', 'auth.uid() round-trip');
SELECT _assert(
    (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) = 3,
    'supabase roles present');

\echo '=== S1: migration effects + legacy data survival ==='
SELECT _assert(
    (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'recipe_steps' AND column_name = 'ingredient_mapping_version') = 1,
    'recipe_steps.ingredient_mapping_version exists');
SELECT _assert(
    (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'recipes'
       AND column_name IN ('step_mapping_outcome','source_riff_message_id')) = 2,
    'recipes mapping columns exist');
SELECT _assert(
    (SELECT count(*) FROM pg_constraint
     WHERE conname IN ('recipe_steps_id_recipe_unique','recipe_ingredients_id_recipe_unique')) = 2,
    'composite UNIQUE(id, recipe_id) pairs exist');
SELECT _assert(
    (SELECT count(*) FROM pg_constraint
     WHERE conrelid = 'recipe_step_ingredients'::regclass AND contype = 'f') = 3,
    'association table has 3 FKs (recipes + 2 composite)');
-- MEDIUM 5: the idempotency identity must NOT be a foreign key.
SELECT _assert(
    (SELECT count(*) FROM pg_constraint
     WHERE conrelid = 'recipes'::regclass AND contype = 'f'
       AND conkey = (SELECT ARRAY[attnum] FROM pg_attribute
                     WHERE attrelid = 'recipes'::regclass
                       AND attname = 'source_riff_message_id')) = 0,
    'source_riff_message_id carries no FK (durable identity)');
-- Pre-existing production-shaped rows survived with honest legacy state.
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND ingredient_mapping_version IS NULL) = 3,
    'legacy steps all version NULL after migration');
SELECT _assert(
    (SELECT step_mapping_outcome IS NULL AND source_riff_message_id IS NULL
     FROM recipes WHERE id = '00000000-0000-4000-8000-0000000000a1'),
    'legacy recipe outcome/source NULL after migration');

\echo '=== S2: composite same-recipe integrity ==='
-- A step of recipe A cannot map to an ingredient of recipe B.
SELECT _expect_err(
    $q$INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id)
       VALUES ('00000000-0000-4000-8000-0000000000a1',
               '00000000-0000-4000-8000-0000000000a2',
               '00000000-0000-4000-8000-0000000000f4')$q$,
    '23503', 'cross-recipe association rejected by composite FK');
-- Nor by lying about the recipe_id.
SELECT _expect_err(
    $q$INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id)
       VALUES ('00000000-0000-4000-8000-0000000000b1',
               '00000000-0000-4000-8000-0000000000a2',
               '00000000-0000-4000-8000-0000000000f4')$q$,
    '23503', 'cross-recipe association rejected even with foreign recipe_id');
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients) = 0,
    'no associations leaked from rejected inserts');

\echo '=== S3: attach RPC validation (service_role) ==='
SET ROLE service_role;
-- Valid full attach.
SELECT _assert(
    (SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[]},
          {"step_position":2,"ingredient_positions":[1,2]},
          {"step_position":3,"ingredient_positions":[3]}]'::jsonb
     ) ->> 'steps_mapped') = '3',
    'valid full attach maps 3 steps');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND ingredient_mapping_version = 1) = 3,
    'all steps promoted to version 1');
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE step_id = '00000000-0000-4000-8000-0000000000a2') = 0,
    'authoritative-empty step has zero rows');
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE step_id = '00000000-0000-4000-8000-0000000000a3') = 2,
    'step 2 carries both ingredients');
-- Idempotent retry.
SELECT _assert(
    (SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[]},
          {"step_position":2,"ingredient_positions":[1,2]},
          {"step_position":3,"ingredient_positions":[3]}]'::jsonb
     ) ->> 'steps_mapped') = '3',
    'identical retry is idempotent');
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1') = 3,
    'retry did not duplicate associations');
-- Replacement is a replacement, not a union.
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-0000000000a1',
    '[{"step_position":2,"ingredient_positions":[1]}]'::jsonb);
SELECT _assert(
    (SELECT array_agg(ingredient_id::text ORDER BY ingredient_id)
     FROM recipe_step_ingredients
     WHERE step_id = '00000000-0000-4000-8000-0000000000a3')
    = ARRAY['00000000-0000-4000-8000-0000000000f1'],
    'replacement leaves exactly the new set');
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a3') = 1,
    'replaced step ends authoritative (trigger demotion overwritten in-txn)');
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a4') = 1,
    'partial attach left untouched step authoritative');

-- Malformed payloads: every case must raise 22023 AND leave the
-- established state (step2 -> [f1]) byte-identical.
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1}]'::jsonb)$q$,
    '22023', 'HIGH-1 case: missing ingredient_positions key rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'missing step_position key rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":null}]'::jsonb)$q$,
    '22023', 'JSON null ingredient_positions rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[1]'::jsonb)$q$,
    '22023', 'non-object entry rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":"2","ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'string step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1.5,"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'non-integral step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":true,"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'boolean step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":0,"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'zero step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":-1,"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'negative step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":99,"ingredient_positions":[1]}]'::jsonb)$q$,
    '22023', 'out-of-range step_position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":1}]'::jsonb)$q$,
    '22023', 'non-array ingredient_positions rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":["2"]}]'::jsonb)$q$,
    '22023', 'string ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[1.5]}]'::jsonb)$q$,
    '22023', 'non-integral ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[true]}]'::jsonb)$q$,
    '22023', 'boolean ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[0]}]'::jsonb)$q$,
    '22023', 'zero ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[-1]}]'::jsonb)$q$,
    '22023', 'negative ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[99]}]'::jsonb)$q$,
    '22023', 'out-of-range ingredient position rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[1,99]}]'::jsonb)$q$,
    '22023', '[valid, invalid] rejects whole mapping, never sanitized');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":1,"ingredient_positions":[1]},
          {"step_position":1,"ingredient_positions":[2]}]'::jsonb)$q$,
    '22023', 'duplicate step entries rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '{"step_position":1}'::jsonb)$q$,
    '22023', 'non-array payload rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        NULL::jsonb)$q$,
    '22023', 'NULL payload rejected');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000ff',
        '[]'::jsonb)$q$,
    '22023', 'unknown recipe rejected');
-- Mixed valid + invalid ENTRIES: nothing mutates (validate-before-mutate).
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping('00000000-0000-4000-8000-0000000000a1',
        '[{"step_position":2,"ingredient_positions":[2]},
          {"step_position":3,"ingredient_positions":[99]}]'::jsonb)$q$,
    '22023', 'valid entry + invalid entry rejects the whole attach');
SELECT _assert(
    (SELECT array_agg(ingredient_id::text ORDER BY ingredient_id)
     FROM recipe_step_ingredients
     WHERE step_id = '00000000-0000-4000-8000-0000000000a3')
    = ARRAY['00000000-0000-4000-8000-0000000000f1'],
    'failed attaches left prior association state untouched');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND ingredient_mapping_version = 1) = 3,
    'failed attaches left prior versions untouched');
RESET ROLE;

\echo '=== S4: mapping version CHECK constraint ==='
SELECT _expect_err(
    $q$UPDATE recipe_steps SET ingredient_mapping_version = 2
       WHERE id = '00000000-0000-4000-8000-0000000000a2'$q$,
    '23514', 'undefined mapping version 2 rejected');
SELECT _expect_err(
    $q$UPDATE recipe_steps SET ingredient_mapping_version = 0
       WHERE id = '00000000-0000-4000-8000-0000000000a2'$q$,
    '23514', 'undefined mapping version 0 rejected');

\echo '=== S5: invalidation triggers ==='
-- Association delete demotes that step.
DELETE FROM recipe_step_ingredients
WHERE step_id = '00000000-0000-4000-8000-0000000000a3';
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a3') IS NULL,
    'association delete demoted the step');
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a4') = 1,
    'unrelated step untouched by association delete');
-- Ingredient cascade delete demotes only the affected step.
SET ROLE service_role;
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-0000000000a1',
    '[{"step_position":2,"ingredient_positions":[1,2]},
      {"step_position":3,"ingredient_positions":[3]}]'::jsonb);
RESET ROLE;
DELETE FROM recipe_ingredients WHERE id = '00000000-0000-4000-8000-0000000000f2';
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a3') IS NULL,
    'ingredient cascade delete demoted the referencing step');
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE ingredient_id = '00000000-0000-4000-8000-0000000000f2') = 0,
    'cascade removed the association rows');
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000a4') = 1,
    'non-referencing step keeps authority after ingredient delete');
-- Later ingredient insert demotes every mapped step of THAT recipe only.
SET ROLE service_role;
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-0000000000b1',
    '[{"step_position":1,"ingredient_positions":[1,2]}]'::jsonb);
RESET ROLE;
INSERT INTO recipe_ingredients (recipe_id, position, name)
VALUES ('00000000-0000-4000-8000-0000000000a1', 4, 'vanilla');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND ingredient_mapping_version IS NOT NULL) = 0,
    'ingredient insert demoted every step of its recipe');
SELECT _assert(
    (SELECT ingredient_mapping_version FROM recipe_steps
     WHERE id = '00000000-0000-4000-8000-0000000000b2') = 1,
    'other recipe untouched by foreign ingredient insert');
-- Multi-row delete in one statement demotes every affected step.
SET ROLE service_role;
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-0000000000a1',
    '[{"step_position":2,"ingredient_positions":[1]},
      {"step_position":3,"ingredient_positions":[2]}]'::jsonb);
RESET ROLE;
DELETE FROM recipe_ingredients
WHERE id IN ('00000000-0000-4000-8000-0000000000f1',
             '00000000-0000-4000-8000-0000000000f3');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND ingredient_mapping_version IS NOT NULL) = 0,
    'multi-row ingredient delete demoted every affected step');
-- Whole-recipe delete cascades cleanly (trigger tolerates missing steps).
DELETE FROM recipes WHERE id = '00000000-0000-4000-8000-0000000000b1';
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000b1') = 0,
    'recipe delete cascaded association rows');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000b1') = 0,
    'recipe delete cascaded steps');

\echo '=== S6: save_riff_recipe_atomic (authenticated) ==='
SET ROLE authenticated;
-- Happy path (user A, session S1, message M1).
SELECT _assert(
    (SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-0000000000e1',
        'Honey Version') ->> 'status') = 'created',
    'riff save creates');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e1'
       AND step_mapping_outcome = 'pending'
       AND parent_recipe_id = '00000000-0000-4000-8000-0000000000a1'
       AND riff_session_id = '00000000-0000-4000-8000-0000000000c1'
       AND riff_label = 'Honey Version') = 1,
    'saved riff recipe carries identity + pending outcome + lineage');
SELECT _assert(
    (SELECT count(*) FROM recipe_ingredients ri
     JOIN recipes r ON r.id = ri.recipe_id
     WHERE r.source_riff_message_id = '00000000-0000-4000-8000-0000000000e1') = 2,
    'riff save inserted both ingredients');
SELECT _assert(
    (SELECT count(*) FROM recipe_steps s
     JOIN recipes r ON r.id = s.recipe_id
     WHERE r.source_riff_message_id = '00000000-0000-4000-8000-0000000000e1'
       AND s.ingredient_mapping_version IS NULL) = 2,
    'riff save inserted both steps, unpromoted');
-- Retry with the same durable identity (timeout-retry equivalent).
SELECT _assert(
    (SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-0000000000e1',
        NULL) ->> 'status') = 'already_saved',
    'retry resolves to already_saved');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e1') = 1,
    'retry created no duplicate');
-- Validation failures.
SELECT _expect_err(
    $q$SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-0000000000ee', NULL)$q$,
    'P0002', 'unknown message rejected');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claims', '', false);
SELECT _expect_err(
    $q$SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-0000000000e1', NULL)$q$,
    'P0003', 'unauthenticated caller rejected');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);

\echo '=== S6b: MEDIUM 5 -- durable identity survives source deletion ==='
SET ROLE authenticated;
-- User A deletes the riff session (policy allows); messages cascade away.
DELETE FROM riff_sessions WHERE id = '00000000-0000-4000-8000-0000000000c1';
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM riff_messages
     WHERE id = '00000000-0000-4000-8000-0000000000e1') = 0,
    'session delete cascaded the message');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e1') = 1,
    'saved recipe RETAINS the consumed identity after message deletion');
-- The consumed UUID cannot mint a second recipe even if reintroduced.
INSERT INTO riff_sessions (id, user_id, source_recipe_id)
VALUES ('00000000-0000-4000-8000-0000000000c9',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000a1');
INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000c9',
        'assistant', 'Reintroduced.',
        '{"title":"Dup Attempt","servings":null,"prep_time":null,"cook_time":null,
          "confidence":1.0,
          "ingredients":[{"quantity":null,"unit":null,"name":"x","prep":null}],
          "steps":[{"position":1,"instruction":"y"}]}'::jsonb);
SET ROLE authenticated;
SELECT _assert(
    (SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c9',
        '00000000-0000-4000-8000-0000000000e1', NULL) ->> 'status')
    = 'already_saved',
    'reintroduced UUID resolves to already_saved, never a second recipe');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e1') = 1,
    'exactly one recipe holds the identity');
RESET ROLE;

\echo '=== S6c: MEDIUM 6 -- cross-user source recipe rejected in-DB ==='
-- Simulate the weak session-insert path: user B session anchored to
-- user A's recipe (inserted as superuser to bypass the route checks).
INSERT INTO riff_sessions (id, user_id, source_recipe_id)
VALUES ('00000000-0000-4000-8000-0000000000c3',
        '00000000-0000-4000-8000-00000000000b',
        '00000000-0000-4000-8000-0000000000a1');
INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-0000000000e3',
        '00000000-0000-4000-8000-0000000000c3',
        'assistant', 'Cross-user attempt.',
        '{"title":"Stolen Lineage","servings":null,"prep_time":null,"cook_time":null,
          "confidence":1.0,
          "ingredients":[{"quantity":null,"unit":null,"name":"x","prep":null}],
          "steps":[{"position":1,"instruction":"y"}]}'::jsonb);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _expect_err(
    $q$SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c3',
        '00000000-0000-4000-8000-0000000000e3', NULL)$q$,
    'P0002', 'cross-user source recipe rejected inside the RPC');
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e3') = 0,
    'no cross-user lineage recipe was created');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);

\echo '=== S7: save_draft_riff_recipe (authenticated) ==='
SET ROLE authenticated;
SELECT _assert(
    (SELECT save_draft_riff_recipe(
        '00000000-0000-4000-8000-0000000000d2',
        '00000000-0000-4000-8000-0000000000c2',
        '00000000-0000-4000-8000-0000000000e2',
        'Toasted') ->> 'status') = 'created',
    'draft riff save creates');
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM recipe_drafts
     WHERE id = '00000000-0000-4000-8000-0000000000d2') = 0,
    'draft deleted by successful save');
SELECT _assert(
    (SELECT source_draft_id IS NULL AND source_recipe_id IS NOT NULL
     FROM riff_sessions WHERE id = '00000000-0000-4000-8000-0000000000c2'),
    'session anchor migrated draft -> recipe');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e2'
       AND step_mapping_outcome = 'pending'
       AND riff_session_id = '00000000-0000-4000-8000-0000000000c2') = 1,
    'draft riff recipe stamped with identity + pending');
-- Post-commit retry: the draft is genuinely gone.
SET ROLE authenticated;
SELECT _assert(
    (SELECT save_draft_riff_recipe(
        '00000000-0000-4000-8000-0000000000d2',
        '00000000-0000-4000-8000-0000000000c2',
        '00000000-0000-4000-8000-0000000000e2',
        NULL) ->> 'status') = 'already_migrated',
    'post-commit retry with draft gone resolves already_migrated');
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE source_riff_message_id = '00000000-0000-4000-8000-0000000000e2') = 1,
    'draft riff retry created no duplicate');

\echo '=== S8: confirm_recipe_draft re-issue (parity + mapping stamp) ==='
SET ROLE authenticated;
-- Legacy draft D1: outcome must stay NULL; response contract preserved.
CREATE TEMP TABLE _confirm_result AS
SELECT confirm_recipe_draft('00000000-0000-4000-8000-0000000000d1') AS r;
SELECT _assert(
    (SELECT (SELECT array_agg(k ORDER BY k)
             FROM jsonb_object_keys(r) k) FROM _confirm_result)
    = ARRAY['committed_at','draft_id','ingredient_count','recipe_id','step_count','title'],
    'MEDIUM-2 parity: response keys match migration 014 exactly');
SELECT _assert(
    (SELECT (r->>'ingredient_count')::int = 1
        AND (r->>'step_count')::int = 1
        AND r->>'title' = 'Legacy Draft'
        AND (r->>'draft_id') = '00000000-0000-4000-8000-0000000000d1'
        AND (r->>'committed_at') IS NOT NULL
     FROM _confirm_result),
    'confirm response values correct');
RESET ROLE;
SELECT _assert(
    (SELECT step_mapping_outcome IS NULL FROM recipes
     WHERE id = (SELECT (r->>'recipe_id')::uuid FROM _confirm_result)),
    'legacy draft confirms with outcome NULL (never crash-degraded)');
SELECT _assert(
    (SELECT count(*) FROM recipe_drafts
     WHERE id = '00000000-0000-4000-8000-0000000000d1') = 0,
    'confirm deleted the draft');
-- Mapping-aware draft confirms as pending.
INSERT INTO recipe_drafts
    (id, user_id, image_storage_keys, title, confidence_score,
     ingredients, steps, raw_model_json, model_version, parser_version)
VALUES (
    '00000000-0000-4000-8000-0000000000d3',
    '00000000-0000-4000-8000-00000000000a',
    '["k3.jpg"]'::jsonb, 'Mapped Confirm', 0.9,
    '[{"quantity":null,"unit":null,"name":"rice","prep":null,"raw_text":"rice"}]'::jsonb,
    '[{"position":1,"instruction":"Cook"}]'::jsonb,
    '{"title":"Mapped Confirm","step_ingredient_positions":[[1]]}'::jsonb,
    'test-model', '1.1');
SET ROLE authenticated;
CREATE TEMP TABLE _confirm_result_d3 AS
SELECT confirm_recipe_draft('00000000-0000-4000-8000-0000000000d3') AS r;
SELECT _assert(
    (SELECT step_mapping_outcome FROM recipes
     WHERE id = (SELECT (r->>'recipe_id')::uuid FROM _confirm_result_d3))
    = 'pending',
    'mapping-aware draft confirms as pending');
RESET ROLE;

\echo '=== S9: grants + RLS ==='
-- attach is service-role only.
SET ROLE authenticated;
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-0000000000a1', '[]'::jsonb)$q$,
    '42501', 'authenticated cannot execute attach');
RESET ROLE;
SET ROLE anon;
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-0000000000a1', '[]'::jsonb)$q$,
    '42501', 'anon cannot execute attach');
SELECT _expect_err(
    $q$SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-0000000000e1', NULL)$q$,
    '42501', 'anon cannot execute save_riff_recipe_atomic');
SELECT _expect_err(
    $q$SELECT save_draft_riff_recipe(
        '00000000-0000-4000-8000-0000000000d2',
        '00000000-0000-4000-8000-0000000000c2',
        '00000000-0000-4000-8000-0000000000e2', NULL)$q$,
    '42501', 'anon cannot execute save_draft_riff_recipe');
RESET ROLE;
-- Association-table RLS: owner reads, stranger sees nothing, nobody
-- writes directly.
SET ROLE service_role;
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-0000000000a1',
    '[{"step_position":2,"ingredient_positions":[1]}]'::jsonb);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1') >= 1,
    'owner can read own association rows');
SELECT _expect_err(
    $q$INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id)
       SELECT recipe_id, step_id, ingredient_id
       FROM recipe_step_ingredients LIMIT 1$q$,
    '42501', 'no direct INSERT policy on association table');
-- No DELETE policy: this statement must affect zero rows.
DELETE FROM recipe_step_ingredients;
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients
     WHERE recipe_id = '00000000-0000-4000-8000-0000000000a1') >= 1,
    'no direct DELETE reached association rows');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _assert(
    (SELECT count(*) FROM recipe_step_ingredients) = 0,
    'stranger sees zero association rows');
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE id = '00000000-0000-4000-8000-0000000000a1') = 0,
    'stranger sees zero foreign recipes');
RESET ROLE;

\echo '=== PROOF BATTERIES PASSED ==='
