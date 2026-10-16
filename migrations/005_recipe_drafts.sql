-- migrations/005_recipe_drafts.sql
-- Recipe drafts: temporary parsed recipes awaiting user confirmation

-- 0. Ensure pgcrypto extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Create updated_at trigger function (if not exists)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Create recipe_drafts table
CREATE TABLE recipe_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,

    -- Stored image reference (for reparse)
    image_storage_key TEXT NOT NULL,

    -- Parsed data
    title TEXT NOT NULL,
    servings TEXT,
    prep_time TEXT,
    cook_time TEXT,
    confidence_score REAL CHECK (confidence_score >= 0 AND confidence_score <= 1),
    ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_model_json JSONB,

    -- Parser metadata for debugging regressions
    model_version TEXT NOT NULL,
    parser_version TEXT NOT NULL,

    -- Lifecycle
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

    CONSTRAINT fk_draft_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 3. Indexes
CREATE INDEX idx_drafts_user_id ON recipe_drafts(user_id);
CREATE INDEX idx_drafts_expires_at ON recipe_drafts(expires_at);

-- 4. Auto-update updated_at trigger
CREATE TRIGGER update_recipe_drafts_updated_at
    BEFORE UPDATE ON recipe_drafts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 5. RLS policies
ALTER TABLE recipe_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own drafts"
    ON recipe_drafts FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own drafts"
    ON recipe_drafts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own drafts"
    ON recipe_drafts FOR DELETE
    USING (auth.uid() = user_id);

-- Note: No UPDATE policy - drafts are immutable until confirm
