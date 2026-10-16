-- tests/db/proof_migration_027.sql
-- Real-PostgreSQL proof battery for migration 027 (Issue 3).
-- Runs AFTER the 026 proof, the privilege bypass seeds (planted by the
-- driver BEFORE 027), and migration 027 itself. Single-session batteries
-- U0..U18; the concurrent batteries C-ED1..C-ED3 live in run_db_proof.sh.
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

-- Convenience wrapper: call update_recipe_content at the CURRENT rev.
CREATE OR REPLACE FUNCTION _edit(
    p_recipe uuid, p_user uuid, p_ops jsonb,
    p_mappings jsonb DEFAULT NULL,
    p_scope jsonb DEFAULT '[]'::jsonb,
    p_mutation uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_rev int;
BEGIN
    SELECT content_rev INTO v_rev FROM recipes WHERE id = p_recipe;
    RETURN update_recipe_content(
        p_recipe, p_user, v_rev,
        COALESCE(p_mutation, gen_random_uuid()),
        p_ops, p_mappings, p_scope);
END;
$$;

-- Fixed UUIDs for the Issue 3 batteries.
--   user A            00000000-0000-4000-8000-00000000000a
--   user B            00000000-0000-4000-8000-00000000000b
--   edit recipe E1    00000000-0000-4000-8000-00000000ed01
--     EI1 (legacy)    00000000-0000-4000-8000-00000000ed11
--     EI2             00000000-0000-4000-8000-00000000ed12
--     EI3 (no refs)   00000000-0000-4000-8000-00000000ed13
--     ES1..ES3        00000000-0000-4000-8000-00000000ed21..23
--   membership E2     00000000-0000-4000-8000-00000000ed02
--     MI1, MI2        00000000-0000-4000-8000-00000000ed31..32
--     MS1, MS2        00000000-0000-4000-8000-00000000ed41..42

\echo '=== U-fixtures: edit-target recipes (post-027 creation) ==='
INSERT INTO recipes (id, user_id, title, servings, prep_time, cook_time,
                     confidence_score, source_url, step_mapping_outcome)
VALUES
    ('00000000-0000-4000-8000-00000000ed01',
     '00000000-0000-4000-8000-00000000000a',
     'Edit Target', '4', '10 min', '20 min', 0.9,
     'https://proof.local/e1', 'complete'),
    ('00000000-0000-4000-8000-00000000ed02',
     '00000000-0000-4000-8000-00000000000a',
     'Membership Target', '2', NULL, NULL, 0.9, NULL, 'complete');

INSERT INTO recipe_ingredients (id, recipe_id, position, quantity, unit, name, prep, raw_text)
VALUES
    ('00000000-0000-4000-8000-00000000ed11',
     '00000000-0000-4000-8000-00000000ed01', 1, '2', 'cups', 'flour', 'sifted',
     '2 cups flour, sifted'),
    ('00000000-0000-4000-8000-00000000ed12',
     '00000000-0000-4000-8000-00000000ed01', 2, NULL, NULL, 'salt', NULL, NULL),
    ('00000000-0000-4000-8000-00000000ed13',
     '00000000-0000-4000-8000-00000000ed01', 3, NULL, NULL, 'pepper', NULL, NULL),
    ('00000000-0000-4000-8000-00000000ed31',
     '00000000-0000-4000-8000-00000000ed02', 1, '1', 'cup', 'rice', NULL, '1 cup rice'),
    ('00000000-0000-4000-8000-00000000ed32',
     '00000000-0000-4000-8000-00000000ed02', 2, NULL, NULL, 'peas', NULL, NULL);

INSERT INTO recipe_steps (id, recipe_id, position, instruction)
VALUES
    ('00000000-0000-4000-8000-00000000ed21',
     '00000000-0000-4000-8000-00000000ed01', 1, 'Mix flour and salt.'),
    ('00000000-0000-4000-8000-00000000ed22',
     '00000000-0000-4000-8000-00000000ed01', 2, 'Rest the dough.'),
    ('00000000-0000-4000-8000-00000000ed23',
     '00000000-0000-4000-8000-00000000ed01', 3, 'Serve.'),
    ('00000000-0000-4000-8000-00000000ed41',
     '00000000-0000-4000-8000-00000000ed02', 1, 'Boil the rice.'),
    ('00000000-0000-4000-8000-00000000ed42',
     '00000000-0000-4000-8000-00000000ed02', 2, 'Add the peas.');

-- Promote initial authority via the NEW 3-arg attach (rev 1).
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-00000000ed01', 1,
    '[{"step_position":1,"ingredient_positions":[1,2]},
      {"step_position":2,"ingredient_positions":[]},
      {"step_position":3,"ingredient_positions":[]}]'::jsonb);
SELECT attach_step_ingredient_mapping(
    '00000000-0000-4000-8000-00000000ed02', 1,
    '[{"step_position":1,"ingredient_positions":[1]},
      {"step_position":2,"ingredient_positions":[2]}]'::jsonb);

\echo '=== U0a: effective table privileges (anon / authenticated / PUBLIC) ==='
DO $$
DECLARE
    v_table TEXT;
    v_priv TEXT;
    v_role TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'recipes', 'recipe_ingredients', 'recipe_steps',
        'recipe_step_ingredients']
    LOOP
        FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE']
        LOOP
            FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
            LOOP
                PERFORM _assert(
                    NOT has_table_privilege(v_role, v_table, v_priv),
                    format('U0a: %s must not hold %s on %s',
                           v_role, v_priv, v_table));
            END LOOP;
        END LOOP;
        -- service_role keeps full DML.
        PERFORM _assert(
            has_table_privilege('service_role', v_table, 'INSERT')
            AND has_table_privilege('service_role', v_table, 'UPDATE')
            AND has_table_privilege('service_role', v_table, 'DELETE'),
            format('U0a: service_role keeps DML on %s', v_table));
    END LOOP;
    -- SELECT preserved for the riff.py visibility check.
    PERFORM _assert(
        has_table_privilege('authenticated', 'recipes', 'SELECT'),
        'U0a: authenticated SELECT on recipes preserved');
