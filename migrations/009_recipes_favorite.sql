-- Migration 009: Add favorite column to recipes table
-- Supports per-user recipe favoriting for sort/filter.

ALTER TABLE recipes
  ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN recipes.favorite IS 'User-set favorite flag for recipe organization';
