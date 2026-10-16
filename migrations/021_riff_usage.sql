-- migrations/021_riff_usage.sql
-- Phase 13.7 — Per-user Riff usage tracking + entry-point telemetry.
-- Implements docs/cross-screen-riff-decisions.md §5.2 + §5.3.
--
-- Hard prerequisite for any Cross-screen Riff Expansion. Per-user daily
-- turn counter with backend-enforced cap, plus a nullable entry_point
-- telemetry column on riff_sessions so future surfaces (cooking / grocery
-- / capture) can be tagged at session-create time without further DB
-- churn.
--
-- Additive only:
--   - new table riff_usage_daily (RLS enabled, SELECT-own only — writes
--     happen exclusively via the service-role backend client)
--   - new SECURITY INVOKER function increment_riff_usage(uuid) for
--     atomic UPSERT-and-increment per (user, UTC date)
--   - new nullable column riff_sessions.entry_point (no default; old rows
--     stay NULL; new rows populated by the route with "recipe_detail"
--     when the request body omits it)
--
-- Preserved:
--   - append-only RLS on riff_messages (untouched here)
--   - 11.C.3 internal-only posture on recipe_search_index (untouched)
--   - saved-Riff lineage from Phase 13.6.4-FU (untouched)


-- ============================================================================
-- riff_usage_daily — per-user-per-day Riff turn counter
-- ============================================================================

CREATE TABLE riff_usage_daily (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date  DATE NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE riff_usage_daily ENABLE ROW LEVEL SECURITY;

-- SELECT-own only. No INSERT/UPDATE/DELETE policies — all writes flow
-- through the service-role backend client (which bypasses RLS).
CREATE POLICY riff_usage_daily_select ON riff_usage_daily FOR SELECT
  USING ((SELECT auth.uid()) = user_id);


-- ============================================================================
-- increment_riff_usage(uuid) — atomic UPSERT + increment for cap counting
-- ============================================================================
--
-- SECURITY INVOKER + REVOKE from anon/authenticated/PUBLIC. Backend
-- service-role client bypasses RLS and writes freely. Even if an
-- authenticated caller could invoke this function, the underlying
-- INSERT/UPDATE on riff_usage_daily would be blocked by the absence of
-- INSERT/UPDATE policies under RLS (defense-in-depth).
--
-- search_path is fixed to satisfy the function_search_path_mutable advisor.
-- usage_date computed as UTC to avoid session-tz drift.

CREATE FUNCTION increment_riff_usage(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO riff_usage_daily (user_id, usage_date, count, updated_at)
  VALUES (p_user_id, (NOW() AT TIME ZONE 'UTC')::date, 1, NOW())
  ON CONFLICT (user_id, usage_date) DO UPDATE
    SET count = riff_usage_daily.count + 1,
        updated_at = NOW()
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION increment_riff_usage(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_riff_usage(UUID) FROM anon, authenticated;


-- ============================================================================
-- riff_sessions.entry_point — telemetry column (§5.3)
-- ============================================================================
--
-- Nullable, no default, no CHECK, no enum, no index. Old rows stay NULL
-- (semantically equivalent to "recipe_detail" for the only entry point
-- shipped to date). New rows populated by the FastAPI riff routes with
-- "recipe_detail" when the request body omits the field — keeping
-- existing mobile builds backward-compatible.

ALTER TABLE riff_sessions ADD COLUMN entry_point TEXT;
