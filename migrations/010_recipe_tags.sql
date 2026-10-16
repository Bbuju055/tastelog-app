-- Migration 010: Recipe Tags
-- Normalized join table for user-defined recipe tags.
-- Tags are free-form strings scoped per recipe (no global tags table).
-- Dedup is case-insensitive via UNIQUE constraint on (recipe_id, lower(tag)).
-- Display casing is preserved as-entered.

CREATE TABLE recipe_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK (char_length(trim(tag)) BETWEEN 1 AND 50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness: preserves display casing, prevents duplicates.
CREATE UNIQUE INDEX uq_recipe_tags_recipe_tag
    ON recipe_tags (recipe_id, lower(tag));

-- Fast lookup by recipe (used by get_recipe, list_recipes tag aggregation).
CREATE INDEX idx_recipe_tags_recipe_id
    ON recipe_tags (recipe_id);

-- Fast lookup by tag value (used by tag filtering on recipe list).
CREATE INDEX idx_recipe_tags_tag_lower
    ON recipe_tags (lower(tag));

-- RLS: mirror recipes table ownership model via parent join.
ALTER TABLE recipe_tags ENABLE ROW LEVEL SECURITY;

-- Allow users to read tags for their own recipes
CREATE POLICY "Users can read their recipe tags"
ON recipe_tags
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM recipes
        WHERE recipes.id = recipe_tags.recipe_id
          AND recipes.user_id = auth.uid()
    )
);

-- Allow users to insert tags for their own recipes
CREATE POLICY "Users can insert their recipe tags"
ON recipe_tags
FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM recipes
        WHERE recipes.id = recipe_tags.recipe_id
          AND recipes.user_id = auth.uid()
    )
);

-- Allow users to delete tags for their own recipes
CREATE POLICY "Users can delete their recipe tags"
ON recipe_tags
FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM recipes
        WHERE recipes.id = recipe_tags.recipe_id
          AND recipes.user_id = auth.uid()
    )
);

-- Atomic replace: delete all existing tags, insert new set, in one transaction.
-- Called from API via supabase.rpc('replace_recipe_tags', {...}).
-- Tags arrive pre-normalized from the API layer.
CREATE OR REPLACE FUNCTION replace_recipe_tags(
    p_recipe_id UUID,
    p_tags TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tag TEXT;
BEGIN
    -- Verify authenticated user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated'
            USING ERRCODE = 'P0003';
    END IF;

    -- Verify recipe ownership
    IF NOT EXISTS (
        SELECT 1 FROM recipes
        WHERE id = p_recipe_id AND user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'Recipe not found or not owned by user'
            USING ERRCODE = 'P0002';
    END IF;

    -- Atomic: delete existing + insert new (rolls back on any failure)
    DELETE FROM recipe_tags WHERE recipe_id = p_recipe_id;

    IF p_tags IS NOT NULL AND array_length(p_tags, 1) > 0 THEN
        FOREACH v_tag IN ARRAY p_tags
        LOOP
            INSERT INTO recipe_tags (recipe_id, tag)
            VALUES (p_recipe_id, v_tag);
        END LOOP;
    END IF;
END;
$$;

-- Revoke default public access, grant only to authenticated users
REVOKE ALL ON FUNCTION replace_recipe_tags(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_recipe_tags(UUID, TEXT[]) TO authenticated;
