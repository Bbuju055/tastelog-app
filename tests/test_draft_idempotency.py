"""api.core.draft_idempotency - no network, deterministic.

The RPC outcomes of migration 028 are mapped to Python results and typed
errors; the SQL side is proven in tests/db/proof_migration_028.sql.
"""

from types import SimpleNamespace
from uuid import UUID

import pytest

from api.core.draft_idempotency import (
    IdempotencyInProgressError,
    InvalidIdempotencyKeyError,
    Reservation,
    clean_idempotency_key,
    complete_draft_capture,
    hash_capture_payload,
    release_draft_capture,
    reserve_draft_capture,
)
from api.core.idempotency import IdempotencyConflictError, IdempotencyServiceError

USER = UUID("00000000-0000-0000-0000-000000000001")
DRAFT = UUID("00000000-0000-0000-0000-00000000d001")


class _FakeSupabase:
    def __init__(self, data=None, exc: Exception | None = None):
        self._data = data
        self._exc = exc
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        fake = self

        class _Q:
            def execute(self_inner):
                if fake._exc is not None:
                    raise fake._exc
                return SimpleNamespace(data=fake._data)

        return _Q()


# ----------------------------------------------------------------------------
# Payload identity
# ----------------------------------------------------------------------------


def test_hash_is_deterministic_hex_sha256_length():
    a = hash_capture_payload([b"img", b"https://x"])
    assert a == hash_capture_payload([b"img", b"https://x"])
    assert len(a) == 64 and int(a, 16) >= 0


def test_hash_depends_on_part_order():
    assert hash_capture_payload([b"a", b"b"]) != hash_capture_payload([b"b", b"a"])


def test_hash_depends_on_part_boundaries():
    assert hash_capture_payload([b"ab", b"c"]) != hash_capture_payload([b"a", b"bc"])
    assert hash_capture_payload([b"abc"]) != hash_capture_payload([b"abc", b""])


def test_hash_distinguishes_url_only_from_image_plus_url():
    url = b"https://example.com/r"
    assert hash_capture_payload([url]) != hash_capture_payload([b"img", url])


# ----------------------------------------------------------------------------
# Key validation
# ----------------------------------------------------------------------------


def test_clean_key_strips_surrounding_whitespace():
    assert clean_idempotency_key("  abc-123 \n") == "abc-123"


@pytest.mark.parametrize("raw", ["", "   ", "a b", "a\tb", "a\nb"])
def test_clean_key_rejects_empty_or_inner_whitespace(raw):
    with pytest.raises(InvalidIdempotencyKeyError) as e:
        clean_idempotency_key(raw)
    assert e.value.code == "IDEMPOTENCY_KEY_INVALID"


# ----------------------------------------------------------------------------
# reserve
# ----------------------------------------------------------------------------


def test_reserve_passes_rpc_params_including_the_draft_id():
    db = _FakeSupabase({"outcome": "reserved"})
    assert reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db) == Reservation("reserved")
    assert db.calls == [
        (
            "reserve_draft_capture",
            {
                "p_user_id": str(USER),
                "p_idempotency_key": "k",
                "p_payload_hash": "h",
                "p_draft_id": str(DRAFT),
            },
        )
    ]


def test_reserve_replay_returns_recorded_response():
    db = _FakeSupabase({"outcome": "replay", "response": {"id": "d1"}})
    assert reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db) == Reservation(
        "replay", response={"id": "d1"}
    )


def test_reserve_recover_returns_the_holders_draft_id():
    db = _FakeSupabase({"outcome": "recover", "draft_id": str(DRAFT)})
    assert reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db) == Reservation(
        "recover", draft_id=DRAFT
    )


def test_reserve_in_progress_raises_typed_error():
    db = _FakeSupabase({"outcome": "in_progress"})
    with pytest.raises(IdempotencyInProgressError) as e:
        reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db)
    assert e.value.code == "IDEMPOTENCY_IN_PROGRESS"


def test_reserve_mismatch_raises_conflict():
    db = _FakeSupabase({"outcome": "mismatch"})
    with pytest.raises(IdempotencyConflictError) as e:
        reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db)
    assert e.value.code == "IDEMPOTENCY_CONFLICT"


@pytest.mark.parametrize(
    "data",
    [
        {"outcome": "replay"},  # replay without a response object
        {"outcome": "replay", "response": "not-a-dict"},
        {"outcome": "recover"},  # recover without a draft id
        {"outcome": "recover", "draft_id": "not-a-uuid"},
        {"outcome": "something-new"},
        {},
        None,
        [{"outcome": "reserved"}],
    ],
)
def test_reserve_malformed_reply_fails_closed(data):
    db = _FakeSupabase(data)
    with pytest.raises(IdempotencyServiceError) as e:
        reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db)
    assert e.value.code == "IDEMPOTENCY_UNAVAILABLE"


def test_reserve_db_error_fails_closed():
    db = _FakeSupabase(exc=RuntimeError("boom"))
    with pytest.raises(IdempotencyServiceError):
        reserve_draft_capture(USER, "k", "h", DRAFT, supabase=db)


# ----------------------------------------------------------------------------
# complete / release
# ----------------------------------------------------------------------------


def test_complete_passes_owner_draft_id_and_maps_boolean():
    db = _FakeSupabase(True)
    assert complete_draft_capture(USER, "k", DRAFT, {"id": "d1"}, supabase=db) is True
    assert db.calls == [
        (
            "complete_draft_capture",
            {
                "p_user_id": str(USER),
                "p_idempotency_key": "k",
                "p_draft_id": str(DRAFT),
                "p_response": {"id": "d1"},
            },
        )
    ]
    assert (
        complete_draft_capture(USER, "k", DRAFT, {"id": "d1"}, supabase=_FakeSupabase(False))
        is False
    )


def test_release_passes_owner_draft_id_and_maps_boolean_and_db_error():
    db = _FakeSupabase(True)
    assert release_draft_capture(USER, "k", DRAFT, supabase=db) is True
    assert db.calls == [
        (
            "release_draft_capture",
            {"p_user_id": str(USER), "p_idempotency_key": "k", "p_draft_id": str(DRAFT)},
        )
    ]
    assert release_draft_capture(USER, "k", DRAFT, supabase=_FakeSupabase(False)) is False
    with pytest.raises(IdempotencyServiceError):
        release_draft_capture(USER, "k", DRAFT, supabase=_FakeSupabase(exc=RuntimeError("x")))