END;
$$;

\echo '=== U0b: seeded bypass grants are proven revoked ==='
-- The driver planted, BEFORE 027:
--   GRANT INSERT ON recipes TO PUBLIC;
--   GRANT UPDATE (title) ON recipes TO authenticated;   (column grant)
--   GRANT DELETE ON recipe_steps TO anon;
DO $$
DECLARE
    v_col TEXT;
    v_table TEXT;
BEGIN
    PERFORM _assert(
        NOT has_table_privilege('anon', 'recipes', 'INSERT'),
        'U0b: PUBLIC INSERT seed no longer reaches anon');
    PERFORM _assert(
        NOT has_table_privilege('authenticated', 'recipes', 'INSERT'),
        'U0b: PUBLIC INSERT seed no longer reaches authenticated');
    PERFORM _assert(
        NOT has_column_privilege('authenticated', 'recipes', 'title', 'UPDATE'),
        'U0b: column-level UPDATE(title) seed revoked');
    PERFORM _assert(
        NOT has_table_privilege('anon', 'recipe_steps', 'DELETE'),
        'U0b: anon DELETE seed revoked');
    -- No column-level write privilege survives anywhere on the 4 tables.
    FOREACH v_table IN ARRAY ARRAY[
        'recipes', 'recipe_ingredients', 'recipe_steps',
        'recipe_step_ingredients']
    LOOP
        FOR v_col IN
            SELECT attname FROM pg_attribute
            WHERE attrelid = v_table::regclass
              AND attnum > 0 AND NOT attisdropped
        LOOP
            PERFORM _assert(
                NOT has_column_privilege('anon', v_table, v_col, 'INSERT')
                AND NOT has_column_privilege('anon', v_table, v_col, 'UPDATE')
                AND NOT has_column_privilege(
                        'authenticated', v_table, v_col, 'INSERT')
                AND NOT has_column_privilege(
                        'authenticated', v_table, v_col, 'UPDATE'),
                format('U0b: no column write privilege on %s.%s',
                       v_table, v_col));
        END LOOP;
    END LOOP;
END;
$$;

\echo '=== U0c: attempted DML is denied under both end-user roles ==='
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _expect_err(
    $q$INSERT INTO recipes (user_id, title)
       VALUES ('00000000-0000-4000-8000-00000000000a', 'smuggled')$q$,
    '42501', 'U0c: authenticated INSERT recipes denied');
SELECT _expect_err(
    $q$UPDATE recipes SET title = 'hacked'
       WHERE id = '00000000-0000-4000-8000-00000000ed01'$q$,
    '42501', 'U0c: authenticated UPDATE recipes denied (rev bypass closed)');
SELECT _expect_err(
    $q$DELETE FROM recipe_ingredients
       WHERE id = '00000000-0000-4000-8000-00000000ed11'$q$,
    '42501', 'U0c: authenticated DELETE recipe_ingredients denied');
SELECT _expect_err(
    $q$UPDATE recipe_steps SET ingredient_mapping_version = 1
       WHERE id = '00000000-0000-4000-8000-00000000ed21'$q$,
    '42501', 'U0c: authenticated UPDATE recipe_steps denied (authority bypass closed)');
SELECT _expect_err(
    $q$INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id)
       VALUES ('00000000-0000-4000-8000-00000000ed01',
               '00000000-0000-4000-8000-00000000ed21',
               '00000000-0000-4000-8000-00000000ed11')$q$,
    '42501', 'U0c: authenticated INSERT associations denied');
-- Authenticated SELECT (the riff.py visibility check) still works.
SELECT _assert(
    (SELECT count(*) FROM recipes
     WHERE id = '00000000-0000-4000-8000-00000000ed01') = 1,
    'U0c: authenticated SELECT own recipe still works');
RESET ROLE;
SET ROLE anon;
SELECT _expect_err(
    $q$INSERT INTO recipes (user_id, title)
       VALUES ('00000000-0000-4000-8000-00000000000a', 'anon-smuggled')$q$,
    '42501', 'U0c: anon INSERT recipes denied');
SELECT _expect_err(
    $q$UPDATE recipe_ingredients SET name = 'x'$q$,
    '42501', 'U0c: anon UPDATE recipe_ingredients denied');
SELECT _expect_err(
    $q$DELETE FROM recipe_steps$q$,
    '42501', 'U0c: anon DELETE recipe_steps denied');
RESET ROLE;

-- The COMPLETE attempted-DML matrix: both end-user roles x all four
-- content tables x INSERT/UPDATE/DELETE. Privilege checks fire before
-- constraint evaluation, so generic statements prove the denial.
DO $$
DECLARE
    v_role TEXT;
    v_table TEXT;
    v_col TEXT;
    v_stmt TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        EXECUTE format('SET LOCAL ROLE %I', v_role);
        FOREACH v_table IN ARRAY ARRAY[
            'recipes', 'recipe_ingredients', 'recipe_steps',
            'recipe_step_ingredients']
        LOOP
            v_col := CASE WHEN v_table = 'recipes' THEN 'id'
                          ELSE 'recipe_id' END;
            FOREACH v_stmt IN ARRAY ARRAY[
                format('INSERT INTO %I DEFAULT VALUES', v_table),
                format('UPDATE %I SET %I = %I', v_table, v_col, v_col),
                format('DELETE FROM %I WHERE false', v_table)]
            LOOP
                BEGIN
                    EXECUTE v_stmt;
                    RAISE EXCEPTION
                        'ASSERT FAILED: % as % was not denied',
                        v_stmt, v_role;
                EXCEPTION
                    WHEN insufficient_privilege THEN
                        NULL; -- the required outcome
                END;
            END LOOP;
        END LOOP;
        EXECUTE 'RESET ROLE';
    END LOOP;
END;
$$;

