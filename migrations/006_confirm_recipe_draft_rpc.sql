-- migrations/006_confirm_recipe_draft_rpc.sql
-- Atomic RPC to confirm a draft into a recipe
--
-- NOTE: Phase 2 intentionally introduces RPCs for atomic multi-table operations.
-- This is a deliberate change from Phase 1's "no RPC" constraint.
--
-- SECURITY: Uses auth.uid() for identity - NEVER trusts client-supplied user_id.
-- Auth context flows from Supabase session, not from API parameters.

CREATE OR REPLACE FUNCTION confirm_recipe_draft(
    p_draft_id UUID,
    -- User's edited payload (optional overrides)
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
    -- 0. Get authenticated user from Supabase session (NEVER from parameter)
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated'
            USING ERRCODE = 'P0003';
    END IF;

    -- 1. Fetch and lock draft (SELECT FOR UPDATE prevents race conditions)
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

    -- 3. Apply overrides (user edits from confirm request)
    v_final_title := COALESCE(p_title, v_draft.title);
    v_final_servings := COALESCE(p_servings, v_draft.servings);
    v_final_prep_time := COALESCE(p_prep_time, v_draft.prep_time);
    v_final_cook_time := COALESCE(p_cook_time, v_draft.cook_time);
    v_final_ingredients := COALESCE(p_ingredients, v_draft.ingredients);
    v_final_steps := COALESCE(p_steps, v_draft.steps);

    -- 4. Validate JSON shapes (defense in depth - don't trust upstream)
    IF jsonb_typeof(v_final_ingredients) != 'array' THEN
        RAISE EXCEPTION 'Invalid ingredients payload: expected array'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_final_steps) != 'array' THEN
        RAISE EXCEPTION 'Invalid steps payload: expected array'
            USING ERRCODE = '22023';
    END IF;

    -- 5. Insert recipe (user_id from auth.uid(), not parameter)
    INSERT INTO recipes (
        user_id, title, image_path, servings, prep_time, cook_time,
        confidence_score
    ) VALUES (
        v_user_id, v_final_title, v_draft.image_storage_key,
        v_final_servings, v_final_prep_time, v_final_cook_time,
        v_draft.confidence_score
    )
    RETURNING id INTO v_recipe_id;

    -- 6. Insert ingredients (position derived from array order)
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

    -- 7. Insert steps (position derived from array order, NOT from JSON)
    v_position := 1;
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_final_steps)
    LOOP
        INSERT INTO recipe_steps (recipe_id, position, instruction)
        VALUES (v_recipe_id, v_position, v_step->>'instruction');
        v_position := v_position + 1;
        v_step_count := v_step_count + 1;
    END LOOP;

    -- 8. Delete draft (storage object now owned by recipe)
    DELETE FROM recipe_drafts WHERE id = p_draft_id;

    -- 9. Return comprehensive result for idempotency + UX
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
        RAISE;  -- Transaction automatically rolls back
END;
$$;

-- Grant execute to authenticated users only (full signature required)
GRANT EXECUTE ON FUNCTION confirm_recipe_draft(
    UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
) TO authenticated;
