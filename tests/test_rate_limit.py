"""check_and_record_rate_limit against an in-memory stand-in for capture_rate_limits.

The route tests stub the limiter; this file proves the limiter itself: N requests
pass, the N+1th is refused, old rows fall out of the window, keys are
independent, and a database failure fails closed.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from api.core.token_auth import (
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_MINUTES,
    RateLimitExceededError,
    RateLimitUnavailableError,
    check_and_record_rate_limit,
)


class _Table:
    """Just the query chain the limiter uses: select/eq/gte/limit/execute and insert/execute."""

    def __init__(self, rows: list[dict]):
        self._rows = rows
        self._key = None
        self._cutoff = None
        self._limit = None
        self._pending_insert = None

    def select(self, *_):
        return self

    def eq(self, _column, value):
        self._key = value
        return self

    def gte(self, _column, value):
        self._cutoff = datetime.fromisoformat(value)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, row):
        self._pending_insert = {**row, "request_at": datetime.now(timezone.utc)}
        return self

    def execute(self):
        if self._pending_insert is not None:
            self._rows.append(self._pending_insert)
            return SimpleNamespace(data=[self._pending_insert])
        hits = [
            {"id": i}
            for i, row in enumerate(self._rows)
            if row["token_hash"] == self._key and row["request_at"] >= self._cutoff
        ]
        return SimpleNamespace(data=hits[: self._limit])


class _Db:
    def __init__(self):
        self.rows: list[dict] = []

    def table(self, name):
        assert name == "capture_rate_limits"
        return _Table(self.rows)


class _BrokenDb:
    def table(self, name):
        raise RuntimeError("connection refused")


def test_requests_up_to_the_limit_pass_and_the_next_is_refused():
    db = _Db()
    for _ in range(RATE_LIMIT_MAX_REQUESTS):
        check_and_record_rate_limit("user:a", supabase=db)
    assert len(db.rows) == RATE_LIMIT_MAX_REQUESTS
    with pytest.raises(RateLimitExceededError):
        check_and_record_rate_limit("user:a", supabase=db)
    assert len(db.rows) == RATE_LIMIT_MAX_REQUESTS  # a refused request is not recorded


def test_requests_older_than_the_window_do_not_count():
    db = _Db()
    stale = datetime.now(timezone.utc) - timedelta(minutes=RATE_LIMIT_WINDOW_MINUTES + 1)
    db.rows.extend({"token_hash": "user:a", "request_at": stale} for _ in range(RATE_LIMIT_MAX_REQUESTS))
    check_and_record_rate_limit("user:a", supabase=db)  # passes: the window is empty


def test_keys_are_independent():
    db = _Db()
    for _ in range(RATE_LIMIT_MAX_REQUESTS):
        check_and_record_rate_limit("user:a", supabase=db)
    check_and_record_rate_limit("user:b", supabase=db)
    check_and_record_rate_limit("tokenhash-c", supabase=db)


def test_database_failure_fails_closed():
    with pytest.raises(RateLimitUnavailableError):
        check_and_record_rate_limit("user:a", supabase=_BrokenDb())