\echo '=== U0c2: RPC EXECUTE attempts denied for end-user roles ==='
SET ROLE anon;
SELECT _expect_err(
    $q$SELECT get_recipe_snapshot(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a')$q$,
    '42501', 'U0c2: anon cannot execute get_recipe_snapshot');
SELECT _expect_err(
    $q$SELECT update_recipe_content(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        1, gen_random_uuid(), '{"fields":{"title":"x"}}'::jsonb,
        NULL, '[]'::jsonb)$q$,
    '42501', 'U0c2: anon cannot execute update_recipe_content');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed01', 1, '[]'::jsonb)$q$,
    '42501', 'U0c2: anon cannot execute attach_step_ingredient_mapping');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _expect_err(
    $q$SELECT get_recipe_snapshot(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a')$q$,
    '42501', 'U0c2: same-owner authenticated cannot execute get_recipe_snapshot');
SELECT _expect_err(
    $q$SELECT update_recipe_content(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        1, gen_random_uuid(), '{"fields":{"title":"x"}}'::jsonb,
        NULL, '[]'::jsonb)$q$,
    '42501', 'U0c2: same-owner authenticated cannot execute update_recipe_content');
SELECT _expect_err(
    $q$SELECT attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed01', 1, '[]'::jsonb)$q$,
    '42501', 'U0c2: authenticated cannot execute attach_step_ingredient_mapping');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _expect_err(
    $q$SELECT update_recipe_content(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000b',
        1, gen_random_uuid(), '{"fields":{"title":"x"}}'::jsonb,
        NULL, '[]'::jsonb)$q$,
    '42501', 'U0c2: cross-owner authenticated cannot execute update_recipe_content');
RESET ROLE;
-- (Service-role execution succeeding is proven by every U battery below,
-- which runs the three RPCs for real under SET ROLE service_role.)

\echo '=== U0d: function ACLs (service-role-only RPC posture) ==='
DO $$
DECLARE
    v_fn TEXT;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'update_recipe_content(uuid,uuid,integer,uuid,jsonb,jsonb,jsonb)',
        'get_recipe_snapshot(uuid,uuid)',
        'attach_step_ingredient_mapping(uuid,integer,jsonb)']
    LOOP
        PERFORM _assert(
            NOT has_function_privilege('anon', v_fn, 'EXECUTE'),
            format('U0d: anon cannot EXECUTE %s', v_fn));
        PERFORM _assert(
            NOT has_function_privilege('authenticated', v_fn, 'EXECUTE'),
            format('U0d: authenticated cannot EXECUTE %s', v_fn));
        PERFORM _assert(
            has_function_privilege('service_role', v_fn, 'EXECUTE'),
            format('U0d: service_role can EXECUTE %s', v_fn));
    END LOOP;
    -- The 2-arg attach form is gone.
    PERFORM _assert(
        (SELECT count(*) FROM pg_proc
         WHERE proname = 'attach_step_ingredient_mapping') = 1,
        'U0d: exactly one attach function (3-arg) remains');
END;
$$;

\echo '=== U0e: sanctioned flows still function ==='
-- Favorite update (service-role table op).
SET ROLE service_role;
UPDATE recipes SET favorite = TRUE
WHERE id = '00000000-0000-4000-8000-00000000ed01';
UPDATE recipes SET favorite = FALSE
WHERE id = '00000000-0000-4000-8000-00000000ed01';
RESET ROLE;
-- Tags replace (authenticated SECURITY DEFINER RPC).
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT replace_recipe_tags(
    '00000000-0000-4000-8000-00000000ed01', ARRAY['weeknight']);
RESET ROLE;
SELECT _assert(
    (SELECT count(*) FROM recipe_tags
     WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01') = 1,
    'U0e: replace_recipe_tags still functions');
-- Draft confirm (authenticated SECURITY DEFINER RPC; fresh draft, the
-- 026 battery already consumed the seeded ones).
INSERT INTO recipe_drafts
    (id, user_id, image_storage_keys, title, servings, confidence_score,
     ingredients, steps, raw_model_json, model_version, parser_version)
VALUES (
    '00000000-0000-4000-8000-00000000edd1',
    '00000000-0000-4000-8000-00000000000a',
    '["ed.jpg"]'::jsonb,
    'Post-027 Draft', '2', 0.8,
    '[{"quantity":"1","unit":"cup","name":"corn","prep":null,"raw_text":"1 cup corn"}]'::jsonb,
    '[{"position":1,"instruction":"Grill the corn"}]'::jsonb,
    '{"title":"Post-027 Draft"}'::jsonb,
    'test-model', '1.0'
);
SET ROLE authenticated;
SELECT _assert(
    (SELECT confirm_recipe_draft('00000000-0000-4000-8000-00000000edd1')
        ->> 'recipe_id') IS NOT NULL,
    'U0e: confirm_recipe_draft still functions');
RESET ROLE;
-- Riff save: REAL post-027 execution as authenticated (fresh fixtures;
-- the pre-027 fixtures were consumed by the 026 battery).
INSERT INTO riff_sessions (id, user_id, source_recipe_id)
VALUES ('00000000-0000-4000-8000-00000000edc1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000ed01');
INSERT INTO riff_messages (id, session_id, role, content, generated_recipe)
VALUES ('00000000-0000-4000-8000-00000000ede1',
        '00000000-0000-4000-8000-00000000edc1',
        'assistant', 'Post-027 riff.',
        '{"title":"Post-027 Riff","servings":null,"prep_time":null,
          "cook_time":null,"confidence":1.0,
          "ingredients":[{"quantity":null,"unit":null,"name":"chili","prep":null}],
          "steps":[{"position":1,"instruction":"Add heat."}]}'::jsonb);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT _assert(
    (SELECT save_riff_recipe_atomic(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000edc1',
        '00000000-0000-4000-8000-00000000ede1',
        NULL) ->> 'status') = 'created',
    'U0e: save_riff_recipe_atomic still functions post-027');
RESET ROLE;
-- Capture-path direct DML + delete flow: REAL round trip as service_role.
SET ROLE service_role;
DO $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO recipes (user_id, title)
    VALUES ('00000000-0000-4000-8000-00000000000a', 'U0e capture probe')
    RETURNING id INTO v_id;
    INSERT INTO recipe_ingredients (recipe_id, position, name)
    VALUES (v_id, 1, 'probe-ing');
    INSERT INTO recipe_steps (recipe_id, position, instruction)
    VALUES (v_id, 1, 'probe-step');
    DELETE FROM recipe_steps WHERE recipe_id = v_id;
    DELETE FROM recipe_ingredients WHERE recipe_id = v_id;
    DELETE FROM recipes WHERE id = v_id;
    PERFORM _assert(
        (SELECT count(*) FROM recipes WHERE id = v_id) = 0,
        'U0e: service-role capture/delete round trip functions');
