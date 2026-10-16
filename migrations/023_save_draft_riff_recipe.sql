-- migrations/023_save_draft_riff_recipe.sql
-- Phase 13.9 Slice F — Atomic draft-Riff save.
--
-- Locked contract: docs/capture-draft-riff-contract.md §3.1 (5-step
-- atomic sequence) + §3.4 (per-turn expiry) + §9.1 (save rules).
--
-- Single Postgres transaction (function body): insert new recipe from
-- riff_messages.generated_recipe, migrate session anchor from draft to
-- new recipe, delete source draft. Mirrors confirm_recipe_draft pattern
-- from migration 006 (SECURITY DEFINER + SET search_path).
--
-- Step ordering is NON-NEGOTIABLE per §3.1:
--   1. SELECT FOR UPDATE riff_sessions row (lock + idempotency check)
--   2. Validate draft existence + ownership + expiry
--   3. Validate message + session match + generated_recipe presence
--   4. INSERT recipes (lineage: riff_session_id, parent_recipe_id NULL)
--   5. INSERT recipe_ingredients
--   6. INSERT recipe_steps
--   7. UPDATE riff_sessions: source_draft_id = NULL, source_recipe_id = new
--      MUST precede DELETE — otherwise FK ON DELETE CASCADE on
--      source_draft_id deletes the session + messages, losing lineage.
--   8. DELETE recipe_drafts
--   9. Return JSONB {status, recipe_id}
--
-- Idempotency: if SELECT FOR UPDATE finds the session already migrated
-- (source_draft_id IS NULL), return the existing recipe_id with
-- status='already_migrated'. The route translates to HTTP 409 with the
-- existing recipe_id in the detail body so mobile (Slices G+) can
-- navigate forward gracefully.
--
-- Save is NOT a billable Riff turn — no enforce_riff_daily_cap, no
-- record_riff_turn invocation (matches recipe save which also skips
-- cap accounting).

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
        parent_recipe_id, riff_session_id, riff_label
    ) VALUES (
        v_user_id,
        v_generated_recipe->>'title',
        v_generated_recipe->>'servings',
        v_generated_recipe->>'prep_time',
        v_generated_recipe->>'cook_time',
        (v_generated_recipe->>'confidence')::REAL,
        NULL,
        p_session_id,
        p_riff_label
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
    WHEN OTHERS THEN
        RAISE;  -- Postgres rolls back the entire transaction
END;
$$;

-- Lock down EXECUTE — only authenticated users via PostgREST (mirrors
-- confirm_recipe_draft). Anon explicitly revoked to silence
-- anon_security_definer_function_executable advisor.
REVOKE EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION
    save_draft_riff_recipe(UUID, UUID, UUID, TEXT) TO authenticated;
