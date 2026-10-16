"""Tests for api/core/riff_usage.py — Phase 13.7.

Unit-level tests for the per-user Riff usage helpers. No FastAPI route
integration here — that lives in tests/test_riff.py and
tests/test_riff_stream.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from api.core.riff_usage import (
    RIFF_DAILY_LIMIT,
    RiffUsageLimitExceeded,
    RiffUsageTrackingError,
    enforce_riff_daily_cap,
    get_riff_turns_today,
    record_riff_turn,
)


FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")


def _mock_db_with_count(count: int | None) -> MagicMock:
    """Mock supabase whose riff_usage_daily SELECT returns the given count.

    count=None -> empty rows (no row for today)
    count=int  -> single row with that count
    """
    db = MagicMock()
    chain = (
        db.table.return_value
        .select.return_value
        .eq.return_value
        .eq.return_value
        .execute.return_value
    )
    chain.data = [] if count is None else [{"count": count}]
    return db


# ---------------------------------------------------------------------------
# get_riff_turns_today
# ---------------------------------------------------------------------------


def test_get_returns_zero_when_no_row():
    db = _mock_db_with_count(None)
    assert get_riff_turns_today(FAKE_USER_ID, supabase=db) == 0


def test_get_returns_count_when_row_exists():
    db = _mock_db_with_count(7)
    assert get_riff_turns_today(FAKE_USER_ID, supabase=db) == 7


def test_get_fails_open_to_zero_on_read_error():
    """Read-side fail-open per docstring — write-side is NOT fail-open."""
    db = MagicMock()
    db.table.side_effect = Exception("boom")
    assert get_riff_turns_today(FAKE_USER_ID, supabase=db) == 0


def test_get_filters_by_user_id_and_today():
    """SELECT chain is .table('riff_usage_daily').select('count')
    .eq('user_id', <uid>).eq('usage_date', <today>).execute()."""
    db = _mock_db_with_count(3)
    get_riff_turns_today(FAKE_USER_ID, supabase=db)
    db.table.assert_called_once_with("riff_usage_daily")
    db.table.return_value.select.assert_called_once_with("count")
    eq1 = db.table.return_value.select.return_value.eq
    eq1.assert_called_once_with("user_id", str(FAKE_USER_ID))
    # The second .eq is on the chained .eq().eq(...) — assert it was called
    # with usage_date and an ISO date string (YYYY-MM-DD, 10 chars).
    eq2 = eq1.return_value.eq
    eq2.assert_called_once()
    args = eq2.call_args.args
    assert args[0] == "usage_date"
    assert isinstance(args[1], str) and len(args[1]) == 10
    assert args[1][4] == "-" and args[1][7] == "-"


# ---------------------------------------------------------------------------
# enforce_riff_daily_cap
# ---------------------------------------------------------------------------


def test_cap_passes_at_zero():
    db = _mock_db_with_count(None)
    enforce_riff_daily_cap(FAKE_USER_ID, supabase=db)  # no raise


def test_cap_passes_below_limit():
    db = _mock_db_with_count(RIFF_DAILY_LIMIT - 1)
    enforce_riff_daily_cap(FAKE_USER_ID, supabase=db)  # no raise


def test_cap_raises_at_limit():
    db = _mock_db_with_count(RIFF_DAILY_LIMIT)
    with pytest.raises(RiffUsageLimitExceeded):
        enforce_riff_daily_cap(FAKE_USER_ID, supabase=db)


def test_cap_raises_above_limit():
    db = _mock_db_with_count(RIFF_DAILY_LIMIT + 5)
    with pytest.raises(RiffUsageLimitExceeded):
        enforce_riff_daily_cap(FAKE_USER_ID, supabase=db)


def test_cap_exception_carries_code():
    db = _mock_db_with_count(RIFF_DAILY_LIMIT)
    with pytest.raises(RiffUsageLimitExceeded) as exc_info:
        enforce_riff_daily_cap(FAKE_USER_ID, supabase=db)
    assert exc_info.value.code == "RIFF_DAILY_LIMIT"


# ---------------------------------------------------------------------------
# record_riff_turn — REQUIRED write, raises on failure
# ---------------------------------------------------------------------------


def test_record_calls_increment_rpc_with_user_id():
    db = MagicMock()
    record_riff_turn(FAKE_USER_ID, supabase=db)
    db.rpc.assert_called_once_with(
        "increment_riff_usage", {"p_user_id": str(FAKE_USER_ID)}
    )
    db.rpc.return_value.execute.assert_called_once()


def test_record_raises_on_rpc_error():
    """Tracking is REQUIRED, not best-effort — RPC failure must raise so the
    route translates to HTTP 500 and skips Claude dispatch."""
    db = MagicMock()
    db.rpc.side_effect = Exception("boom")
    with pytest.raises(RiffUsageTrackingError):
        record_riff_turn(FAKE_USER_ID, supabase=db)


def test_record_raises_on_execute_error():
    """The .execute() call after .rpc() may also fail — e.g. PostgREST returning
    an HTTP error from the function call. Must also raise."""
    db = MagicMock()
    db.rpc.return_value.execute.side_effect = Exception("execute boom")
    with pytest.raises(RiffUsageTrackingError):
        record_riff_turn(FAKE_USER_ID, supabase=db)


def test_record_tracking_exception_carries_code():
    db = MagicMock()
    db.rpc.side_effect = Exception("boom")
    with pytest.raises(RiffUsageTrackingError) as exc_info:
        record_riff_turn(FAKE_USER_ID, supabase=db)
    assert exc_info.value.code == "RIFF_USAGE_INCREMENT_FAILED"