END;
$$;
RESET ROLE;

SET ROLE service_role;

\echo '=== U12: coherent snapshot parity + content_rev ==='
DO $$
DECLARE
    v_snap jsonb;
BEGIN
    v_snap := get_recipe_snapshot(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a');
    PERFORM _assert(v_snap IS NOT NULL, 'U12: snapshot returned');
    PERFORM _assert(
        (v_snap->'recipe'->>'content_rev')::int = 1,
        'U12: snapshot carries content_rev');
    PERFORM _assert(
        v_snap->'recipe'->>'title' = 'Edit Target',
        'U12: snapshot recipe parity');
    PERFORM _assert(
        jsonb_array_length(v_snap->'ingredients') = 3
        AND jsonb_array_length(v_snap->'steps') = 3,
        'U12: snapshot child parity');
    PERFORM _assert(
        jsonb_array_length(v_snap->'associations') = 2,
        'U12: snapshot association parity');
    PERFORM _assert(
        v_snap->'tags' = '["weeknight"]'::jsonb,
        'U12: snapshot tag parity');
    PERFORM _assert(
        v_snap->'ingredients'->0->>'name' = 'flour'
        AND v_snap->'steps'->0->>'instruction' = 'Mix flour and salt.',
        'U12: snapshot ordered by position');
    -- Ownership predicate: cross-user snapshot is empty.
    PERFORM _assert(
        get_recipe_snapshot(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000b') IS NULL,
        'U12: cross-user snapshot returns nothing');
END;
$$;

\echo '=== U1: scalar patch (rev 1 -> 2, mappings untouched) ==='
DO $$
DECLARE
    v_res jsonb;
    v_before timestamptz;
BEGIN
    SELECT updated_at INTO v_before FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"fields":{"title":"Edited Target"}}'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U1: status updated');
    PERFORM _assert((v_res->>'content_rev')::int = 2, 'U1: rev advanced to 2');
    PERFORM _assert(
        (SELECT title = 'Edited Target' AND content_rev = 2
         FROM recipes WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U1: title + rev persisted');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND ingredient_mapping_version = 1) = 3,
        'U1: mappings untouched by a scalar edit');
    PERFORM _assert(
        (SELECT updated_at >= v_before FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U1: updated_at maintained');
END;
$$;

\echo '=== U2: tri-state clear (present null clears; absent untouched) ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"fields":{"servings":null}}'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U2: status updated');
    PERFORM _assert(
        (SELECT servings IS NULL AND prep_time = '10 min'
             AND cook_time = '20 min'
         FROM recipes WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U2: servings cleared, absent keys untouched');
END;
$$;

\echo '=== U4: pure reorder (both sections): rev bumps, mappings PRESERVED ==='
DO $$
DECLARE
    v_res jsonb;
    v_assoc_before bigint;
BEGIN
    SELECT count(*) INTO v_assoc_before FROM recipe_step_ingredients
    WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01';
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{"order":["00000000-0000-4000-8000-00000000ed13",
                                  "00000000-0000-4000-8000-00000000ed11",
                                  "00000000-0000-4000-8000-00000000ed12"]},
          "steps":{"order":["00000000-0000-4000-8000-00000000ed23",
                            "00000000-0000-4000-8000-00000000ed21",
                            "00000000-0000-4000-8000-00000000ed22"]}}'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U4: status updated');
    PERFORM _assert((v_res->>'content_rev')::int = 4, 'U4: rev advanced');
    PERFORM _assert(
        (SELECT position FROM recipe_ingredients
         WHERE id = '00000000-0000-4000-8000-00000000ed13') = 1
        AND (SELECT position FROM recipe_ingredients
             WHERE id = '00000000-0000-4000-8000-00000000ed11') = 2
        AND (SELECT position FROM recipe_ingredients
             WHERE id = '00000000-0000-4000-8000-00000000ed12') = 3,
        'U4: dense ingredient positions per order array');
    PERFORM _assert(
        (SELECT position FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed23') = 1,
        'U4: dense step positions per order array');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND ingredient_mapping_version = 1) = 3,
        'U4: id-anchored mapping authority survives reorder');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_step_ingredients
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01')
            = v_assoc_before,
        'U4: association rows untouched by reorder');
    PERFORM _assert(
        (SELECT raw_text = '2 cups flour, sifted' FROM recipe_ingredients
         WHERE id = '00000000-0000-4000-8000-00000000ed11'),
        'U4: reorder never clears raw_text');
    -- Reorder back to the canonical order for the batteries below.
    PERFORM _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{"order":["00000000-0000-4000-8000-00000000ed11",
                                  "00000000-0000-4000-8000-00000000ed12",
                                  "00000000-0000-4000-8000-00000000ed13"]},
          "steps":{"order":["00000000-0000-4000-8000-00000000ed21",
                            "00000000-0000-4000-8000-00000000ed22",
                            "00000000-0000-4000-8000-00000000ed23"]}}'::jsonb);
END;
$$;

\echo '=== U3: ingredient update demotes; raw_text nulled on patched row ONLY ==='
DO $$
DECLARE
    v_field TEXT;
    v_res jsonb;
