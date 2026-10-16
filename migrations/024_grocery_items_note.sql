-- Migration 024: grocery_items substitution-provenance note
-- (PROVIDER-S1.1 closure, workstream W2)
--
-- Additive only: nullable TEXT, no default, no index, no RLS change, and
-- deliberately NO backfill — historical rows remain unlabeled (operator
-- decision: clearing and re-adding the source recipe regenerates labeled
-- rows). Carries the Riff substitution label ("in place of <removed
-- ingredient>") from recipe_ingredients.prep into the grocery list so a
-- same-name replacement row stays explained and is never merged into the
-- retained row.

ALTER TABLE grocery_items ADD COLUMN note TEXT;
