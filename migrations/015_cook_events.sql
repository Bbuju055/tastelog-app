-- migrations/015_cook_events.sql
-- Phase 9.B: Cook Again History
--
-- New table for personal cooking journal. Each row is a "I made this" event
-- attached to a recipe. Append-only for V1 (no UPDATE policy).
--
-- Supports: optional rating (1-5), optional notes, optional scale string,
-- backdatable cooked_at (defaults to now()).

-- ============================================================================
-- Table
-- ============================================================================

CREATE TABLE cook_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id   UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cooked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rating      INT CHECK (rating >= 1 AND rating <= 5),
  notes       TEXT,
  scale       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- RLS — users can only see/manage their own cook events
-- ============================================================================

ALTER TABLE cook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY cook_events_select ON cook_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY cook_events_insert ON cook_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY cook_events_delete ON cook_events FOR DELETE
  USING (auth.uid() = user_id);

-- No UPDATE policy — V1 is append-only. Delete + re-log covers mistakes.

-- ============================================================================
-- Indexes
-- ============================================================================

-- Per-recipe history (recipe detail screen)
CREATE INDEX cook_events_recipe_id_cooked_at
  ON cook_events (recipe_id, cooked_at DESC);

-- Cross-recipe recents (home screen "Recently Cooked")
CREATE INDEX cook_events_user_id_cooked_at
  ON cook_events (user_id, cooked_at DESC);