BEGIN
    -- Each semantic field individually triggers the same class of change.
    FOREACH v_field IN ARRAY ARRAY['name', 'quantity', 'unit', 'prep']
    LOOP
        -- Re-promote before each pass so demotion is observable.
        PERFORM attach_step_ingredient_mapping(
            '00000000-0000-4000-8000-00000000ed01',
            (SELECT content_rev FROM recipes
             WHERE id = '00000000-0000-4000-8000-00000000ed01'),
            '[{"step_position":1,"ingredient_positions":[1,2]},
              {"step_position":2,"ingredient_positions":[]},
              {"step_position":3,"ingredient_positions":[]}]'::jsonb);
        v_res := _edit(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            jsonb_build_object('ingredients', jsonb_build_object(
                'update', jsonb_build_array(jsonb_build_object(
                    'id', '00000000-0000-4000-8000-00000000ed12',
                    'fields', jsonb_build_object(
                        v_field, 'edited-' || v_field))))),
            NULL,                       -- soft-failed mapper
            '[1,2,3]'::jsonb);          -- whole-recipe scope
        PERFORM _assert(
            v_res->>'status' = 'updated',
            format('U3(%s): status updated', v_field));
        PERFORM _assert(
            (SELECT count(*) FROM recipe_steps
             WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
               AND ingredient_mapping_version IS NOT NULL) = 0,
            format('U3(%s): whole recipe demoted on null mappings', v_field));
        PERFORM _assert(
            (SELECT count(*) FROM recipe_step_ingredients
             WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01') = 0,
            format('U3(%s): scope associations deleted', v_field));
        PERFORM _assert(
            (SELECT step_mapping_outcome = 'degraded' FROM recipes
             WHERE id = '00000000-0000-4000-8000-00000000ed01'),
            format('U3(%s): outcome recorded degraded', v_field));
        -- The patched row lost raw_text (it had none); the LEGACY sibling
        -- kept its raw_text byte-identically.
        PERFORM _assert(
            (SELECT raw_text = '2 cups flour, sifted' FROM recipe_ingredients
             WHERE id = '00000000-0000-4000-8000-00000000ed11'),
            format('U3(%s): untouched legacy row keeps raw_text', v_field));
    END LOOP;
    -- A semantic patch on the legacy row itself clears its raw_text.
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{"update":[{"id":"00000000-0000-4000-8000-00000000ed11",
            "fields":{"quantity":"3"}}]}}'::jsonb,
        NULL, '[1,2,3]'::jsonb);
    PERFORM _assert(
        (SELECT raw_text IS NULL AND quantity = '3' FROM recipe_ingredients
         WHERE id = '00000000-0000-4000-8000-00000000ed11'),
        'U3: intentional edit to the legacy row clears its raw_text');
END;
$$;

\echo '=== U3b: sibling edit + reorder leaves untouched legacy row byte-identical ==='
DO $$
DECLARE
    v_legacy_before jsonb;
    v_legacy_after jsonb;
BEGIN
    -- Recreate a legacy raw_text state on EI13 (service-role write, as a
    -- pre-Issue-3 capture would have stored it).
    UPDATE recipe_ingredients
    SET quantity = '1', unit = 'tsp', name = 'pepper', prep = 'ground',
        raw_text = '1 tsp pepper, freshly ground'
    WHERE id = '00000000-0000-4000-8000-00000000ed13';
    SELECT to_jsonb(ri) - 'position' INTO v_legacy_before
    FROM recipe_ingredients ri
    WHERE id = '00000000-0000-4000-8000-00000000ed13';

    -- Sibling edit (EI12) + full-section reorder; EI13 appears ONLY in
    -- the order array.
    PERFORM _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{
            "update":[{"id":"00000000-0000-4000-8000-00000000ed12",
                       "fields":{"name":"sea salt"}}],
            "order":["00000000-0000-4000-8000-00000000ed13",
                     "00000000-0000-4000-8000-00000000ed12",
                     "00000000-0000-4000-8000-00000000ed11"]}}'::jsonb,
        NULL, '[1,2,3]'::jsonb);

    SELECT to_jsonb(ri) - 'position' INTO v_legacy_after
    FROM recipe_ingredients ri
    WHERE id = '00000000-0000-4000-8000-00000000ed13';
    PERFORM _assert(
        v_legacy_before = v_legacy_after,
        'U3b: legacy row byte-identical (raw_text intact) after sibling edit + reorder');
    PERFORM _assert(
        (SELECT name = 'sea salt' FROM recipe_ingredients
         WHERE id = '00000000-0000-4000-8000-00000000ed12'),
        'U3b: sibling edit applied');
    PERFORM _assert(
        (SELECT position FROM recipe_ingredients
         WHERE id = '00000000-0000-4000-8000-00000000ed13') = 1,
        'U3b: reorder applied');
END;
$$;

