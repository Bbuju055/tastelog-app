-- migrations/013_multi_image_drafts.sql
-- Multi-image capture: recipe_drafts stores an array of storage keys
-- instead of a single key. confirm_recipe_draft RPC updated to extract
-- the first element for recipes.image_path.
--
-- NOTE: This is a hard cut — non-reversible. Rollback would require
-- manually recreating the old column and RPC.

-- =========================================================================
-- Part 1: Column migration  (image_storage_key TEXT → image_storage_keys JSONB)
-- =========================================================================

-- 1a. Add new JSONB column (nullable initially for backfill)
ALTER TABLE recipe_drafts ADD COLUMN image_storage_keys JSONB;

-- 1b. Backfill: wrap existing single key in a 1-element array
-- (image_storage_key is NOT NULL, so no WHERE filter needed)
UPDATE recipe_drafts
SET image_storage_keys = jsonb_build_array(image_storage_key);

-- 1c. Set default, NOT NULL, and non-empty constraint
ALTER TABLE recipe_drafts
  ALTER COLUMN image_storage_keys SET DEFAULT '[]'::jsonb,
  ALTER COLUMN image_storage_keys SET NOT NULL;

ALTER TABLE recipe_drafts
  ADD CONSTRAINT image_storage_keys_not_empty
  CHECK (jsonb_array_length(image_storage_keys) > 0);

-- 1d. Drop old column
ALTER TABLE recipe_drafts DROP COLUMN image_storage_key;

-- =========================================================================
-- Part 2: Replace confirm_recipe_draft RPC
-- =========================================================================
-- Changes from 006:
--   - v_draft.image_storage_key → v_draft.image_storage_keys->>0
--   - Added empty-array guard before INSERT

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
BEGIN
    -- 0. Get authenticated user from Supabase session
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated'
            USING ERRCODE = 'P0003';
    END IF;

    -- 1. Fetch and lock draft
    SELECT * INTO v_draft
    FROM recipe_drafts
    WHERE id = p_draft_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft not found or not owned by user'
            USING ERRCODE = 'P0002';
    END IF;

    -- 2. Block expired drafts
    IF v_draft.expires_at < NOW() THEN
        RAISE EXCEPTION 'Draft has expired'
            USING ERRCODE = 'P0001';
    END IF;

    -- 3. Guard: draft must have at least one image
    IF jsonb_array_length(v_draft.image_storage_keys) = 0 THEN
        RAISE EXCEPTION 'Draft has no images'
            USING ERRCODE = 'P0004';
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
        RAISE EXCEPTION 'Invalid ingredients payload: expected array'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_final_steps) != 'array' THEN
        RAISE EXCEPTION 'Invalid steps payload: expected array'
            USING ERRCODE = '22023';
    END IF;

    -- 6. Insert recipe — first image from array becomes the hero image
    INSERT INTO recipes (
        user_id, title, image_path, servings, prep_time, cook_time,
        confidence_score
    ) VALUES (
        v_user_id, v_final_title, v_draft.image_storage_keys->>0,
        v_final_servings, v_final_prep_time, v_final_cook_time,
        v_draft.confidence_score
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

    -- 10. Return result
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

-- Re-grant (signature unchanged, but CREATE OR REPLACE may reset grants)
GRANT EXECUTE ON FUNCTION confirm_recipe_draft(
    UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) TO authenticated;
