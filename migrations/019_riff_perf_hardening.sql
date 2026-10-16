-- migrations/019_riff_perf_hardening.sql
-- Phase 13.1 follow-up: address performance advisor findings from 018.
--
-- Surgical scope — touches only riff surfaces introduced in 018:
--   1. Add covering indexes on two foreign keys flagged as unindexed.
--   2. Recreate all 6 riff RLS policies to use `(select auth.uid())` so
--      the auth function is evaluated once per query instead of per row
--      (auth_rls_initplan advisor 0003).
--
-- No behavioral change. No new columns, tables, or features.

-- ============================================================================
-- 1) Missing FK covering indexes
-- ============================================================================

CREATE INDEX idx_riff_sessions_user_id
  ON riff_sessions (user_id);

CREATE INDEX idx_recipes_riff_session_id
  ON recipes (riff_session_id);

-- ============================================================================
-- 2) RLS policies — evaluate auth.uid() once per query, not per row
-- ============================================================================

-- riff_sessions ---------------------------------------------------------------

DROP POLICY riff_sessions_select ON riff_sessions;
CREATE POLICY riff_sessions_select ON riff_sessions FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY riff_sessions_insert ON riff_sessions;
CREATE POLICY riff_sessions_insert ON riff_sessions FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY riff_sessions_delete ON riff_sessions;
CREATE POLICY riff_sessions_delete ON riff_sessions FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

-- riff_messages ---------------------------------------------------------------

DROP POLICY riff_messages_select ON riff_messages;
CREATE POLICY riff_messages_select ON riff_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY riff_messages_insert ON riff_messages;
CREATE POLICY riff_messages_insert ON riff_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY riff_messages_delete ON riff_messages;
CREATE POLICY riff_messages_delete ON riff_messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM riff_sessions
      WHERE riff_sessions.id = riff_messages.session_id
        AND riff_sessions.user_id = (SELECT auth.uid())
    )
  );
