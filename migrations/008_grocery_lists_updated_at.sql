-- migrations/008_grocery_lists_updated_at.sql
-- Add missing updated_at column to grocery_lists so the DB matches the API contract.

ALTER TABLE grocery_lists
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE grocery_lists
SET updated_at = created_at
WHERE updated_at IS NULL;

ALTER TABLE grocery_lists
    ALTER COLUMN updated_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS update_grocery_lists_updated_at ON grocery_lists;

CREATE TRIGGER update_grocery_lists_updated_at
    BEFORE UPDATE ON grocery_lists
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