\echo '=== U7: step update invalidates that step; authoritative-[] preserved ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    PERFORM attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed01',
        (SELECT content_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        '[{"step_position":1,"ingredient_positions":[1,2]},
          {"step_position":2,"ingredient_positions":[]},
          {"step_position":3,"ingredient_positions":[]}]'::jsonb);
    -- Edit step ES2 (position 2); promote it back with the fresh result
    -- (authoritative empty); steps 1 and 3 are OUT of scope: untouched.
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"steps":{"update":[{"id":"00000000-0000-4000-8000-00000000ed22",
            "fields":{"instruction":"Rest the dough 30 minutes."}}]}}'::jsonb,
        '[{"step_position":2,"ingredient_positions":[]}]'::jsonb,
        '[2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U7: status updated');
    PERFORM _assert(
        (SELECT instruction = 'Rest the dough 30 minutes.' FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed22'),
        'U7: instruction persisted');
    PERFORM _assert(
        (SELECT ingredient_mapping_version = 1 FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed22'),
        'U7: fresh authoritative-empty promoted for the edited step');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_step_ingredients
         WHERE step_id = '00000000-0000-4000-8000-00000000ed22') = 0,
        'U7: authoritative empty = zero association rows');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND ingredient_mapping_version = 1) = 3,
        'U7: out-of-scope steps kept their authority');
    PERFORM _assert(
        (SELECT step_mapping_outcome = 'complete' FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U7: outcome complete (every in-scope step promoted)');
END;
$$;

\echo '=== U16: demote-first / promote-proven (partial mappings) ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    -- Contract-legal partial scenario (8.2: step updates invalidate their
    -- own steps): steps 1 and 2 are both edited (scope [1,2]); the mapper
    -- proved ONLY step 1. Step 2 must end explicitly non-authoritative;
    -- step 3 (out of scope) untouched.
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"steps":{"update":[
            {"id":"00000000-0000-4000-8000-00000000ed21",
             "fields":{"instruction":"Whisk flour and salt hard."}},
            {"id":"00000000-0000-4000-8000-00000000ed22",
             "fields":{"instruction":"Rest the dough one hour."}}]}}'::jsonb,
        '[{"step_position":1,"ingredient_positions":[2]}]'::jsonb,
        '[1,2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U16: status updated');
    PERFORM _assert(
        (SELECT ingredient_mapping_version = 1 FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND position = 1),
        'U16: proven step promoted');
    PERFORM _assert(
        (SELECT ingredient_mapping_version IS NULL FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND position = 2),
        'U16: unproven in-scope step left explicitly non-authoritative');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_step_ingredients rsi
         JOIN recipe_steps rs ON rs.id = rsi.step_id
         WHERE rs.recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND rs.position = 2) = 0,
        'U16: unproven step holds no stale associations');
    PERFORM _assert(
        (SELECT ingredient_mapping_version = 1 FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND position = 3),
        'U16: out-of-scope step authority stands');
    PERFORM _assert(
        (SELECT step_mapping_outcome = 'partial' FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U16: outcome partial');
END;
$$;

\echo '=== U13 + U9: CAS conflict and validation failures mutate NOTHING ==='
DO $$
DECLARE
    v_before jsonb;
    v_after jsonb;
    v_rev int;
BEGIN
    SELECT content_rev INTO v_rev FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO v_before
    FROM (
        SELECT r.id, r.title, r.content_rev, r.updated_at,
               (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
                FROM recipe_ingredients i WHERE i.recipe_id = r.id) AS ings,
               (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                FROM recipe_steps s WHERE s.recipe_id = r.id) AS steps
        FROM recipes r
        WHERE r.id = '00000000-0000-4000-8000-00000000ed01'
    ) t;

    -- U13: stale rev -> TL409.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"title":"stale write"}}'::jsonb, NULL, '[]'::jsonb)$q$,
        v_rev - 1),
        'TL409', 'U13: stale expected rev raises TL409');

    -- Cross-user edit -> TL404.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000b',
            %s, gen_random_uuid(),
            '{"fields":{"title":"cross-user"}}'::jsonb, NULL, '[]'::jsonb)$q$,
        v_rev),
        'TL404', 'U13: cross-user edit raises TL404 (spaced wording)');

    -- U9: a representative sweep of invalid op payloads -> TL422.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(), '{}'::jsonb, NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: empty ops object rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"image_path":"hack.jpg"}}'::jsonb, NULL, '[]'::jsonb)$q$,
        v_rev),
        'TL422', 'U9: unknown recipe field rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"title":null}}'::jsonb, NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: null title rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{"update":[{"id":"00000000-0000-4000-8000-00000000ed11",
                "fields":{"raw_text":"forged"}}]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: raw_text is not a patchable field');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{"update":[{"id":"00000000-0000-4000-8000-0000000000f4",
                "fields":{"name":"foreign"}}]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: cross-recipe id rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{"delete":["00000000-0000-4000-8000-00000000ed13"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: delete without order rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"steps":{"update":[{"id":"00000000-0000-4000-8000-00000000ed21",
                "fields":{"instruction":"  "}}]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U9: blank instruction rejected');
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"title":"x"}}'::jsonb, NULL, '[9]'::jsonb)$q$, v_rev),
        'TL422', 'U9: out-of-range scope position rejected');

    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO v_after
    FROM (
        SELECT r.id, r.title, r.content_rev, r.updated_at,
               (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
                FROM recipe_ingredients i WHERE i.recipe_id = r.id) AS ings,
               (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                FROM recipe_steps s WHERE s.recipe_id = r.id) AS steps
        FROM recipes r
        WHERE r.id = '00000000-0000-4000-8000-00000000ed01'
    ) t;
    PERFORM _assert(v_before = v_after,
        'U13/U9: every refusal mutated NOTHING (byte-identical state)');
END;
$$;

\echo '=== U18: in-RPC ops-invariant combinations (TL422, zero mutation) ==='
DO $$
DECLARE
    v_rev int;
    v_count_before bigint;
