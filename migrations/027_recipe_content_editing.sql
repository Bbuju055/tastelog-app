-- migrations/027_recipe_content_editing.sql
-- Issue 3: post-save recipe content editing.
--
-- Implements the accepted Issue 3 contract
-- (docs/issue3-saved-recipe-editing-plan.md):
--   1. recipes.content_rev: monotonic content revision, incremented only by
--      the sanctioned mutation path (update_recipe_content below). CAS
--      anchor for every optimistic edit.
--   2. recipes.last_content_mutation_id: the NARROW idempotency identity.
--      NOT a mutation ledger: it records only the most recent committed
--      content mutation. Replaying that same mutation returns idempotent
--      success; any older mutation truthfully conflicts (TL409).
--   3. get_recipe_snapshot: ONE SELECT statement (single MVCC snapshot)
--      aggregating the recipe row, ingredients, steps, associations and
--      tags. Every read consumer inherits coherence through it.
--   4. update_recipe_content: the SHORT atomic commit transaction (Phase C
--      of the optimistic two-phase save). Contains NO provider work; holds
--      the recipe row lock only for validation + writes. Explicit
--      field/row operations only: unchanged rows are never retransmitted
--      and never interpreted as edits.
--   5. attach_step_ingredient_mapping re-issued as a 3-parameter function
--      with a content_rev freshness precondition (TL428 stale refusal):
--      a mapping computed against superseded content can never promote.
--      The 026 service-role-only EXECUTE posture is restored verbatim.
--   6. Privilege hardening: INSERT/UPDATE/DELETE on the four recipe
--      content tables revoked from PUBLIC, anon and authenticated. SELECT
--      is untouched (api/routes/riff.py visibility check). service_role
--      grants and SECURITY DEFINER functions are unaffected.
--
-- Typed SQLSTATEs (mapped by api/core/recipes.py):
--   TL404  recipe missing or not owned ('Recipe not found or not owned by
--          user' -- the spaced wording is itself part of the contract)
--   TL409  content revision conflict (CAS failure)
--   TL422  operation payload validation failure (zero mutation)
--   TL428  stale content revision for mapping attach (attach only)

-- ---------------------------------------------------------------------------
-- 1-2. Revision + idempotency columns
-- ---------------------------------------------------------------------------

ALTER TABLE recipes
    ADD COLUMN content_rev INTEGER NOT NULL DEFAULT 1
        CONSTRAINT recipes_content_rev_positive CHECK (content_rev >= 1);

ALTER TABLE recipes
    ADD COLUMN last_content_mutation_id UUID;

-- ---------------------------------------------------------------------------
-- 3. Coherent snapshot read (single-statement SQL function = one MVCC
--    snapshot across recipe, children, associations and tags)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_recipe_snapshot(
    p_recipe_id UUID,
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'recipe', jsonb_build_object(
            'id', r.id,
            'user_id', r.user_id,
            'title', r.title,
            'image_path', r.image_path,
            'source_url', r.source_url,
            'servings', r.servings,
            'prep_time', r.prep_time,
            'cook_time', r.cook_time,
            'confidence_score', r.confidence_score,
            'favorite', r.favorite,
            'created_at', r.created_at,
            'updated_at', r.updated_at,
            'parent_recipe_id', r.parent_recipe_id,
            'riff_session_id', r.riff_session_id,
            'riff_label', r.riff_label,
            'content_rev', r.content_rev,
            'last_content_mutation_id', r.last_content_mutation_id
        ),
        'ingredients', COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', i.id,
                        'recipe_id', i.recipe_id,
                        'position', i.position,
                        'quantity', i.quantity,
                        'unit', i.unit,
                        'name', i.name,
                        'prep', i.prep,
                        'raw_text', i.raw_text
                    )
                    ORDER BY i.position, i.id
                )
                FROM recipe_ingredients i
                WHERE i.recipe_id = r.id
            ),
            '[]'::jsonb
        ),
        'steps', COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', s.id,
                        'recipe_id', s.recipe_id,
                        'position', s.position,
                        'instruction', s.instruction,
                        'ingredient_mapping_version', s.ingredient_mapping_version
                    )
                    ORDER BY s.position, s.id
                )
                FROM recipe_steps s
                WHERE s.recipe_id = r.id
            ),
            '[]'::jsonb
        ),
        'associations', COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'step_id', a.step_id,
                        'ingredient_id', a.ingredient_id
                    )
                )
                FROM recipe_step_ingredients a
                WHERE a.recipe_id = r.id
            ),
            '[]'::jsonb
        ),
        'tags', COALESCE(
            (
                SELECT jsonb_agg(t.tag ORDER BY t.created_at)
                FROM recipe_tags t
                WHERE t.recipe_id = r.id
            ),
            '[]'::jsonb
        )
    )
    FROM recipes r
    WHERE r.id = p_recipe_id
      AND r.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION get_recipe_snapshot(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_recipe_snapshot(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION get_recipe_snapshot(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The short atomic commit (Phase C of the optimistic two-phase save)
-- ---------------------------------------------------------------------------

-- p_ops: the explicit-operation payload (plan section 6.1), already
-- Pydantic-validated by the API. This function re-validates FAIL-CLOSED as
-- the authority (plan section 6.8): any violation raises TL422 and mutates
-- nothing.
--
-- p_invalidated_scope: JSONB array of POST-edit step positions whose
-- mapping authority is invalidated by this edit (plan section 8.2).
--
-- p_mappings: JSONB array of {"step_position": int, "ingredient_positions":
-- [int, ...]} against the POST-edit canonical orders, restricted to the
-- invalidated scope, or NULL when the bounded mapper soft-failed. Demote
-- the whole scope FIRST, then promote only these fresh validated results:
-- a partial result leaves omitted in-scope steps explicitly
-- non-authoritative, never stale-authoritative.
CREATE OR REPLACE FUNCTION update_recipe_content(
    p_recipe_id UUID,
    p_user_id UUID,
    p_expected_content_rev INTEGER,
    p_mutation_id UUID,
    p_ops JSONB,
    p_mappings JSONB,
    p_invalidated_scope JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_recipe recipes%ROWTYPE;
    v_fields JSONB;
    v_key TEXT;
    v_section_name TEXT;
    v_section JSONB;
    v_entry JSONB;
    v_entry_fields JSONB;
    v_elem JSONB;
    v_id UUID;
    v_num NUMERIC;
    v_pos INT;
    v_idx INT;
    v_text TEXT;

    -- Current membership (position order).
    v_cur_ing_ids UUID[];
    v_cur_step_ids UUID[];

    -- Per-section op working state, reloaded per section pass.
    v_update_ids UUID[];
    v_delete_ids UUID[];
    v_temp_ids UUID[];
    v_order_ids UUID[];
    v_surviving_ids UUID[];

    -- Section results carried into the apply phase.
    v_ing_delete_ids UUID[] := '{}';
    v_step_delete_ids UUID[] := '{}';
    v_ing_order UUID[];              -- final order incl. temp ids, NULL = keep current
    v_step_order UUID[];
    v_ing_changed_rows JSONB := '{}'::jsonb;   -- id -> true (semantic change)
    v_step_changed_rows JSONB := '{}'::jsonb;

    -- Final membership (real row ids in final position order).
    v_final_ing_ids UUID[];
    v_final_step_ids UUID[];

    v_any_change BOOLEAN := FALSE;
    v_row RECORD;
    v_row_changed BOOLEAN;
    v_new_id UUID;
    v_create_by_temp JSONB;

    -- Mapping phase.
    v_scope_positions INT[] := '{}';
    v_seen_positions INT[] := '{}';
    v_promoted INT := 0;
    v_step_id UUID;
    v_outcome TEXT;
BEGIN
    -- ---------------------------------------------------------------
    -- Lock, ownership, replay, CAS
    -- ---------------------------------------------------------------
    SELECT * INTO v_recipe FROM recipes WHERE id = p_recipe_id FOR UPDATE;
    IF NOT FOUND OR v_recipe.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'Recipe not found or not owned by user'
            USING ERRCODE = 'TL404';
    END IF;

    IF p_mutation_id IS NULL THEN
        RAISE EXCEPTION 'Mutation id is required' USING ERRCODE = 'TL422';
    END IF;

    -- Lost-response replay: the SAME current mutation returns idempotent
    -- success with zero mutation. This is the narrow guarantee: only the
    -- CURRENT mutation replays; anything older falls through to the CAS
    -- below and truthfully conflicts.
    IF v_recipe.last_content_mutation_id IS NOT DISTINCT FROM p_mutation_id THEN
        RETURN jsonb_build_object(
            'status', 'replay',
            'recipe_id', p_recipe_id,
            'content_rev', v_recipe.content_rev
        );
    END IF;

    -- CAS: if the revision moved (including while Phase B provider work
    -- ran), the already-computed p_mappings is DISCARDED with the rest of
    -- this call. Never a stale write.
    IF v_recipe.content_rev IS DISTINCT FROM p_expected_content_rev THEN
        RAISE EXCEPTION 'Recipe content revision conflict'
            USING ERRCODE = 'TL409';
    END IF;

    -- ---------------------------------------------------------------
    -- Validate p_ops fail-closed (plan section 6.8). Zero mutation on
    -- any violation: nothing below writes until validation completes.
    -- ---------------------------------------------------------------
    IF p_ops IS NULL OR jsonb_typeof(p_ops) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Operations payload must be an object'
            USING ERRCODE = 'TL422';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_ops)
    LOOP
        IF v_key NOT IN ('fields', 'ingredients', 'steps') THEN
            RAISE EXCEPTION 'Unknown operations key: %', v_key
                USING ERRCODE = 'TL422';
        END IF;
    END LOOP;
    IF NOT (p_ops ? 'fields' OR p_ops ? 'ingredients' OR p_ops ? 'steps') THEN
        RAISE EXCEPTION 'Empty operations payload' USING ERRCODE = 'TL422';
    END IF;

    -- Scalar fields patch.
    IF p_ops ? 'fields' THEN
        v_fields := p_ops->'fields';
        IF jsonb_typeof(v_fields) IS DISTINCT FROM 'object'
           OR v_fields = '{}'::jsonb THEN
            RAISE EXCEPTION 'Invalid fields patch' USING ERRCODE = 'TL422';
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(v_fields)
        LOOP
            IF v_key NOT IN ('title', 'servings', 'prep_time', 'cook_time') THEN
                RAISE EXCEPTION 'Unknown recipe field: %', v_key
                    USING ERRCODE = 'TL422';
            END IF;
            IF jsonb_typeof(v_fields->v_key) NOT IN ('string', 'null') THEN
                RAISE EXCEPTION 'Recipe field % must be a string or null', v_key
                    USING ERRCODE = 'TL422';
            END IF;
            IF v_key = 'title' THEN
                IF jsonb_typeof(v_fields->'title') IS DISTINCT FROM 'string'
                   OR btrim(v_fields->>'title') = '' THEN
                    RAISE EXCEPTION 'Title cannot be empty'
                        USING ERRCODE = 'TL422';
                END IF;
            ELSIF jsonb_typeof(v_fields->v_key) = 'string'
                  AND btrim(v_fields->>v_key) = '' THEN
                RAISE EXCEPTION 'Recipe field % cannot be blank; use null to clear', v_key
                    USING ERRCODE = 'TL422';
            END IF;
        END LOOP;
    END IF;

    SELECT COALESCE(array_agg(id ORDER BY position, id), '{}')
        INTO v_cur_ing_ids
    FROM recipe_ingredients WHERE recipe_id = p_recipe_id;
    SELECT COALESCE(array_agg(id ORDER BY position, id), '{}')
        INTO v_cur_step_ids
    FROM recipe_steps WHERE recipe_id = p_recipe_id;

    -- Section validation: identical structural rules for both sections;
    -- the row-type field allowlists differ (ingredients:
    -- name/quantity/unit/prep; steps: instruction).
    FOREACH v_section_name IN ARRAY ARRAY['ingredients', 'steps']
    LOOP
        CONTINUE WHEN NOT (p_ops ? v_section_name);
        v_section := p_ops->v_section_name;
        IF jsonb_typeof(v_section) IS DISTINCT FROM 'object'
           OR v_section = '{}'::jsonb THEN
            RAISE EXCEPTION 'Invalid % section', v_section_name
                USING ERRCODE = 'TL422';
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(v_section)
        LOOP
            IF v_key NOT IN ('update', 'create', 'delete', 'order') THEN
                RAISE EXCEPTION 'Unknown % operation: %', v_section_name, v_key
                    USING ERRCODE = 'TL422';
            END IF;
            IF jsonb_typeof(v_section->v_key) IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'Operation %.% must be an array',
                    v_section_name, v_key
                    USING ERRCODE = 'TL422';
            END IF;
            -- `order` alone may be empty (deleting every row makes the
            -- complete final membership the empty sequence).
            IF v_key IS DISTINCT FROM 'order'
               AND jsonb_array_length(v_section->v_key) = 0 THEN
                RAISE EXCEPTION 'Operation %.% must be a non-empty array',
                    v_section_name, v_key
                    USING ERRCODE = 'TL422';
            END IF;
        END LOOP;

        v_update_ids := '{}';
        v_delete_ids := '{}';
        v_temp_ids := '{}';
        v_order_ids := '{}';

        -- update ops
        IF v_section ? 'update' THEN
            FOR v_entry IN SELECT * FROM jsonb_array_elements(v_section->'update')
            LOOP
                IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
                   OR NOT (v_entry ? 'id') OR NOT (v_entry ? 'fields') THEN
                    RAISE EXCEPTION 'Invalid update op shape'
                        USING ERRCODE = 'TL422';
                END IF;
                FOR v_key IN SELECT jsonb_object_keys(v_entry)
                LOOP
                    IF v_key NOT IN ('id', 'fields') THEN
                        RAISE EXCEPTION 'Unknown update op key: %', v_key
                            USING ERRCODE = 'TL422';
                    END IF;
                END LOOP;
                IF jsonb_typeof(v_entry->'id') IS DISTINCT FROM 'string' THEN
                    RAISE EXCEPTION 'Update op id must be a string'
                        USING ERRCODE = 'TL422';
                END IF;
                v_id := (v_entry->>'id')::UUID;
                IF (v_section_name = 'ingredients'
                        AND NOT (v_id = ANY (v_cur_ing_ids)))
                   OR (v_section_name = 'steps'
                        AND NOT (v_id = ANY (v_cur_step_ids))) THEN
                    RAISE EXCEPTION 'Unknown % id in update op',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                IF v_id = ANY (v_update_ids) THEN
                    RAISE EXCEPTION 'Duplicate % id across update ops',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                v_update_ids := v_update_ids || v_id;

                v_entry_fields := v_entry->'fields';
                IF jsonb_typeof(v_entry_fields) IS DISTINCT FROM 'object'
                   OR v_entry_fields = '{}'::jsonb THEN
                    RAISE EXCEPTION 'Update op fields must be a non-empty object'
                        USING ERRCODE = 'TL422';
                END IF;
                FOR v_key IN SELECT jsonb_object_keys(v_entry_fields)
                LOOP
                    IF (v_section_name = 'ingredients'
                            AND v_key NOT IN ('name', 'quantity', 'unit', 'prep'))
                       OR (v_section_name = 'steps'
                            AND v_key IS DISTINCT FROM 'instruction') THEN
                        RAISE EXCEPTION 'Unknown % field in update op: %',
                            v_section_name, v_key USING ERRCODE = 'TL422';
                    END IF;
                    IF jsonb_typeof(v_entry_fields->v_key)
                            NOT IN ('string', 'null') THEN
                        RAISE EXCEPTION 'Field % must be a string or null', v_key
                            USING ERRCODE = 'TL422';
                    END IF;
                    IF v_key IN ('name', 'instruction') THEN
                        IF jsonb_typeof(v_entry_fields->v_key)
                                IS DISTINCT FROM 'string'
                           OR btrim(v_entry_fields->>v_key) = '' THEN
                            RAISE EXCEPTION 'Field % cannot be empty', v_key
                                USING ERRCODE = 'TL422';
                        END IF;
                    ELSIF jsonb_typeof(v_entry_fields->v_key) = 'string'
                          AND btrim(v_entry_fields->>v_key) = '' THEN
                        RAISE EXCEPTION 'Field % cannot be blank; use null to clear',
                            v_key USING ERRCODE = 'TL422';
                    END IF;
                END LOOP;
            END LOOP;
        END IF;

        -- delete ops
        IF v_section ? 'delete' THEN
            FOR v_elem IN SELECT * FROM jsonb_array_elements(v_section->'delete')
            LOOP
                IF jsonb_typeof(v_elem) IS DISTINCT FROM 'string' THEN
                    RAISE EXCEPTION 'Delete op entries must be id strings'
                        USING ERRCODE = 'TL422';
                END IF;
                v_id := (v_elem#>>'{}')::UUID;
                IF (v_section_name = 'ingredients'
                        AND NOT (v_id = ANY (v_cur_ing_ids)))
                   OR (v_section_name = 'steps'
                        AND NOT (v_id = ANY (v_cur_step_ids))) THEN
                    RAISE EXCEPTION 'Unknown % id in delete op',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                IF v_id = ANY (v_delete_ids) THEN
                    RAISE EXCEPTION 'Duplicate % id in delete op',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                IF v_id = ANY (v_update_ids) THEN
                    RAISE EXCEPTION 'A % row cannot be both updated and deleted',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                v_delete_ids := v_delete_ids || v_id;
            END LOOP;
        END IF;

        -- create ops
        IF v_section ? 'create' THEN
            FOR v_entry IN SELECT * FROM jsonb_array_elements(v_section->'create')
            LOOP
                IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
                   OR NOT (v_entry ? 'temp_id') THEN
                    RAISE EXCEPTION 'Invalid create op shape'
                        USING ERRCODE = 'TL422';
                END IF;
                FOR v_key IN SELECT jsonb_object_keys(v_entry)
                LOOP
                    IF (v_section_name = 'ingredients'
                            AND v_key NOT IN
                                ('temp_id', 'name', 'quantity', 'unit', 'prep'))
                       OR (v_section_name = 'steps'
                            AND v_key NOT IN ('temp_id', 'instruction')) THEN
                        RAISE EXCEPTION 'Unknown % create key: %',
                            v_section_name, v_key USING ERRCODE = 'TL422';
                    END IF;
                END LOOP;
                IF jsonb_typeof(v_entry->'temp_id') IS DISTINCT FROM 'string' THEN
                    RAISE EXCEPTION 'Create op temp_id must be a string'
                        USING ERRCODE = 'TL422';
                END IF;
                v_id := (v_entry->>'temp_id')::UUID;
                IF v_id = ANY (v_temp_ids) THEN
                    RAISE EXCEPTION 'Duplicate temp_id in create ops'
                        USING ERRCODE = 'TL422';
                END IF;
                IF v_id = ANY (v_cur_ing_ids) OR v_id = ANY (v_cur_step_ids) THEN
                    RAISE EXCEPTION 'temp_id collides with an existing row id'
                        USING ERRCODE = 'TL422';
                END IF;
                v_temp_ids := v_temp_ids || v_id;

                v_key := CASE v_section_name
                    WHEN 'ingredients' THEN 'name' ELSE 'instruction' END;
                IF NOT (v_entry ? v_key)
                   OR jsonb_typeof(v_entry->v_key) IS DISTINCT FROM 'string'
                   OR btrim(v_entry->>v_key) = '' THEN
                    RAISE EXCEPTION 'Create op requires a non-empty %', v_key
                        USING ERRCODE = 'TL422';
                END IF;
                IF v_section_name = 'ingredients' THEN
                    FOREACH v_key IN ARRAY ARRAY['quantity', 'unit', 'prep']
                    LOOP
                        IF v_entry ? v_key THEN
                            IF jsonb_typeof(v_entry->v_key)
                                    NOT IN ('string', 'null') THEN
                                RAISE EXCEPTION 'Create field % must be a string or null',
                                    v_key USING ERRCODE = 'TL422';
                            END IF;
                            IF jsonb_typeof(v_entry->v_key) = 'string'
                               AND btrim(v_entry->>v_key) = '' THEN
                                RAISE EXCEPTION 'Create field % cannot be blank',
                                    v_key USING ERRCODE = 'TL422';
                            END IF;
                        END IF;
                    END LOOP;
                END IF;
            END LOOP;
        END IF;

        -- order: required whenever membership changes; when present, must
        -- contain EXACTLY the complete final post-edit membership once
        -- each (every surviving existing row + every created temp row).
        IF (v_section ? 'create' OR v_section ? 'delete')
           AND NOT (v_section ? 'order') THEN
            RAISE EXCEPTION 'Order array is required when % membership changes',
                v_section_name USING ERRCODE = 'TL422';
        END IF;
        IF v_section ? 'order' THEN
            IF v_section_name = 'ingredients' THEN
                SELECT COALESCE(array_agg(x ORDER BY ord), '{}')
                    INTO v_surviving_ids
                FROM unnest(v_cur_ing_ids) WITH ORDINALITY AS t(x, ord)
                WHERE NOT (x = ANY (v_delete_ids));
            ELSE
                SELECT COALESCE(array_agg(x ORDER BY ord), '{}')
                    INTO v_surviving_ids
                FROM unnest(v_cur_step_ids) WITH ORDINALITY AS t(x, ord)
                WHERE NOT (x = ANY (v_delete_ids));
            END IF;
            FOR v_elem IN SELECT * FROM jsonb_array_elements(v_section->'order')
            LOOP
                IF jsonb_typeof(v_elem) IS DISTINCT FROM 'string' THEN
                    RAISE EXCEPTION 'Order entries must be id strings'
                        USING ERRCODE = 'TL422';
                END IF;
                v_id := (v_elem#>>'{}')::UUID;
                IF NOT (v_id = ANY (v_surviving_ids))
                   AND NOT (v_id = ANY (v_temp_ids)) THEN
                    RAISE EXCEPTION 'Order entry is not a surviving or created % row',
                        v_section_name USING ERRCODE = 'TL422';
                END IF;
                IF v_id = ANY (v_order_ids) THEN
                    RAISE EXCEPTION 'Duplicate order entry'
                        USING ERRCODE = 'TL422';
                END IF;
                v_order_ids := v_order_ids || v_id;
            END LOOP;
            IF COALESCE(array_length(v_order_ids, 1), 0)
                    IS DISTINCT FROM
               (COALESCE(array_length(v_surviving_ids, 1), 0)
                    + COALESCE(array_length(v_temp_ids, 1), 0)) THEN
                RAISE EXCEPTION 'Order array must cover the complete final % membership',
                    v_section_name USING ERRCODE = 'TL422';
            END IF;
        END IF;

        IF v_section_name = 'ingredients' THEN
            v_ing_delete_ids := v_delete_ids;
            v_ing_order := CASE WHEN v_section ? 'order'
                THEN v_order_ids ELSE NULL END;
        ELSE
            v_step_delete_ids := v_delete_ids;
            v_step_order := CASE WHEN v_section ? 'order'
                THEN v_order_ids ELSE NULL END;
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------
    -- Effective-change detection (no-op rule, plan section 6.8): a
    -- genuine no-op performs no mutation and does NOT advance
    -- content_rev. Also computes, per updated row, whether a SEMANTIC
    -- change actually occurred (IS DISTINCT FROM against the locked
    -- current row): only such rows lose raw_text.
    -- ---------------------------------------------------------------
    IF p_ops ? 'fields' THEN
        v_fields := p_ops->'fields';
        IF (v_fields ? 'title'
                AND (v_fields->>'title') IS DISTINCT FROM v_recipe.title)
           OR (v_fields ? 'servings'
                AND (v_fields->>'servings') IS DISTINCT FROM v_recipe.servings)
           OR (v_fields ? 'prep_time'
                AND (v_fields->>'prep_time') IS DISTINCT FROM v_recipe.prep_time)
           OR (v_fields ? 'cook_time'
                AND (v_fields->>'cook_time') IS DISTINCT FROM v_recipe.cook_time)
        THEN
            v_any_change := TRUE;
        END IF;
    END IF;

    IF p_ops ? 'ingredients' AND (p_ops->'ingredients') ? 'update' THEN
        FOR v_entry IN
            SELECT * FROM jsonb_array_elements(p_ops->'ingredients'->'update')
        LOOP
            v_id := (v_entry->>'id')::UUID;
            v_entry_fields := v_entry->'fields';
            SELECT * INTO v_row FROM recipe_ingredients WHERE id = v_id;
            v_row_changed :=
                (v_entry_fields ? 'name'
                    AND (v_entry_fields->>'name') IS DISTINCT FROM v_row.name)
                OR (v_entry_fields ? 'quantity'
                    AND (v_entry_fields->>'quantity') IS DISTINCT FROM v_row.quantity)
                OR (v_entry_fields ? 'unit'
                    AND (v_entry_fields->>'unit') IS DISTINCT FROM v_row.unit)
                OR (v_entry_fields ? 'prep'
                    AND (v_entry_fields->>'prep') IS DISTINCT FROM v_row.prep);
            IF v_row_changed THEN
                v_any_change := TRUE;
                v_ing_changed_rows :=
                    v_ing_changed_rows || jsonb_build_object(v_id::text, TRUE);
            END IF;
        END LOOP;
    END IF;

    IF p_ops ? 'steps' AND (p_ops->'steps') ? 'update' THEN
        FOR v_entry IN
            SELECT * FROM jsonb_array_elements(p_ops->'steps'->'update')
        LOOP
            v_id := (v_entry->>'id')::UUID;
            v_entry_fields := v_entry->'fields';
            SELECT * INTO v_row FROM recipe_steps WHERE id = v_id;
            IF v_entry_fields ? 'instruction'
               AND (v_entry_fields->>'instruction')
                       IS DISTINCT FROM v_row.instruction THEN
                v_any_change := TRUE;
                v_step_changed_rows :=
                    v_step_changed_rows || jsonb_build_object(v_id::text, TRUE);
            END IF;
        END LOOP;
    END IF;

    IF COALESCE(array_length(v_ing_delete_ids, 1), 0) > 0
       OR COALESCE(array_length(v_step_delete_ids, 1), 0) > 0
       OR (p_ops ? 'ingredients' AND (p_ops->'ingredients') ? 'create')
       OR (p_ops ? 'steps' AND (p_ops->'steps') ? 'create') THEN
        v_any_change := TRUE;
    END IF;

    -- A pure reorder is a change only when the order actually differs.
    IF NOT v_any_change AND v_ing_order IS NOT NULL
       AND v_ing_order IS DISTINCT FROM v_cur_ing_ids THEN
        v_any_change := TRUE;
    END IF;
    IF NOT v_any_change AND v_step_order IS NOT NULL
       AND v_step_order IS DISTINCT FROM v_cur_step_ids THEN
        v_any_change := TRUE;
    END IF;

    IF NOT v_any_change THEN
        RETURN jsonb_build_object(
            'status', 'noop',
            'recipe_id', p_recipe_id,
            'content_rev', v_recipe.content_rev
        );
    END IF;

    -- ---------------------------------------------------------------
    -- Validate the mapping inputs against the POST-edit membership
    -- (still before any mutation).
    -- ---------------------------------------------------------------
    v_final_ing_ids := COALESCE(v_ing_order, (
        SELECT COALESCE(array_agg(x ORDER BY ord), '{}')
        FROM unnest(v_cur_ing_ids) WITH ORDINALITY AS t(x, ord)
        WHERE NOT (x = ANY (v_ing_delete_ids))
    ));
    v_final_step_ids := COALESCE(v_step_order, (
        SELECT COALESCE(array_agg(x ORDER BY ord), '{}')
        FROM unnest(v_cur_step_ids) WITH ORDINALITY AS t(x, ord)
        WHERE NOT (x = ANY (v_step_delete_ids))
    ));

    IF p_invalidated_scope IS NULL
       OR jsonb_typeof(p_invalidated_scope) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Invalidated scope must be an array'
            USING ERRCODE = 'TL422';
    END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_invalidated_scope)
    LOOP
        IF jsonb_typeof(v_elem) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Scope entries must be step positions'
                USING ERRCODE = 'TL422';
        END IF;
        v_num := (v_elem#>>'{}')::NUMERIC;
        IF v_num IS DISTINCT FROM trunc(v_num)
           OR v_num < 1
           OR v_num > COALESCE(array_length(v_final_step_ids, 1), 0) THEN
            RAISE EXCEPTION 'Scope position out of range: %', v_elem
                USING ERRCODE = 'TL422';
        END IF;
        v_pos := v_num::INT;
        IF v_pos = ANY (v_scope_positions) THEN
            RAISE EXCEPTION 'Duplicate scope position: %', v_pos
                USING ERRCODE = 'TL422';
        END IF;
        v_scope_positions := v_scope_positions || v_pos;
    END LOOP;

    IF p_mappings IS NOT NULL THEN
        IF jsonb_typeof(p_mappings) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'Invalid mappings payload: expected array'
                USING ERRCODE = 'TL422';
        END IF;
        FOR v_entry IN SELECT * FROM jsonb_array_elements(p_mappings)
        LOOP
            IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
               OR NOT (v_entry ? 'step_position')
               OR NOT (v_entry ? 'ingredient_positions')
               OR jsonb_typeof(v_entry->'step_position')
                       IS DISTINCT FROM 'number'
               OR jsonb_typeof(v_entry->'ingredient_positions')
                       IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'Invalid mapping entry shape'
                    USING ERRCODE = 'TL422';
            END IF;
            v_num := (v_entry->>'step_position')::NUMERIC;
            IF v_num IS DISTINCT FROM trunc(v_num) THEN
                RAISE EXCEPTION 'Mapping step position must be integral'
                    USING ERRCODE = 'TL422';
            END IF;
            v_pos := v_num::INT;
            IF NOT (v_pos = ANY (v_scope_positions)) THEN
                RAISE EXCEPTION 'Mapping entry outside the invalidated scope: %',
                    v_pos USING ERRCODE = 'TL422';
            END IF;
            IF v_pos = ANY (v_seen_positions) THEN
                RAISE EXCEPTION 'Duplicate mapping entry for step %', v_pos
                    USING ERRCODE = 'TL422';
            END IF;
            v_seen_positions := v_seen_positions || v_pos;
            FOR v_elem IN
                SELECT * FROM jsonb_array_elements(v_entry->'ingredient_positions')
            LOOP
                IF jsonb_typeof(v_elem) IS DISTINCT FROM 'number' THEN
                    RAISE EXCEPTION 'Ingredient position is not a number'
                        USING ERRCODE = 'TL422';
                END IF;
                v_num := (v_elem#>>'{}')::NUMERIC;
                IF v_num IS DISTINCT FROM trunc(v_num)
                   OR v_num < 1
                   OR v_num > COALESCE(array_length(v_final_ing_ids, 1), 0) THEN
                    RAISE EXCEPTION 'Ingredient position out of range: %', v_elem
                        USING ERRCODE = 'TL422';
                END IF;
            END LOOP;
        END LOOP;
    END IF;

    -- ---------------------------------------------------------------
    -- Apply the explicit content operations (per-row-by-id; only the
    -- patched fields; raw_text NULLed only on semantically-changed
    -- rows; dense position rewrite from order arrays).
    -- ---------------------------------------------------------------
    IF p_ops ? 'fields' THEN
        v_fields := p_ops->'fields';
        UPDATE recipes SET
            title = CASE WHEN v_fields ? 'title'
                THEN v_fields->>'title' ELSE title END,
            servings = CASE WHEN v_fields ? 'servings'
                THEN v_fields->>'servings' ELSE servings END,
            prep_time = CASE WHEN v_fields ? 'prep_time'
                THEN v_fields->>'prep_time' ELSE prep_time END,
            cook_time = CASE WHEN v_fields ? 'cook_time'
                THEN v_fields->>'cook_time' ELSE cook_time END
        WHERE id = p_recipe_id;
    END IF;

    -- Ingredient updates: touch ONLY semantically-changed rows. A row
    -- whose patch equals its current values keeps every stored byte
    -- (raw_text included).
    IF p_ops ? 'ingredients' AND (p_ops->'ingredients') ? 'update' THEN
        FOR v_entry IN
            SELECT * FROM jsonb_array_elements(p_ops->'ingredients'->'update')
        LOOP
            v_id := (v_entry->>'id')::UUID;
            CONTINUE WHEN NOT (v_ing_changed_rows ? v_id::text);
            v_entry_fields := v_entry->'fields';
            UPDATE recipe_ingredients SET
                name = CASE WHEN v_entry_fields ? 'name'
                    THEN v_entry_fields->>'name' ELSE name END,
                quantity = CASE WHEN v_entry_fields ? 'quantity'
                    THEN v_entry_fields->>'quantity' ELSE quantity END,
                unit = CASE WHEN v_entry_fields ? 'unit'
                    THEN v_entry_fields->>'unit' ELSE unit END,
                prep = CASE WHEN v_entry_fields ? 'prep'
                    THEN v_entry_fields->>'prep' ELSE prep END,
                raw_text = NULL
            WHERE id = v_id AND recipe_id = p_recipe_id;
        END LOOP;
    END IF;

    IF p_ops ? 'steps' AND (p_ops->'steps') ? 'update' THEN
        FOR v_entry IN
            SELECT * FROM jsonb_array_elements(p_ops->'steps'->'update')
        LOOP
            v_id := (v_entry->>'id')::UUID;
            CONTINUE WHEN NOT (v_step_changed_rows ? v_id::text);
            v_entry_fields := v_entry->'fields';
            UPDATE recipe_steps SET
                instruction = v_entry_fields->>'instruction'
            WHERE id = v_id AND recipe_id = p_recipe_id;
        END LOOP;
    END IF;

    -- Deletes. Association cascades fire the 026 demotion trigger for
    -- referencing steps; the explicit scope demotion below covers the
    -- same ground deterministically.
    IF COALESCE(array_length(v_ing_delete_ids, 1), 0) > 0 THEN
        DELETE FROM recipe_ingredients
        WHERE recipe_id = p_recipe_id AND id = ANY (v_ing_delete_ids);
    END IF;
    IF COALESCE(array_length(v_step_delete_ids, 1), 0) > 0 THEN
        DELETE FROM recipe_steps
        WHERE recipe_id = p_recipe_id AND id = ANY (v_step_delete_ids);
    END IF;

    -- Creates + dense position rewrite. When an order array is present it
    -- IS the final dense 1-based order; temp ids resolve to freshly
    -- inserted rows in place. When absent (membership unchanged, no
    -- reorder), stored positions are untouched.
    IF v_ing_order IS NOT NULL THEN
        v_create_by_temp := '{}'::jsonb;
        IF p_ops ? 'ingredients' AND (p_ops->'ingredients') ? 'create' THEN
            FOR v_entry IN
                SELECT * FROM jsonb_array_elements(p_ops->'ingredients'->'create')
            LOOP
                v_create_by_temp := v_create_by_temp
                    || jsonb_build_object(v_entry->>'temp_id', v_entry);
            END LOOP;
        END IF;
        FOR v_idx IN 1 .. COALESCE(array_length(v_ing_order, 1), 0)
        LOOP
            v_id := v_ing_order[v_idx];
            IF v_create_by_temp ? v_id::text THEN
                v_entry := v_create_by_temp->(v_id::text);
                INSERT INTO recipe_ingredients
                    (recipe_id, position, quantity, unit, name, prep)
                VALUES (
                    p_recipe_id, v_idx,
                    v_entry->>'quantity',
                    v_entry->>'unit',
                    v_entry->>'name',
                    v_entry->>'prep'
                )
                RETURNING id INTO v_new_id;
                v_ing_order[v_idx] := v_new_id;
            ELSE
                UPDATE recipe_ingredients SET position = v_idx
                WHERE id = v_id AND recipe_id = p_recipe_id
                  AND position IS DISTINCT FROM v_idx;
            END IF;
        END LOOP;
        v_final_ing_ids := v_ing_order;
    END IF;

    IF v_step_order IS NOT NULL THEN
        v_create_by_temp := '{}'::jsonb;
        IF p_ops ? 'steps' AND (p_ops->'steps') ? 'create' THEN
            FOR v_entry IN
                SELECT * FROM jsonb_array_elements(p_ops->'steps'->'create')
            LOOP
                v_create_by_temp := v_create_by_temp
                    || jsonb_build_object(v_entry->>'temp_id', v_entry);
            END LOOP;
        END IF;
        FOR v_idx IN 1 .. COALESCE(array_length(v_step_order, 1), 0)
        LOOP
            v_id := v_step_order[v_idx];
            IF v_create_by_temp ? v_id::text THEN
                v_entry := v_create_by_temp->(v_id::text);
                INSERT INTO recipe_steps (recipe_id, position, instruction)
                VALUES (p_recipe_id, v_idx, v_entry->>'instruction')
                RETURNING id INTO v_new_id;
                v_step_order[v_idx] := v_new_id;
            ELSE
                UPDATE recipe_steps SET position = v_idx
                WHERE id = v_id AND recipe_id = p_recipe_id
                  AND position IS DISTINCT FROM v_idx;
            END IF;
        END LOOP;
        v_final_step_ids := v_step_order;
    END IF;

    -- ---------------------------------------------------------------
    -- Complete-candidate validation (defense in depth): the FULL
    -- post-edit state must be well-formed, including rows this request
    -- never touched (a legacy blank row must fail closed, not survive
    -- an unrelated edit). Raising here rolls the whole transaction
    -- back, so TL422 still means zero mutation.
    -- ---------------------------------------------------------------
    IF (SELECT btrim(title) = '' FROM recipes WHERE id = p_recipe_id) THEN
        RAISE EXCEPTION 'Candidate title cannot be empty'
            USING ERRCODE = 'TL422';
    END IF;
    PERFORM 1 FROM recipe_ingredients
    WHERE recipe_id = p_recipe_id AND btrim(name) = '';
    IF FOUND THEN
        RAISE EXCEPTION 'Candidate ingredient name cannot be empty'
            USING ERRCODE = 'TL422';
    END IF;
    PERFORM 1 FROM recipe_steps
    WHERE recipe_id = p_recipe_id AND btrim(instruction) = '';
    IF FOUND THEN
        RAISE EXCEPTION 'Candidate step instruction cannot be empty'
            USING ERRCODE = 'TL422';
    END IF;

    -- ---------------------------------------------------------------
    -- Mapping: DEMOTE the complete invalidated scope FIRST, then
    -- PROMOTE only the fresh validated results (plan section 8.3).
    -- Steps outside the scope keep their authority untouched.
    -- ---------------------------------------------------------------
    IF COALESCE(array_length(v_scope_positions, 1), 0) > 0 THEN
        FOREACH v_pos IN ARRAY v_scope_positions
        LOOP
            v_step_id := v_final_step_ids[v_pos];
            UPDATE recipe_steps SET ingredient_mapping_version = NULL
            WHERE id = v_step_id;
            DELETE FROM recipe_step_ingredients WHERE step_id = v_step_id;
        END LOOP;

        IF p_mappings IS NOT NULL THEN
            FOR v_entry IN SELECT * FROM jsonb_array_elements(p_mappings)
            LOOP
                v_pos := (v_entry->>'step_position')::NUMERIC::INT;
                v_step_id := v_final_step_ids[v_pos];
                FOR v_elem IN
                    SELECT * FROM jsonb_array_elements(
                        v_entry->'ingredient_positions')
                LOOP
                    INSERT INTO recipe_step_ingredients
                        (recipe_id, step_id, ingredient_id)
                    VALUES (
                        p_recipe_id, v_step_id,
                        v_final_ing_ids[(v_elem#>>'{}')::NUMERIC::INT]
                    )
                    ON CONFLICT DO NOTHING;
                END LOOP;
                UPDATE recipe_steps SET ingredient_mapping_version = 1
                WHERE id = v_step_id;
                v_promoted := v_promoted + 1;
            END LOOP;
        END IF;

        v_outcome := CASE
            WHEN v_promoted = 0 THEN 'degraded'
            WHEN v_promoted = array_length(v_scope_positions, 1)
                THEN 'complete'
            ELSE 'partial'
        END;
    END IF;

    -- ---------------------------------------------------------------
    -- Revision advance + idempotency identity + outcome, atomically
    -- with everything above.
    -- ---------------------------------------------------------------
    UPDATE recipes SET
        content_rev = content_rev + 1,
        last_content_mutation_id = p_mutation_id,
        updated_at = NOW(),
        step_mapping_outcome = CASE
            WHEN v_outcome IS NOT NULL THEN v_outcome
            ELSE step_mapping_outcome
        END
    WHERE id = p_recipe_id;

    RETURN jsonb_build_object(
        'status', 'updated',
        'recipe_id', p_recipe_id,
        'content_rev', v_recipe.content_rev + 1
    );

EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        -- A malformed uuid or a numeric value outside the castable range
        -- anywhere in the payload. The plpgsql block rollback guarantees
        -- zero mutation.
        RAISE EXCEPTION 'Invalid operation payload value'
            USING ERRCODE = 'TL422';
END;
$$;

REVOKE ALL ON FUNCTION
    update_recipe_content(UUID, UUID, INTEGER, UUID, JSONB, JSONB, JSONB)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION
    update_recipe_content(UUID, UUID, INTEGER, UUID, JSONB, JSONB, JSONB)
    FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION
    update_recipe_content(UUID, UUID, INTEGER, UUID, JSONB, JSONB, JSONB)
    TO service_role;

-- ---------------------------------------------------------------------------
-- 5. attach_step_ingredient_mapping re-issue: content_rev freshness guard
-- ---------------------------------------------------------------------------

-- The 2-parameter form is replaced by a 3-parameter form whose content_rev
-- precondition (TL428) refuses a mapping computed against superseded
-- content. Everything else is the 026 body unchanged; the 026 service-role-
-- only EXECUTE posture is restored verbatim below. During the rollout
-- window an old-code 2-arg call fails into apply_step_mapping's
-- never-raises boundary ('degraded'), which is the designed behavior.
DROP FUNCTION attach_step_ingredient_mapping(UUID, JSONB);

CREATE FUNCTION attach_step_ingredient_mapping(
    p_recipe_id UUID,
    p_expected_content_rev INTEGER,
    p_mappings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_content_rev INTEGER;
    v_step_ids UUID[];
    v_ingredient_ids UUID[];
    v_step_count INT;
    v_ingredient_count INT;
    v_entry JSONB;
    v_step_num NUMERIC;
    v_ing_num NUMERIC;
    v_step_pos INT;
    v_ing_elem JSONB;
    v_step_id UUID;
    v_seen_steps INT[] := '{}';
    v_steps_mapped INT := 0;
BEGIN
    IF p_mappings IS NULL OR jsonb_typeof(p_mappings) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Invalid mappings payload: expected array'
            USING ERRCODE = '22023';
    END IF;

    -- Serialize replacement at recipe scope: two concurrent attaches must
    -- produce one winner's replacement, never a union of both. Lock order
    -- is recipes -> recipe_step_ingredients -> recipe_steps, no path ever
    -- locks two recipes, and the creation RPCs hold their new recipe row's
    -- insert lock before any child write, so there is no self-created
    -- deadlock path.
    SELECT content_rev INTO v_content_rev
    FROM recipes WHERE id = p_recipe_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Recipe not found'
            USING ERRCODE = '22023';
    END IF;

    -- Freshness precondition: a mapping computed for revision N must not
    -- promote after an edit committed N+1. The caller maps this stale
    -- refusal to a degraded outcome inside its never-raises boundary.
    IF v_content_rev IS DISTINCT FROM p_expected_content_rev THEN
        RAISE EXCEPTION 'Stale content revision for mapping attach'
            USING ERRCODE = 'TL428';
    END IF;

    SELECT array_agg(id ORDER BY position) INTO v_step_ids
    FROM recipe_steps WHERE recipe_id = p_recipe_id;

    SELECT array_agg(id ORDER BY position) INTO v_ingredient_ids
    FROM recipe_ingredients WHERE recipe_id = p_recipe_id;

    IF v_step_ids IS NULL THEN
        RAISE EXCEPTION 'Recipe has no steps to map'
            USING ERRCODE = '22023';
    END IF;
    v_step_count := array_length(v_step_ids, 1);
    v_ingredient_count := COALESCE(array_length(v_ingredient_ids, 1), 0);

    -- PASS 1: validate EVERY entry before ANY mutation. NULL-safe by
    -- construction: every type check uses IS DISTINCT FROM (SQL NULL can
    -- never skip a branch into authority), required keys must be
    -- explicitly present, types are proven before any cast, positions
    -- must be strictly integral JSON numbers in range, and duplicate
    -- step entries are rejected outright.
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_mappings)
    LOOP
        IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
           OR NOT (v_entry ? 'step_position')
           OR NOT (v_entry ? 'ingredient_positions')
           OR jsonb_typeof(v_entry->'step_position') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_entry->'ingredient_positions') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'Invalid mapping entry shape'
                USING ERRCODE = '22023';
        END IF;

        v_step_num := (v_entry->>'step_position')::NUMERIC;
        IF v_step_num IS DISTINCT FROM trunc(v_step_num)
           OR v_step_num < 1
           OR v_step_num > v_step_count THEN
            RAISE EXCEPTION 'Step position out of range: %',
                v_entry->>'step_position'
                USING ERRCODE = '22023';
        END IF;
        v_step_pos := v_step_num::INT;

        IF v_step_pos = ANY (v_seen_steps) THEN
            RAISE EXCEPTION 'Duplicate mapping entry for step %', v_step_pos
                USING ERRCODE = '22023';
        END IF;
        v_seen_steps := v_seen_steps || v_step_pos;

        FOR v_ing_elem IN SELECT * FROM jsonb_array_elements(v_entry->'ingredient_positions')
        LOOP
            IF jsonb_typeof(v_ing_elem) IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'Ingredient position is not a number'
                    USING ERRCODE = '22023';
            END IF;
            v_ing_num := (v_ing_elem#>>'{}')::NUMERIC;
            IF v_ing_num IS DISTINCT FROM trunc(v_ing_num)
               OR v_ing_num < 1
               OR v_ing_num > v_ingredient_count THEN
                RAISE EXCEPTION 'Ingredient position out of range: %', v_ing_elem
                    USING ERRCODE = '22023';
            END IF;
        END LOOP;
    END LOOP;

    -- PASS 2: mutate. Every entry was proven valid above, so the only
    -- remaining failure class is a constraint violation, which still
    -- rolls back the entire attach. Per step: replace the association
    -- set (the delete trigger demotes; the version UPDATE below is the
    -- final statement for the step, so the transaction ends at
    -- authoritative version 1).
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_mappings)
    LOOP
        v_step_pos := (v_entry->>'step_position')::NUMERIC::INT;
        v_step_id := v_step_ids[v_step_pos];

        DELETE FROM recipe_step_ingredients WHERE step_id = v_step_id;

        FOR v_ing_elem IN SELECT * FROM jsonb_array_elements(v_entry->'ingredient_positions')
        LOOP
            -- Duplicates within one entry were deduped upstream (dedupe is
            -- the one allowed normalization); ON CONFLICT keeps a stray
            -- duplicate from failing an otherwise valid attach.
            INSERT INTO recipe_step_ingredients (recipe_id, step_id, ingredient_id)
            VALUES (
                p_recipe_id, v_step_id,
                v_ingredient_ids[(v_ing_elem#>>'{}')::NUMERIC::INT]
            )
            ON CONFLICT DO NOTHING;
        END LOOP;

        UPDATE recipe_steps
        SET ingredient_mapping_version = 1
        WHERE id = v_step_id;

        v_steps_mapped := v_steps_mapped + 1;
    END LOOP;

    RETURN jsonb_build_object('status', 'attached', 'steps_mapped', v_steps_mapped);
END;
$$;

-- Service-role only: this is a write primitive, never client-callable.
-- (026:334 posture restored verbatim for the new signature.)
REVOKE EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, INTEGER, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, INTEGER, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, INTEGER, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Privilege hardening: content_rev/CAS cannot be bypassed by ordinary
--    end-user direct DML (plan section 6.3)
-- ---------------------------------------------------------------------------

-- The four recipe content tables have NO legitimate anon/authenticated DML
-- anywhere (API service-role table ops + SECURITY DEFINER RPCs only).
-- SELECT is deliberately untouched: the authenticated visibility check on
-- recipes (api/routes/riff.py) must survive. capture_tokens is a different
-- table and is unaffected.
REVOKE INSERT, UPDATE, DELETE
    ON recipes, recipe_ingredients, recipe_steps, recipe_step_ingredients
    FROM PUBLIC, anon, authenticated;

-- A separately-granted COLUMN privilege survives a table-level REVOKE, so
-- sweep column-level write ACLs too (SELECT is deliberately untouched).
-- Repo truth holds no such grant; this closes the effective-privilege gap
-- fail-closed regardless of prod ACL history.
DO $$
DECLARE
    v_table TEXT;
    v_cols TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'recipes', 'recipe_ingredients', 'recipe_steps',
        'recipe_step_ingredients'
    ]
    LOOP
        SELECT string_agg(quote_ident(attname), ', ') INTO v_cols
        FROM pg_attribute
        WHERE attrelid = v_table::regclass
          AND attnum > 0
          AND NOT attisdropped;
        EXECUTE format(
            'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
            'ON %2$I FROM PUBLIC, anon, authenticated',
            v_cols, v_table
        );
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. PostgREST schema cache reload
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
