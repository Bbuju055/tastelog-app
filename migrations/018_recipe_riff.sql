-- migrations/018_recipe_riff.sql
-- Phase 13.1: Recipe Riff Mode — Minimal Endpoint + UI Stub
--
-- Introduces the conversational riff surface:
--   - riff_sessions: one per "Riff on this" conversation, scoped to a source recipe
--   - riff_messages: append-only turn log (user + assistant)
--   - recipes: parent_recipe_id / riff_session_id / riff_label columns for future
--     save-as-new-recipe lineage (populated in a later ticket, not 13.1)
--
-- 13.1 contract notes:
--   - generated_recipe JSONB exists on riff_messages but is NOT populated in 13.1.
--     Reserved for the future structured-recipe extraction pass.
--   - Tables are append-only for V1 (no UPDATE policies), mirroring cook_events.
--     Session title auto-generation lands in a later ticket.

-- ============================================================================
-- riff_sessions
-- ============================================================================

CREATE TABLE riff_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_recipe_id  UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  title             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE riff_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY riff_sessions_select ON riff_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY riff_sessions_insert ON riff_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY riff_sessions_delete ON riff_sessions FOR DELETE
  USING (auth.uid() = user_id);

-- No UPDATE policy — 13.1 is append-only. Session title auto-gen is a later ticket.

-- ============================================================================
-- riff_messages
-- ============================================================================

CREATE TABLE riff_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES riff_sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT NOT NULL,
  generated_recipe  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE riff_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY riff_messages_select ON riff_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = auth.uid()
    )
  );

CREATE POLICY riff_messages_insert ON riff_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = auth.uid()
    )
  );

CREATE POLICY riff_messages_delete ON riff_messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = auth.uid()
    )
  );

-- No UPDATE policy — messages are append-only.

-- ============================================================================
-- recipes lineage columns
-- ============================================================================

ALTER TABLE recipes
  ADD COLUMN parent_recipe_id  UUID REFERENCES recipes(id) ON DELETE SET NULL,
  ADD COLUMN riff_session_id   UUID REFERENCES riff_sessions(id) ON DELETE SET NULL,
  ADD COLUMN riff_label        TEXT;

-- ============================================================================
-- Indexes
-- ============================================================================

-- Family tree: find children of a recipe
CREATE INDEX idx_recipes_parent_recipe_id
  ON recipes (parent_recipe_id);

-- Sessions per source recipe (riff UI load path, future)
CREATE INDEX idx_riff_sessions_source_recipe_id
  ON riff_sessions (source_recipe_id);

-- Messages per session, chronological (riff UI load path)
CREATE INDEX idx_riff_messages_session_id_created_at
  ON riff_messages (session_id, created_at);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Keep riff_sessions.updated_at fresh on any UPDATE (shared helper from 005).
CREATE TRIGGER set_riff_sessions_updated_at
BEFORE UPDATE ON riff_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
