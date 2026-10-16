"""
Tastelog: Per-user Riff turn counting + cap enforcement (Phase 13.7).

Implements docs/cross-screen-riff-decisions.md §5.2:
  - count one usage per server-side Claude dispatch
  - count both /riff sync and /riff/stream as one unit
  - enforce a coarse daily cap before dispatch
  - write through the service-role client; no client-side writes
  - usage increment is REQUIRED before Claude dispatch — a tracking
    failure must block dispatch so the cap cannot be silently bypassed
    once it is live (load-bearing prerequisite for cross-screen
    expansion)

Counter semantics:
  - keyed by (user_id, UTC date) via increment_riff_usage(uuid) RPC
  - read via SELECT count from riff_usage_daily where (user_id, today)
  - cap is a simple constant (RIFF_DAILY_LIMIT); enforcement raises
    RiffUsageLimitExceeded which routes translate to HTTP 429
  - tracking write failure raises RiffUsageTrackingError which routes
    translate to a non-429 server failure (HTTP 500) before Claude
    dispatch
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from supabase import Client

from api.core.exceptions import TastelogError


logger = logging.getLogger("tastelog.core.riff_usage")


# Conservative temporary cap. Not monetization, not credits, not a paywall.
# Single source of truth — bumped via code change, not env, until we
# productize Riff usage controls.
RIFF_DAILY_LIMIT: int = 25


class RiffUsageLimitExceeded(TastelogError):
    """Daily Riff turn cap reached for this user."""

    pass


class RiffUsageTrackingError(TastelogError):
    """Failed to record a Riff turn against the per-user counter.

    Routes MUST translate this to a non-429 server failure before
    dispatching Claude. Once the cap is live, an untracked Claude
    dispatch would silently bypass it.
    """

    pass


def _utc_today_iso() -> str:
    """Return today's UTC date as ISO 8601 (YYYY-MM-DD).

    Postgres-side, increment_riff_usage uses (NOW() AT TIME ZONE 'UTC')::date.
    Python-side queries must use the same UTC date to read consistent rows.
    """
    return datetime.now(timezone.utc).date().isoformat()


def get_riff_turns_today(user_id: UUID, *, supabase: Client) -> int:
    """Return today's Riff turn count for the user. Returns 0 when no row exists.

    Service-role read. The SELECT-own RLS policy is for direct mobile reads;
    service-role bypasses RLS and reads freely.

    Read errors fail open at zero — a transient DB hiccup on the cap
    check is preferable to blocking legitimate usage. The worst case is
    one turn over the cap before the next read succeeds. The write path
    (record_riff_turn) does NOT fail open.
    """
    today = _utc_today_iso()
    try:
        result = (
            supabase.table("riff_usage_daily")
            .select("count")
            .eq("user_id", str(user_id))
            .eq("usage_date", today)
            .execute()
        )
    except Exception as e:
        logger.error("Riff usage read failed: %s", e, exc_info=True)
        return 0
    rows = result.data or []
    if not rows:
        return 0
    return rows[0]["count"]


def enforce_riff_daily_cap(user_id: UUID, *, supabase: Client) -> None:
    """Raise RiffUsageLimitExceeded when the user has reached today's cap.

    Called BEFORE user-message insert and BEFORE Claude dispatch. Wraps the
    coarse "N riffs/day" requirement from §5.2.
    """
    used = get_riff_turns_today(user_id, supabase=supabase)
    if used >= RIFF_DAILY_LIMIT:
        raise RiffUsageLimitExceeded(
            f"Daily Riff limit reached ({used}/{RIFF_DAILY_LIMIT})",
            code="RIFF_DAILY_LIMIT",
        )


def record_riff_turn(user_id: UUID, *, supabase: Client) -> None:
    """Atomically UPSERT-and-increment today's Riff turn count for the user.

    Called AFTER cap check + session create/validate, and BEFORE
    user-message insert + Claude dispatch. Reserves one turn at the
    dispatch boundary so an untracked Claude call is impossible.
    One call = one accounted turn.

    Tracking is REQUIRED, not best-effort: an untracked Claude dispatch
    would bypass the per-user cap. RPC failure is logged and raised as
    RiffUsageTrackingError. Routes translate to HTTP 500 and DO NOT
    proceed to Claude dispatch on this failure.
    """
    try:
        supabase.rpc(
            "increment_riff_usage", {"p_user_id": str(user_id)}
        ).execute()
    except Exception as e:
        logger.error("Riff usage increment failed: %s", e, exc_info=True)
        raise RiffUsageTrackingError(
            f"Failed to record Riff turn: {type(e).__name__}: {str(e)[:100]}",
            code="RIFF_USAGE_INCREMENT_FAILED",
        )
