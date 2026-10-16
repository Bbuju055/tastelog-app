-- tests/db/base_schema_pre003.sql
-- Reconstructed pre-003 base schema for the migration-026 proof harness.
--
-- The original 001/002 migrations are not in the repository; this file
-- rebuilds the three base tables the 003..026 chain depends on, derived
-- from the authoritative later evidence:
--   - migration 020's recipe_search_index SELECT list (recipes columns),
--   - migration 006/014 confirm_recipe_draft INSERT column lists,
--   - api/core/recipes.py insert paths (raw_model_json, image_path),
--   - api/models/recipe.py response models.
-- Columns added by tracked migrations (009 favorite, 014 source_url,
-- 018 lineage, 026 mapping state) are NOT here -- the chain adds them.
--
-- DECLARED LIMITATION: this is a faithful reconstruction, not a byte
-- dump of production DDL; exact-prod-schema application remains
-- provisional until migration 026 is applied to production itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The supabase/postgres image ships the real auth schema (auth.users,
-- auth.uid()) and the PostgREST roles; this file runs as the `postgres`
-- role, exactly as production migrations do.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    image_path TEXT,
    servings TEXT,
    prep_time TEXT,
    cook_time TEXT,
    confidence_score REAL,
    raw_model_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recipe_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position INT NOT NULL,
    quantity TEXT,
    unit TEXT,
    name TEXT NOT NULL,
    prep TEXT,
    raw_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recipe_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position INT NOT NULL,
    instruction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recipes_user_id ON recipes(user_id);
CREATE INDEX idx_recipe_ingredients_recipe_id ON recipe_ingredients(recipe_id);
CREATE INDEX idx_recipe_steps_recipe_id ON recipe_steps(recipe_id);

CREATE TRIGGER update_recipes_updated_at
    BEFORE UPDATE ON recipes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY recipes_owner ON recipes FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY recipe_ingredients_owner ON recipe_ingredients FOR ALL
    USING (EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = recipe_ingredients.recipe_id AND r.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = recipe_ingredients.recipe_id AND r.user_id = auth.uid()
    ));

CREATE POLICY recipe_steps_owner ON recipe_steps FOR ALL
    USING (EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = recipe_steps.recipe_id AND r.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = recipe_steps.recipe_id AND r.user_id = auth.uid()
    ));

-- Supabase default-privilege posture: PostgREST roles receive table
-- grants automatically for every later-created object as well.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