BEGIN
    SELECT content_rev INTO v_rev FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    SELECT count(*) INTO v_count_before FROM recipe_ingredients
    WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01';

    -- Same id updated AND deleted.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{
                "update":[{"id":"00000000-0000-4000-8000-00000000ed12",
                           "fields":{"name":"x"}}],
                "delete":["00000000-0000-4000-8000-00000000ed12"],
                "order":["00000000-0000-4000-8000-00000000ed11",
                         "00000000-0000-4000-8000-00000000ed13"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: update+delete of the same id rejected');

    -- Order membership violations: deleted member present.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{
                "delete":["00000000-0000-4000-8000-00000000ed13"],
                "order":["00000000-0000-4000-8000-00000000ed11",
                         "00000000-0000-4000-8000-00000000ed12",
                         "00000000-0000-4000-8000-00000000ed13"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: order containing a deleted row rejected');

    -- Order missing a surviving member.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{
                "order":["00000000-0000-4000-8000-00000000ed11",
                         "00000000-0000-4000-8000-00000000ed12"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: incomplete order membership rejected');

    -- Duplicate order entry.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"ingredients":{
                "order":["00000000-0000-4000-8000-00000000ed11",
                         "00000000-0000-4000-8000-00000000ed11",
                         "00000000-0000-4000-8000-00000000ed12"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: duplicate order entry rejected');

    -- Duplicate temp_ids.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"steps":{"create":[
                {"temp_id":"00000000-0000-4000-8000-00000000edcc","instruction":"A"},
                {"temp_id":"00000000-0000-4000-8000-00000000edcc","instruction":"B"}],
                "order":["00000000-0000-4000-8000-00000000ed21",
                         "00000000-0000-4000-8000-00000000ed22",
                         "00000000-0000-4000-8000-00000000ed23",
                         "00000000-0000-4000-8000-00000000edcc"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: duplicate temp_id rejected');

    -- Unresolved temp_id (created but absent from order).
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"steps":{"create":[
                {"temp_id":"00000000-0000-4000-8000-00000000edcd","instruction":"A"}],
                "order":["00000000-0000-4000-8000-00000000ed21",
                         "00000000-0000-4000-8000-00000000ed22",
                         "00000000-0000-4000-8000-00000000ed23"]}}'::jsonb,
            NULL, '[]'::jsonb)$q$, v_rev),
        'TL422', 'U18: unresolved temp_id rejected');

    -- Mapping entry outside the declared scope.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"steps":{"update":[{"id":"00000000-0000-4000-8000-00000000ed21",
                "fields":{"instruction":"Changed."}}]}}'::jsonb,
            '[{"step_position":3,"ingredient_positions":[]}]'::jsonb,
            '[1]'::jsonb)$q$, v_rev),
        'TL422', 'U18: mapping entry outside scope rejected');

    PERFORM _assert(
        (SELECT content_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01') = v_rev,
        'U18: no refusal advanced content_rev');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_ingredients
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01')
            = v_count_before,
        'U18: no refusal mutated membership');
END;
$$;

\echo '=== U15: atomicity (late mapping-validation failure rolls back content) ==='
DO $$
DECLARE
    v_rev int;
    v_title text;
BEGIN
    SELECT content_rev, title INTO v_rev, v_title FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    -- Valid content ops + malformed p_mappings: the whole call fails
    -- TL422 and the content change is rolled back with it.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"title":"Half-committed"},
              "steps":{"update":[{"id":"00000000-0000-4000-8000-00000000ed21",
                "fields":{"instruction":"Changed instruction."}}]}}'::jsonb,
            '[{"step_position":1,"ingredient_positions":[99]}]'::jsonb,
            '[1]'::jsonb)$q$, v_rev),
        'TL422', 'U15: out-of-range mapping position refused');
    PERFORM _assert(
        (SELECT title = v_title AND content_rev = v_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U15: content change rolled back with the refused mapping');
    PERFORM _assert(
        (SELECT instruction FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed21')
            <> 'Changed instruction.',
        'U15: step change rolled back with the refused mapping');
END;
$$;

\echo '=== U14: in-RPC replay semantics (narrow idempotency) ==='
DO $$
DECLARE
    v_rev int;
    v_mutation uuid := '00000000-0000-4000-8000-00000000edaa';
    v_res jsonb;
BEGIN
    SELECT content_rev INTO v_rev FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    v_res := update_recipe_content(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        v_rev, v_mutation,
        '{"fields":{"title":"Replay Target"}}'::jsonb, NULL, '[]'::jsonb);
    PERFORM _assert(
        v_res->>'status' = 'updated'
        AND (v_res->>'content_rev')::int = v_rev + 1,
        'U14: first commit updated');
    -- Same mutation replayed (old expected rev, as a lost-response retry
    -- would send): idempotent current success, ZERO mutation.
    v_res := update_recipe_content(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        v_rev, v_mutation,
        '{"fields":{"title":"Replay Target"}}'::jsonb, NULL, '[]'::jsonb);
    PERFORM _assert(
        v_res->>'status' = 'replay'
        AND (v_res->>'content_rev')::int = v_rev + 1,
        'U14: replay of the current mutation returns current state');
    PERFORM _assert(
        (SELECT content_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01') = v_rev + 1,
        'U14: replay did not advance content_rev');
    -- A DIFFERENT old mutation at the old rev is NOT a replay: TL409.
    PERFORM _expect_err(format(
        $q$SELECT update_recipe_content(
            '00000000-0000-4000-8000-00000000ed01',
            '00000000-0000-4000-8000-00000000000a',
            %s, gen_random_uuid(),
            '{"fields":{"title":"Old edit"}}'::jsonb, NULL, '[]'::jsonb)$q$,
        v_rev),
        'TL409', 'U14: an older different mutation conflicts truthfully');
END;
$$;

\echo '=== U17: genuine no-op (no mutation, no rev advance) ==='
DO $$
DECLARE
    v_rev int;
    v_updated timestamptz;
    v_res jsonb;
BEGIN
    SELECT content_rev, updated_at INTO v_rev, v_updated FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed01',
        '00000000-0000-4000-8000-00000000000a',
        '{"fields":{"title":"Replay Target"},
          "ingredients":{"update":[{"id":"00000000-0000-4000-8000-00000000ed12",
              "fields":{"name":"sea salt"}}]}}'::jsonb);
    PERFORM _assert(v_res->>'status' = 'noop', 'U17: status noop');
    PERFORM _assert(
        (SELECT content_rev = v_rev AND updated_at = v_updated FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed01'),
        'U17: no-op advanced nothing (rev + updated_at unchanged)');
END;
$$;

\echo '=== U11: attach rev-guard (stale TL428 zero mutation; current promotes) ==='
DO $$
DECLARE
    v_rev int;
BEGIN
    SELECT content_rev INTO v_rev FROM recipes
    WHERE id = '00000000-0000-4000-8000-00000000ed01';
    PERFORM _expect_err(format(
        $q$SELECT attach_step_ingredient_mapping(
            '00000000-0000-4000-8000-00000000ed01', %s,
            '[{"step_position":1,"ingredient_positions":[1]}]'::jsonb)$q$,
        v_rev - 1),
        'TL428', 'U11: stale attach refused with TL428');
    -- Current rev promotes.
    PERFORM attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed01', v_rev,
        '[{"step_position":1,"ingredient_positions":[1]}]'::jsonb);
    PERFORM _assert(
        (SELECT ingredient_mapping_version = 1 FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed01'
           AND position = 1),
        'U11: current-rev attach promotes');
END;
$$;

\echo '=== U10: identity and provenance untouched by every edit above ==='
SELECT _assert(
    (SELECT user_id = '00000000-0000-4000-8000-00000000000a'
         AND source_url = 'https://proof.local/e1'
         AND confidence_score = 0.9::real
         AND parent_recipe_id IS NULL
         AND riff_session_id IS NULL
         AND riff_label IS NULL
     FROM recipes WHERE id = '00000000-0000-4000-8000-00000000ed01'),
    'U10: identity/provenance columns untouched');

\echo '=== U5: ingredient delete scope semantics (membership recipe E2) ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    -- Delete MI2 ('peas', referenced by MS2 only) with scope [2] and a
    -- soft-failed mapper: only MS2 demoted; MS1 keeps authority.
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{"delete":["00000000-0000-4000-8000-00000000ed32"],
                         "order":["00000000-0000-4000-8000-00000000ed31"]}}'::jsonb,
        NULL, '[2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U5: status updated');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_ingredients
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02') = 1,
        'U5: row deleted');
    PERFORM _assert(
        (SELECT ingredient_mapping_version IS NULL FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed42'),
        'U5: referencing step demoted');
    PERFORM _assert(
        (SELECT ingredient_mapping_version = 1 FROM recipe_steps
         WHERE id = '00000000-0000-4000-8000-00000000ed41'),
        'U5: non-referencing step keeps authority');

    -- Create an unreferenced ingredient, then delete it with EMPTY scope:
    -- zero demotion of the surviving authority.
    PERFORM attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed02',
        (SELECT content_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed02'),
        '[{"step_position":1,"ingredient_positions":[1]},
          {"step_position":2,"ingredient_positions":[]}]'::jsonb);
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{
            "create":[{"temp_id":"00000000-0000-4000-8000-00000000ed33",
                       "name":"garnish"}],
            "order":["00000000-0000-4000-8000-00000000ed31",
                     "00000000-0000-4000-8000-00000000ed33"]}}'::jsonb,
        NULL, '[1,2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U5: create committed');
    PERFORM attach_step_ingredient_mapping(
        '00000000-0000-4000-8000-00000000ed02',
        (SELECT content_rev FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed02'),
        '[{"step_position":1,"ingredient_positions":[1]},
          {"step_position":2,"ingredient_positions":[]}]'::jsonb);
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        (SELECT jsonb_build_object('ingredients', jsonb_build_object(
            'delete', jsonb_build_array(ri.id),
            'order', jsonb_build_array('00000000-0000-4000-8000-00000000ed31')))
         FROM recipe_ingredients ri
         WHERE ri.recipe_id = '00000000-0000-4000-8000-00000000ed02'
           AND ri.name = 'garnish'),
        NULL, '[]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated',
        'U5: unreferenced delete committed');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02'
           AND ingredient_mapping_version = 1) = 2,
        'U5: empty scope = zero demotion');
