-- migrations/012_grocery_lists_user_name.sql
-- Phase 4.2.G: Grocery List Creation & Naming
--
-- Add user_name column for user-provided list names.
-- When user_name IS NOT NULL, it takes precedence over the auto-computed name.
-- Existing rows stay NULL (auto-named from source recipes).

ALTER TABLE grocery_lists
    ADD COLUMN IF NOT EXISTS user_name TEXT DEFAULT NULL;
