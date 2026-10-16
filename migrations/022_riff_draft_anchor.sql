-- migrations/022_riff_draft_anchor.sql
-- Phase 13.9 Slice A — riff_sessions accepts EITHER a recipe anchor or a draft anchor.
--
-- Locked contract: docs/capture-draft-riff-contract.md §2 + §3.
--
-- Adds a nullable source_draft_id FK with ON DELETE CASCADE alongside the
-- existing source_recipe_id, gated by a CHECK constraint that enforces
-- exactly one non-null anchor per row.
--
-- RLS posture: existing recipe-anchored permissive policies remain untouched
-- (SELECT/INSERT/DELETE by user_id, all rewritten in 019 with the
-- (SELECT auth.uid()) form). One new AS RESTRICTIVE policy enforces
-- draft-anchor ownership through recipe_drafts.user_id whenever
-- source_draft_id IS NOT NULL — defense-in-depth at the DB layer, AND'd
-- with the permissive policies. Avoids multiple_permissive_policies advisor
-- noise that would result from adding parallel permissive variants.
--
-- (SELECT auth.uid()) form per migration 019 convention.
--
-- Recipe-anchored Riff behavior is bit-identical at the DB layer
-- post-migration: existing policies untouched, FK + cascade direction on
-- source_recipe_id unchanged, restrictive policy short-circuits to TRUE
-- whenever source_draft_id IS NULL.

-- ============================================================================
-- 1) Relax recipe-anchor NOT NULL
-- ============================================================================

ALTER TABLE riff_sessions
  ALTER COLUMN source_recipe_id DROP NOT NULL;

-- ============================================================================
-- 2) Add draft-anchor column with ON DELETE CASCADE
-- ============================================================================

ALTER TABLE riff_sessions
  ADD COLUMN source_draft_id UUID
  REFERENCES recipe_drafts(id) ON DELETE CASCADE;

-- ============================================================================
-- 3) CHECK exactly one anchor non-null
-- ============================================================================
--
-- Existing rows: source_recipe_id IS NOT NULL, source_draft_id IS NULL by
-- default. num_nonnulls(...) = 1 for every existing row; no backfill
-- required. ADD CONSTRAINT validates against existing rows in this same
-- statement.

ALTER TABLE riff_sessions
  ADD CONSTRAINT riff_sessions_anchor_check
  CHECK (num_nonnulls(source_recipe_id, source_draft_id) = 1);

-- ============================================================================
-- 4) FK covering index (mirrors idx_riff_sessions_source_recipe_id from 018)
-- ============================================================================

CREATE INDEX idx_riff_sessions_source_draft_id
  ON riff_sessions (source_draft_id);

-- ============================================================================
-- 5) RLS — restrictive draft-anchor ownership policy
-- ============================================================================
--
-- Defense-in-depth for draft-anchored rows. AND-combines with the existing
-- permissive policies (SELECT/INSERT/DELETE by user_id). For recipe-anchored
-- rows (source_draft_id IS NULL) this policy short-circuits to TRUE and DB
-- behavior is unchanged. For draft-anchored rows the user MUST own the
-- referenced recipe_drafts row.
--
-- (SELECT auth.uid()) form so the auth function is evaluated once per query
-- rather than per row, per migration 019 convention.

CREATE POLICY riff_sessions_draft_ownership ON riff_sessions
  AS RESTRICTIVE
  FOR ALL
  USING (
    source_draft_id IS NULL
    OR EXISTS (
      SELECT 1 FROM recipe_drafts
      WHERE recipe_drafts.id = riff_sessions.source_draft_id
        AND recipe_drafts.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    source_draft_id IS NULL
    OR EXISTS (
      SELECT 1 FROM recipe_drafts
      WHERE recipe_drafts.id = riff_sessions.source_draft_id
        AND recipe_drafts.user_id = (SELECT auth.uid())
    )
  );
