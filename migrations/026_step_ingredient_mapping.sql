-- migrations/026_step_ingredient_mapping.sql
-- Issue 1: Durable step-ingredient context for Cooking Mode.
--
-- Adds the durable step↔ingredient association contract:
--   1. UNIQUE (id, recipe_id) on recipe_steps + recipe_ingredients so the
--      mapping table can carry composite same-recipe foreign keys. Three
--      independent FKs cannot prove the step and ingredient belong to the
--      same recipe; the composite FKs make a cross-recipe association a
--      database constraint violation regardless of application bugs.
--   2. recipe_steps.ingredient_mapping_version: per-step authority state:
--        NULL = unknown/legacy (renderer falls back to the text matcher)
--        1    = authoritative (join rows are truth; zero rows = the step
--               authoritatively uses no ingredients)
--   3. recipes.step_mapping_outcome: internal evidence only, never on the
--      wire: NULL = pre-feature legacy; 'pending' = created by mapping-aware
--      code, attach not yet run; 'complete'/'partial'/'degraded' terminal.
--   4. recipes.source_riff_message_id: idempotency identity for the
--      recipe-anchored Riff save (riff_messages.id is UUID PK; migration
--      018). UNIQUE: a retry after an ambiguous timeout resolves to the
--      existing recipe instead of creating a duplicate.
--   5. recipe_step_ingredients: the association table.
--   6. Invalidation triggers: association deletion demotes the affected
--      step to unknown (a cascade from an ingredient delete can never
--      silently produce an authoritative-empty step); a later ingredient
--      insertion demotes the whole recipe's steps (an old mapping that
--      never considered the new row must not stay authoritative). Initial
--      creation is inherently safe: every persistence path inserts
--      ingredients BEFORE steps (confirm_recipe_draft §7→§8,
--      save_draft_riff_recipe §7→§8, capture_recipe, save_riff_recipe_atomic
--      below), so the ingredient-insert trigger fires while zero step rows
--      exist and is a no-op.
--   7. attach_step_ingredient_mapping: the ONLY promotion path to
--      authoritative state. One transaction: per step, replace join rows
--      and set version 1 as the final statement (overwriting the delete
--      trigger's demotion inside the same transaction). Any invalid
--      position or constraint violation rolls back the whole attach: the
--      recipe stays intact and its steps stay unknown.
--   8. save_riff_recipe_atomic: atomic, idempotent recipe-anchored Riff
--      base save (replaces the non-transactional Python inserts).
--   9. confirm_recipe_draft re-issued with the SAME signature; the only
--      body change is stamping step_mapping_outcome when (and only when)
--      the draft actually carries mapping data, so recipes confirmed by a
--      pre-mapping API during the rollout window keep legacy semantics.
--  10. save_draft_riff_recipe re-issued with the SAME signature; stamps
--      source_riff_message_id + step_mapping_outcome = 'pending'.

-- ---------------------------------------------------------------------------
-- 1. Composite identity backing for same-recipe FKs
-- ---------------------------------------------------------------------------

ALTER TABLE recipe_steps
    ADD CONSTRAINT recipe_steps_id_recipe_unique UNIQUE (id, recipe_id);

ALTER TABLE recipe_ingredients
    ADD CONSTRAINT recipe_ingredients_id_recipe_unique UNIQUE (id, recipe_id);

-- ---------------------------------------------------------------------------
-- 2-4. State columns
-- ---------------------------------------------------------------------------

-- Version 1 is the only defined authority model; the read path treats any
-- non-NULL value as authoritative, so the database must reject undefined
-- versions instead of letting them silently become authority.
ALTER TABLE recipe_steps
    ADD COLUMN ingredient_mapping_version SMALLINT
        CONSTRAINT recipe_steps_mapping_version_check
        CHECK (ingredient_mapping_version IS NULL OR ingredient_mapping_version = 1);

ALTER TABLE recipes
    ADD COLUMN step_mapping_outcome TEXT
        CONSTRAINT recipes_step_mapping_outcome_check
        CHECK (step_mapping_outcome IN ('pending', 'complete', 'partial', 'degraded'));

-- Deliberately NOT a foreign key: this is the durable idempotency identity
-- for the riff save. riff_messages rows are deletable (session delete
-- policy; recipe delete -> session cascade -> message cascade), and an FK
-- ON DELETE SET NULL would erase the consumed identity with them, letting
-- a retry or identity reuse after such a deletion duplicate a recipe. The
-- identity lives exactly as long as the saved recipe itself.
ALTER TABLE recipes
    ADD COLUMN source_riff_message_id UUID
        CONSTRAINT recipes_source_riff_message_unique UNIQUE;

-- ---------------------------------------------------------------------------
-- 5. Association table (composite same-recipe FKs, no standalone child FKs)
-- ---------------------------------------------------------------------------

CREATE TABLE recipe_step_ingredients (
    recipe_id     UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    step_id       UUID NOT NULL,
    ingredient_id UUID NOT NULL,
    PRIMARY KEY (recipe_id, step_id, ingredient_id),
    FOREIGN KEY (step_id, recipe_id)
        REFERENCES recipe_steps(id, recipe_id) ON DELETE CASCADE,
    FOREIGN KEY (ingredient_id, recipe_id)
        REFERENCES recipe_ingredients(id, recipe_id) ON DELETE CASCADE
);

-- Composite FKs do not auto-index; cascades and per-step replacement both
-- filter on the child columns.
CREATE INDEX idx_recipe_step_ingredients_step ON recipe_step_ingredients(step_id);
CREATE INDEX idx_recipe_step_ingredients_ingredient ON recipe_step_ingredients(ingredient_id);

ALTER TABLE recipe_step_ingredients ENABLE ROW LEVEL SECURITY;

-- SELECT-own only (mirrors riff_usage_daily posture): all writes go through
-- the service role / SECURITY DEFINER functions below; no INSERT/UPDATE/
-- DELETE policies exist on purpose.
CREATE POLICY recipe_step_ingredients_select ON recipe_step_ingredients FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM recipes r
            WHERE r.id = recipe_step_ingredients.recipe_id
              AND r.user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- 6. Invalidation triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION invalidate_step_mapping_on_association_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Deleting an association (directly, or via an ingredient-delete
    -- cascade) means the step's authoritative set is no longer what was
    -- attached: demote to unknown. attach_step_ingredient_mapping's
    -- replacement flow re-promotes as its final statement, so a mapping
    -- replacement still ends at version 1 inside one transaction. During
    -- a full recipe cascade the step row may already be gone; the UPDATE
    -- then matches nothing, which is fine.
    UPDATE recipe_steps
    SET ingredient_mapping_version = NULL
    WHERE id = OLD.step_id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_step_mapping_association_delete
    AFTER DELETE ON recipe_step_ingredients
    FOR EACH ROW
    EXECUTE FUNCTION invalidate_step_mapping_on_association_delete();

CREATE OR REPLACE FUNCTION invalidate_step_mapping_on_ingredient_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- An ingredient added after a mapping was attached leaves that mapping
    -- falsely authoritative (it never considered the new row): demote every
    -- step of the recipe to unknown. Initial creation is inherently safe:
    -- all persistence paths insert ingredients before steps, so this UPDATE
    -- matches zero rows during creation.
    --
    -- The recipe-row lock serializes this demotion against
    -- attach_step_ingredient_mapping (which takes the same lock first):
    -- an insert can therefore never slip its demotion in between attach's
    -- replacement and attach's final version UPDATE, and attach can never
    -- re-promote a mapping that a concurrent insert just invalidated.
    -- Same lock order as attach (recipes -> recipe_steps); creation paths
    -- already hold their new recipe row's insert lock, so this is a no-op
    -- for them.
    PERFORM 1 FROM recipes WHERE id = NEW.recipe_id FOR UPDATE;

    UPDATE recipe_steps
    SET ingredient_mapping_version = NULL
    WHERE recipe_id = NEW.recipe_id
      AND ingredient_mapping_version IS NOT NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_step_mapping_ingredient_insert
    AFTER INSERT ON recipe_ingredients
    FOR EACH ROW
    EXECUTE FUNCTION invalidate_step_mapping_on_ingredient_insert();

-- ---------------------------------------------------------------------------
-- 7. Atomic mapping attachment: the only promotion path
-- ---------------------------------------------------------------------------

-- p_mappings: JSONB array of {"step_position": int, "ingredient_positions": [int, ...]}
-- Positions are 1-based indexes into the recipe's canonical position order.
-- Steps absent from the payload are untouched (stay unknown). An entry with
-- an empty ingredient_positions array promotes the step to authoritative
-- empty. Any invalid position, non-integer value, or constraint violation
-- raises and rolls back the ENTIRE attach: nothing is ever partially or
-- silently sanitized into authority.
CREATE OR REPLACE FUNCTION attach_step_ingredient_mapping(
    p_recipe_id UUID,
    p_mappings JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
    PERFORM 1 FROM recipes WHERE id = p_recipe_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Recipe not found'
            USING ERRCODE = '22023';
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
REVOKE EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION attach_step_ingredient_mapping(UUID, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Atomic, idempotent recipe-anchored Riff base save
-- ---------------------------------------------------------------------------

-- Replaces the non-transactional Python inserts of save_riff_recipe.
-- The route pre-validates ownership/session/message/generated_recipe
-- exactly as before; this function re-checks the essentials under
-- auth.uid() (mirrors save_draft_riff_recipe's defense level) and makes
-- the base save one transaction with a database-enforced idempotency
-- identity: recipes.source_riff_message_id UNIQUE. A retry after an
-- ambiguous timeout finds the existing row and returns already_saved.
CREATE OR REPLACE FUNCTION save_riff_recipe_atomic(
    p_recipe_id UUID,
    p_session_id UUID,
    p_message_id UUID,
    p_riff_label TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_session_row record;
    v_message_row record;
    v_generated_recipe JSONB;
    v_new_recipe_id UUID;
    v_existing_id UUID;
    v_ingredient JSONB;
    v_step JSONB;
    v_position INT;
BEGIN
    -- 0. Auth: never trust client params for identity.
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0003';
    END IF;

    -- 1. Idempotency fast path.
    SELECT id INTO v_existing_id
    FROM recipes
    WHERE source_riff_message_id = p_message_id AND user_id = v_user_id;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'status', 'already_saved',
            'recipe_id', v_existing_id
        );
    END IF;

    -- 2. Session must exist, be owned, and anchor to the named recipe.
    SELECT id, user_id, source_recipe_id INTO v_session_row
    FROM riff_sessions
    WHERE id = p_session_id AND user_id = v_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Riff session not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_session_row.source_recipe_id IS DISTINCT FROM p_recipe_id THEN
        RAISE EXCEPTION 'Riff session does not belong to this recipe'
            USING ERRCODE = 'P0004';
    END IF;

    -- 2a. The source recipe itself must belong to the caller. The
    -- riff_sessions INSERT policy checks only user_id, so a direct
    -- authenticated caller could anchor an owned session to another
    -- user's recipe; this SECURITY DEFINER function must not mint
    -- cross-user lineage from that. The DB is the authority here; the
    -- HTTP route's ownership check is not sufficient on its own.
    PERFORM 1 FROM recipes
    WHERE id = p_recipe_id AND user_id = v_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Recipe not found' USING ERRCODE = 'P0002';
    END IF;

    -- 3. Message must belong to the session and carry a generated recipe.
    SELECT id, session_id, generated_recipe INTO v_message_row
    FROM riff_messages
    WHERE id = p_message_id AND session_id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Riff message not found' USING ERRCODE = 'P0002';
    END IF;
    v_generated_recipe := v_message_row.generated_recipe;
    IF v_generated_recipe IS NULL THEN
        RAISE EXCEPTION 'No generated recipe available' USING ERRCODE = '22023';
    END IF;

    -- 4. INSERT recipes. step_mapping_outcome = 'pending': the route runs
    -- the bounded mapper + attach after this commits; a crash in between
    -- leaves an honest pending/unknown recipe, never false authority.
    INSERT INTO recipes (
        user_id, title, servings, prep_time, cook_time,
        confidence_score,
        parent_recipe_id, riff_session_id, riff_label,
        source_riff_message_id, step_mapping_outcome
    ) VALUES (
        v_user_id,
        v_generated_recipe->>'title',
        v_generated_recipe->>'servings',
        v_generated_recipe->>'prep_time',
        v_generated_recipe->>'cook_time',
        (v_generated_recipe->>'confidence')::REAL,
        p_recipe_id,
        p_session_id,
        p_riff_label,
        p_message_id,
        'pending'
    ) RETURNING id INTO v_new_recipe_id;

    -- 5. INSERT recipe_ingredients (position from array order; no raw_text,
    -- mirroring save_riff_recipe's 13.2 semantics). MUST precede steps so the
    -- ingredient-insert invalidation trigger fires against zero step rows.
    v_position := 1;
    FOR v_ingredient IN
        SELECT * FROM jsonb_array_elements(v_generated_recipe->'ingredients')
    LOOP
        INSERT INTO recipe_ingredients
            (recipe_id, position, quantity, unit, name, prep)
        VALUES (
            v_new_recipe_id, v_position,
            v_ingredient->>'quantity',
            v_ingredient->>'unit',
            v_ingredient->>'name',
            v_ingredient->>'prep'
        );
        v_position := v_position + 1;
    END LOOP;

    -- 6. INSERT recipe_steps (version stays NULL until attach promotes).
    v_position := 1;
    FOR v_step IN
        SELECT * FROM jsonb_array_elements(v_generated_recipe->'steps')
    LOOP
        INSERT INTO recipe_steps (recipe_id, position, instruction)
        VALUES (v_new_recipe_id, v_position, v_step->>'instruction');
        v_position := v_position + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 'created',
        'recipe_id', v_new_recipe_id
    );

EXCEPTION
    WHEN unique_violation THEN
        -- Concurrent duplicate save of the same message: the UNIQUE
        -- constraint on source_riff_message_id is the serializer. Resolve
        -- to the winner's recipe.
        SELECT id INTO v_existing_id
        FROM recipes
        WHERE source_riff_message_id = p_message_id AND user_id = v_user_id;
        IF FOUND THEN
            RETURN jsonb_build_object(
                'status', 'already_saved',
                'recipe_id', v_existing_id
            );
        END IF;
        RAISE;
END;
$$;

REVOKE EXECUTE ON FUNCTION
    save_riff_recipe_atomic(UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
    save_riff_recipe_atomic(UUID, UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION
    save_riff_recipe_atomic(UUID, UUID, UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. confirm_recipe_draft: SAME signature, minimal body delta
-- ---------------------------------------------------------------------------

-- Byte-identical to the migration 014 version except the recipes INSERT
-- stamps step_mapping_outcome = 'pending' when (and only when) the draft's
-- raw_model_json carries the canonical mapping key. Drafts produced by a
-- pre-mapping parser therefore confirm with legacy NULL semantics in every
-- rollout window; build 3 calls through the backend with the same named
-- arguments as before.
CREATE OR REPLACE FUNCTION confirm_recipe_draft(
    p_draft_id UUID,
    p_title TEXT DEFAULT NULL,
    p_servings TEXT DEFAULT NULL,
    p_prep_time TEXT DEFAULT NULL,
    p_cook_time TEXT DEFAULT NULL,
    p_ingredients JSONB DEFAULT NULL,
    p_steps JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_draft recipe_drafts%ROWTYPE;
    v_recipe_id UUID;
    v_final_title TEXT;
    v_final_servings TEXT;
    v_final_prep_time TEXT;
    v_final_cook_time TEXT;
    v_final_ingredients JSONB;
    v_final_steps JSONB;
    v_ingredient JSONB;
    v_step JSONB;
    v_position INT;
    v_ingredient_count INT := 0;
    v_step_count INT := 0;
    v_mapping_outcome TEXT;
BEGIN
    -- 0. Auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0003';
    END IF;

    -- 1. Fetch and lock draft
    SELECT * INTO v_draft
    FROM recipe_drafts
    WHERE id = p_draft_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft not found or not owned by user' USING ERRCODE = 'P0002';
    END IF;

    -- 2. Block expired drafts
    IF v_draft.expires_at < NOW() THEN
        RAISE EXCEPTION 'Draft has expired' USING ERRCODE = 'P0001';
    END IF;

    -- 3. Guard: must have images OR source_url (relaxed from images-only)
    IF jsonb_array_length(v_draft.image_storage_keys) = 0 AND v_draft.source_url IS NULL THEN
        RAISE EXCEPTION 'Draft has no images or source URL' USING ERRCODE = 'P0004';
    END IF;

    -- 4. Apply overrides
    v_final_title := COALESCE(p_title, v_draft.title);
    v_final_servings := COALESCE(p_servings, v_draft.servings);
    v_final_prep_time := COALESCE(p_prep_time, v_draft.prep_time);
    v_final_cook_time := COALESCE(p_cook_time, v_draft.cook_time);
    v_final_ingredients := COALESCE(p_ingredients, v_draft.ingredients);
    v_final_steps := COALESCE(p_steps, v_draft.steps);

    -- 5. Validate JSON shapes
    IF jsonb_typeof(v_final_ingredients) != 'array' THEN
        RAISE EXCEPTION 'Invalid ingredients payload: expected array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_final_steps) != 'array' THEN
        RAISE EXCEPTION 'Invalid steps payload: expected array' USING ERRCODE = '22023';
    END IF;

    -- 5a. Mapping-aware drafts confirm as 'pending' (the API attaches the
    -- surviving mapping right after this RPC returns); legacy drafts stay
    -- NULL so they never read as crash-degraded.
    IF v_draft.raw_model_json IS NOT NULL
       AND v_draft.raw_model_json ? 'step_ingredient_positions' THEN
        v_mapping_outcome := 'pending';
    ELSE
        v_mapping_outcome := NULL;
    END IF;

    -- 6. Insert recipe (source_url from draft row, image_path NULL for URL captures)
    INSERT INTO recipes (
        user_id, title, image_path, source_url, servings, prep_time, cook_time,
        confidence_score, step_mapping_outcome
    ) VALUES (
        v_user_id, v_final_title, v_draft.image_storage_keys->>0,
        v_draft.source_url,
        v_final_servings, v_final_prep_time, v_final_cook_time,
        v_draft.confidence_score, v_mapping_outcome
    )
    RETURNING id INTO v_recipe_id;

    -- 7. Insert ingredients
    v_position := 1;
    FOR v_ingredient IN SELECT * FROM jsonb_array_elements(v_final_ingredients)
    LOOP
        INSERT INTO recipe_ingredients (
            recipe_id, position, quantity, unit, name, prep, raw_text
        ) VALUES (
            v_recipe_id, v_position,
            v_ingredient->>'quantity', v_ingredient->>'unit',
            v_ingredient->>'name', v_ingredient->>'prep', v_ingredient->>'raw_text'
        );
        v_position := v_position + 1;
        v_ingredient_count := v_ingredient_count + 1;
    END LOOP;

    -- 8. Insert steps
    v_position := 1;
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_final_steps)
    LOOP
        INSERT INTO recipe_steps (recipe_id, position, instruction)
        VALUES (v_recipe_id, v_position, v_step->>'instruction');
        v_position := v_position + 1;
        v_step_count := v_step_count + 1;
    END LOOP;

    -- 9. Delete draft
    DELETE FROM recipe_drafts WHERE id = p_draft_id;

    -- 10. Return result (byte-parity with migration 014: draft_id and
    -- committed_at are part of the established response contract)
    RETURN jsonb_build_object(
        'recipe_id', v_recipe_id,
        'draft_id', p_draft_id,
        'title', v_final_title,
        'ingredient_count', v_ingredient_count,
        'step_count', v_step_count,
        'committed_at', NOW()
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. save_draft_riff_recipe: SAME signature, minimal body delta
-- ---------------------------------------------------------------------------

-- Byte-identical to the migration 023 version except the recipes INSERT
-- stamps source_riff_message_id (uniform retry identity with the
-- recipe-anchored save) and step_mapping_outcome = 'pending' (the route
-- runs the save-time mapper + attach after the RPC returns).
CREATE OR REPLACE FUNCTION save_draft_riff_recipe(
    p_draft_id UUID,
    p_session_id UUID,
    p_message_id UUID,
    p_riff_label TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_session riff_sessions%ROWTYPE;
    v_draft_expires_at TIMESTAMPTZ;
    v_message_row record;
    v_generated_recipe JSONB;
    v_new_recipe_id UUID;
    v_ingredient JSONB;
    v_step JSONB;
    v_position INT;
BEGIN
    -- 0. Auth — NEVER trust client params for identity (mirrors
    -- confirm_recipe_draft).
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated'
            USING ERRCODE = 'P0003';
    END IF;

    -- 1. Lock the session row + validate ownership. SELECT FOR UPDATE
    -- serializes concurrent save attempts on the same session.
    SELECT * INTO v_session
    FROM riff_sessions
    WHERE id = p_session_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Riff session not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- 2. Idempotency check: if session is already recipe-anchored
    -- (source_draft_id IS NULL), return the existing recipe_id. The
    -- route maps this status to HTTP 409 ALREADY_SAVED.
    IF v_session.source_draft_id IS NULL THEN
        RETURN jsonb_build_object(
            'status', 'already_migrated',
            'recipe_id', v_session.source_recipe_id
        );
    END IF;

    -- 3. Verify the session is anchored to THIS draft (not a sibling).
    IF v_session.source_draft_id != p_draft_id THEN
        RAISE EXCEPTION 'Riff session not anchored to this draft'
            USING ERRCODE = 'P0002';
    END IF;

    -- 4. Validate draft ownership + expiry (per contract §3.4 per-turn
    -- boundary — save IS a per-turn boundary). Mirrors get_active_draft
    -- semantics: not-found and cross-user surface identically.
    SELECT expires_at INTO v_draft_expires_at
    FROM recipe_drafts
    WHERE id = p_draft_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_draft_expires_at <= NOW() THEN
        RAISE EXCEPTION 'Draft has expired'
            USING ERRCODE = 'P0001';
    END IF;

    -- 5. Load the target assistant message + verify session match +
    -- generated_recipe presence. Cross-session message → P0002 (404 —
    -- defensive, don't leak existence across sessions).
    SELECT id, session_id, generated_recipe INTO v_message_row
    FROM riff_messages
    WHERE id = p_message_id AND session_id = p_session_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Riff message not found'
            USING ERRCODE = 'P0002';
    END IF;

    v_generated_recipe := v_message_row.generated_recipe;
    IF v_generated_recipe IS NULL THEN
        RAISE EXCEPTION 'No generated recipe available'
            USING ERRCODE = '22023';
    END IF;

    -- 6. INSERT recipes — contract §3.1 step 2.
    -- parent_recipe_id = NULL per §3.1 (draft-anchored saves have no
    -- parent recipe; lineage flows through riff_session_id).
    -- image_path omitted — matches save_riff_recipe (Riff recipes are
    -- not image-derived).
    INSERT INTO recipes (
        user_id, title, servings, prep_time, cook_time,
        confidence_score,
        parent_recipe_id, riff_session_id, riff_label,
        source_riff_message_id, step_mapping_outcome
    ) VALUES (
        v_user_id,
        v_generated_recipe->>'title',
        v_generated_recipe->>'servings',
        v_generated_recipe->>'prep_time',
        v_generated_recipe->>'cook_time',
        (v_generated_recipe->>'confidence')::REAL,
        NULL,
        p_session_id,
        p_riff_label,
        p_message_id,
        'pending'
    ) RETURNING id INTO v_new_recipe_id;

    -- 7. INSERT recipe_ingredients (position derived from array order).
    -- Mirrors confirm_recipe_draft ingredient-loop pattern.
    v_position := 1;
    FOR v_ingredient IN
        SELECT * FROM jsonb_array_elements(v_generated_recipe->'ingredients')
    LOOP
        INSERT INTO recipe_ingredients
            (recipe_id, position, quantity, unit, name, prep)
        VALUES (
            v_new_recipe_id, v_position,
            v_ingredient->>'quantity',
            v_ingredient->>'unit',
            v_ingredient->>'name',
            v_ingredient->>'prep'
        );
        v_position := v_position + 1;
    END LOOP;

    -- 8. INSERT recipe_steps (position derived from array order).
    v_position := 1;
    FOR v_step IN
        SELECT * FROM jsonb_array_elements(v_generated_recipe->'steps')
    LOOP
        INSERT INTO recipe_steps (recipe_id, position, instruction)
        VALUES (
            v_new_recipe_id, v_position,
            v_step->>'instruction'
        );
        v_position := v_position + 1;
    END LOOP;

    -- 9. UPDATE riff_sessions — anchor migration (contract §3.1 step 3).
    -- MUST precede DELETE recipe_drafts (step 4). Clearing
    -- source_draft_id here means the FK ON DELETE CASCADE finds no
    -- session row referencing the draft when the DELETE fires; the
    -- session + its messages survive.
    --
    -- Slice A CHECK constraint (num_nonnulls(source_recipe_id,
    -- source_draft_id) = 1) is satisfied throughout — single-statement
    -- UPDATE atomically swaps the anchor, never observably anchorless.
    UPDATE riff_sessions
    SET source_draft_id = NULL,
        source_recipe_id = v_new_recipe_id
    WHERE id = p_session_id;

    -- 10. DELETE recipe_drafts — contract §3.1 step 4.
    DELETE FROM recipe_drafts WHERE id = p_draft_id;

    -- 11. Return — contract §3.1 step 5.
    RETURN jsonb_build_object(
        'status', 'created',
        'recipe_id', v_new_recipe_id
    );

EXCEPTION
    WHEN unique_violation THEN
        -- Concurrent duplicate save of the same message across paths: the
        -- UNIQUE constraint on recipes.source_riff_message_id serializes.
        SELECT id INTO v_new_recipe_id
        FROM recipes
        WHERE source_riff_message_id = p_message_id AND user_id = v_user_id;
        IF FOUND THEN
            RETURN jsonb_build_object(
                'status', 'already_migrated',
                'recipe_id', v_new_recipe_id
            );
        END IF;
        RAISE;
END;
$$;

-- Re-assert the 023 execute posture on the replaced function.
REVOKE EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. PostgREST schema cache reload
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
