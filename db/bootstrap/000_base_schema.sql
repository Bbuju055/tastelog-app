-- db/bootstrap/000_base_schema.sql
-- Reconstructed pre-003 base schema: what a fresh database needs before
-- migrations/003..027 can apply. Used by db/bootstrap/apply.sh (fresh
-- install) and tests/db/run_db_proof.sh (migration proof on the pinned
-- Postgres image).
--
-- The original 001/002 migrations are not in the repository; this file
-- rebuilds the five base tables the chain depends on, derived from the
-- authoritative later evidence:
--   - migration 020's recipe_search_index SELECT list (recipes columns),
--   - migration 006/014 confirm_recipe_draft INSERT column lists,
--   - api/core/recipes.py insert paths (raw_model_json, image_path),
--   - api/models/recipe.py response models,
--   - migrations 008/011/012/024 (the grocery columns they ADD are
--     therefore absent here), api/core/grocery.py insert/select column
--     lists, api/models/grocery.py, docs/architecture.md schema tables.
-- Columns added by tracked migrations (008 updated_at, 009 favorite,
-- 011 source_recipes, 012 user_name, 014 source_url, 018 lineage,
-- 024 note, 026 mapping state) are NOT here -- the chain adds them.
--
-- DECLARED LIMITATION: this is a faithful reconstruction, not a byte
-- dump of production DDL, and it cannot be diffed against production
-- from this repository. Assumptions not evidenced anywhere: index
-- names, grocery_items.recipe_id ON DELETE SET NULL (the API never
-- clears the link before deleting a recipe, so the FK must not block
-- deletes), grocery RLS policies shaped like the recipe ones.
--
-- It is deliberately NOT under migrations/: api/core/migration_guard.py
-- requires every file there to exist in the production ledger, and this
-- schema predates that ledger.

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

-- Grocery tables as they stood before 008 (updated_at), 011
-- (source_recipes), 012 (user_name) and 024 (note) extended them.
CREATE TABLE grocery_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE grocery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,
    position INT NOT NULL,
    quantity TEXT,
    unit TEXT,
    name TEXT NOT NULL,
    checked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_recipes_user_id ON recipes(user_id);
CREATE INDEX idx_recipe_ingredients_recipe_id ON recipe_ingredients(recipe_id);
CREATE INDEX idx_recipe_steps_recipe_id ON recipe_steps(recipe_id);
CREATE INDEX idx_grocery_lists_user_id ON grocery_lists(user_id);
CREATE INDEX idx_grocery_items_list_id ON grocery_items(list_id);

CREATE TRIGGER update_recipes_updated_at
    BEFORE UPDATE ON recipes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE grocery_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE grocery_items ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY grocery_lists_owner ON grocery_lists FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY grocery_items_owner ON grocery_items FOR ALL
    USING (EXISTS (
        SELECT 1 FROM grocery_lists l
        WHERE l.id = grocery_items.list_id AND l.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM grocery_lists l
        WHERE l.id = grocery_items.list_id AND l.user_id = auth.uid()
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