END;
$$;

\echo '=== U6: ingredient create demotes the whole recipe ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        '{"ingredients":{
            "create":[{"temp_id":"00000000-0000-4000-8000-00000000ed34",
                       "name":"lemon", "quantity":"1", "unit":null,
                       "prep":"zested"}],
            "order":["00000000-0000-4000-8000-00000000ed34",
                     "00000000-0000-4000-8000-00000000ed31"]}}'::jsonb,
        NULL, '[1,2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U6: status updated');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_ingredients
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02'
           AND name = 'lemon' AND position = 1 AND prep = 'zested') = 1,
        'U6: created row persisted at its ordered position');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02'
           AND ingredient_mapping_version IS NOT NULL) = 0,
        'U6: whole recipe demoted (create + null mappings)');
END;
$$;

\echo '=== U8: step create + delete ==='
DO $$
DECLARE
    v_res jsonb;
    v_new_step uuid;
BEGIN
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        '{"steps":{
            "create":[{"temp_id":"00000000-0000-4000-8000-00000000ed43",
                       "instruction":"Garnish and serve."}],
            "order":["00000000-0000-4000-8000-00000000ed41",
                     "00000000-0000-4000-8000-00000000ed42",
                     "00000000-0000-4000-8000-00000000ed43"]}}'::jsonb,
        '[{"step_position":3,"ingredient_positions":[1]}]'::jsonb,
        '[3]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U8: create committed');
    SELECT id INTO v_new_step FROM recipe_steps
    WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02' AND position = 3;
    PERFORM _assert(
        (SELECT instruction = 'Garnish and serve.'
             AND ingredient_mapping_version = 1
         FROM recipe_steps WHERE id = v_new_step),
        'U8: created step persisted and promoted from fresh results');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_step_ingredients
         WHERE step_id = v_new_step) = 1,
        'U8: created step association promoted');

    -- Delete it again: cascade removes its state; others untouched.
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        (SELECT jsonb_build_object('steps', jsonb_build_object(
            'delete', jsonb_build_array(v_new_step),
            'order', jsonb_build_array(
                '00000000-0000-4000-8000-00000000ed41',
                '00000000-0000-4000-8000-00000000ed42')))),
        NULL, '[]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U8: delete committed');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_steps
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02') = 2,
        'U8: step deleted');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_step_ingredients
         WHERE step_id = v_new_step) = 0,
        'U8: deleted step state cascaded away');
END;
$$;

\echo '=== U9b: empty-section result (delete-all via explicit ids) ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    v_res := _edit(
        '00000000-0000-4000-8000-00000000ed02',
        '00000000-0000-4000-8000-00000000000a',
        (SELECT jsonb_build_object('ingredients', jsonb_build_object(
            'delete', jsonb_agg(ri.id),
            'order', '[]'::jsonb))
         FROM recipe_ingredients ri
         WHERE ri.recipe_id = '00000000-0000-4000-8000-00000000ed02'),
        NULL,
        '[1,2]'::jsonb);
    PERFORM _assert(v_res->>'status' = 'updated', 'U9b: delete-all committed');
    PERFORM _assert(
        (SELECT count(*) FROM recipe_ingredients
         WHERE recipe_id = '00000000-0000-4000-8000-00000000ed02') = 0,
        'U9b: zero ingredient rows is a legal end state');
    PERFORM _assert(
        (SELECT count(*) FROM recipes
         WHERE id = '00000000-0000-4000-8000-00000000ed02') = 1,
        'U9b: recipe survives with an empty section');
END;
$$;

RESET ROLE;
\echo '=== ISSUE 3 SINGLE-SESSION BATTERIES PASSED ==='
