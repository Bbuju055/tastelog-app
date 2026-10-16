-- migrations/011_grocery_consolidated.sql
-- Phase 4.1.C: Consolidated Grocery Lists
--
-- 1. Add source_recipes JSONB to grocery_items for multi-recipe attribution
-- 2. Add trigger to cascade grocery_items changes to parent grocery_lists.updated_at

ALTER TABLE grocery_items
    ADD COLUMN IF NOT EXISTS source_recipes JSONB DEFAULT NULL;

CREATE OR REPLACE FUNCTION update_grocery_list_updated_at_from_items()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE grocery_lists
        SET updated_at = NOW()
        WHERE id = NEW.list_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE grocery_lists
        SET updated_at = NOW()
        WHERE id = OLD.list_id;
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE grocery_lists
        SET updated_at = NOW()
        WHERE id = NEW.list_id;

        IF OLD.list_id IS DISTINCT FROM NEW.list_id THEN
            UPDATE grocery_lists
            SET updated_at = NOW()
            WHERE id = OLD.list_id;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cascade_grocery_items_to_list_updated_at ON grocery_items;

CREATE TRIGGER cascade_grocery_items_to_list_updated_at
    AFTER INSERT OR UPDATE OR DELETE ON grocery_items
    FOR EACH ROW
    EXECUTE FUNCTION update_grocery_list_updated_at_from_items();
