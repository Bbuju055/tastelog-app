"""Tests for the draft-anchored Riff sync endpoint (Phase 13.9 Slice D).

POST /api/drafts/{draft_id}/riff — sibling of the recipe-anchored
POST /api/recipes/{recipe_id}/riff. Same Pydantic models
(RiffMessageRequest, RiffTurnResponse), same Phase 13.7 cap accounting,
same append-only RLS on riff_messages. Differences: draft load + expiry
check via get_active_draft, draft-anchor session validation, server-side
adapter to recipe-shape input before run_riff_turn.

Mocks only — no real Supabase / Anthropic network. Helper patterns mirror
tests/test_riff.py for symmetry; duplicated rather than refactored to
conftest per Slice D scope (revisit if Slice E/F demonstrate pain).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import anthropic
import httpx
import pytest

from api.core.exceptions import DraftExpiredError, DraftNotFoundError, StorageError
from api.core.riff_usage import RiffUsageLimitExceeded, RiffUsageTrackingError
from api.dependencies import get_db, get_user_db


FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_DRAFT_ID = UUID("00000000-0000-0000-0000-000000000abc")
OTHER_DRAFT_ID = UUID("00000000-0000-0000-0000-000000000def")
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000002")
FAKE_SESSION_ID = UUID("00000000-0000-0000-0000-000000000010")

ASSISTANT_REPLY = "Here's a dairy-free version using cashew cream..."
ASSISTANT_REPLY_WITH_RECIPE = (
    "Here's a dairy-free version.\n"
    "\n"
    "```recipe-json\n"
    '{"title": "Dairy-Free Alfredo", "servings": "4", '
    '"prep_time": "10 min", "cook_time": "20 min", '
    '"ingredients": [{"quantity": "1", "unit": "cup", "name": "cashews", "prep": "soaked"}], '
    '"steps": [{"position": 1, "instruction": "Blend cashews with water."}]}\n'
    "```"
)

DRAFT_RIFF_URL = f"/api/drafts/{FAKE_DRAFT_ID}/riff"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_active_draft() -> dict:
    """Shape matches what get_active_draft returns (a recipe_drafts row).

    Mirrors tests/test_riff.py::_fake_recipe but for the draft anchor. Uses
    a future expires_at so the helper itself would not raise in production;
    expiry-rejection tests patch get_active_draft to raise directly.
    """
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    return {
        "id": str(FAKE_DRAFT_ID),
        "user_id": str(FAKE_USER_ID),
        "image_storage_keys": [],
        "source_url": None,
        "title": "Fettuccine Alfredo",
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "20 min",
        "confidence_score": 0.95,
        "ingredients": [
            {"quantity": "1", "unit": "cup", "name": "heavy cream", "prep": None},
        ],
        "steps": [{"position": 1, "instruction": "Boil water."}],
        "raw_model_json": {"raw": "..."},
        "model_version": "test",
        "parser_version": "test",
        "created_at": "2026-05-10T12:00:00+00:00",
        "updated_at": "2026-05-10T12:00:00+00:00",
        "expires_at": future,
    }


def _mock_user_db(
    *,
    session_lookup_rows: list[dict] | None = None,
    session_insert_id: UUID | None = None,
    history_rows: list[dict] | None = None,
) -> tuple[MagicMock, MagicMock, MagicMock]:
    """Build a user_db MagicMock for the draft riff flow.

    Mirrors tests/test_riff.py::_mock_user_db. Each call to
    user_db.table("riff_sessions") or ("riff_messages") returns a distinct
    child mock, configured per the scenario.
    """
    sessions_table = MagicMock()
    messages_table = MagicMock()

    if session_insert_id is not None:
        sessions_table.insert.return_value.execute.return_value.data = [
            {"id": str(session_insert_id)}
        ]

    if session_lookup_rows is not None:
        (
            sessions_table.select.return_value.eq.return_value.execute.return_value
        ).data = session_lookup_rows

    # riff_messages INSERT — generic success (called twice: user then assistant)
    messages_table.insert.return_value.execute.return_value.data = [
        {"id": str(uuid4())}
    ]

    # riff_messages SELECT history
    (
        messages_table.select.return_value.eq.return_value.order.return_value.execute.return_value
    ).data = history_rows or []

    def _table(name: str) -> MagicMock:
        if name == "riff_sessions":
            return sessions_table
        if name == "riff_messages":
            return messages_table
        raise AssertionError(f"unexpected table: {name}")

    user_db = MagicMock()
    user_db.table.side_effect = _table
    return user_db, sessions_table, messages_table


def _mock_anthropic_client(text: str = ASSISTANT_REPLY) -> MagicMock:
    """Anthropic client whose .messages.create returns a text-only Message."""
    block = MagicMock()
    block.text = text
    message = MagicMock()
    message.content = [block]
    client = MagicMock()
    client.messages.create.return_value = message
    return client


def _install_overrides(client, user_db: MagicMock) -> None:
    """Wire get_db / get_user_db overrides onto the test app."""
    client.app.dependency_overrides[get_db] = lambda: MagicMock()
    client.app.dependency_overrides[get_user_db] = lambda: user_db


# ---------------------------------------------------------------------------
# Tests — Phase 13.9 Slice D required coverage
# ---------------------------------------------------------------------------


class TestRiffDraftSyncEndpoint:
    """POST /api/drafts/{draft_id}/riff."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        """Default-override the two DB deps for every test in this class.

        Without this, get_user_db -> get_bearer_token rejects with 401
        before Pydantic body validation or get_active_draft mocks can run.
        Tests that need to drive DB behavior call _install_overrides(...)
        afterwards.
        """
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # ===== Group A — Happy paths =====

    def test_creates_draft_anchored_session_when_session_id_absent(
        self, authed_client
    ):
        user_db, sessions_table, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "Make it dairy-free",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL, json={"message": "Make it dairy-free"}
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == ASSISTANT_REPLY

        # Insert payload locks the draft-anchor session fields
        sessions_table.insert.assert_called_once()
        insert_payload = sessions_table.insert.call_args.args[0]
        assert insert_payload["user_id"] == str(FAKE_USER_ID)
        assert insert_payload["source_recipe_id"] is None
        assert insert_payload["source_draft_id"] == str(FAKE_DRAFT_ID)
        assert insert_payload["entry_point"] == "draft_review"

        # No lookup happened (new session)
        sessions_table.select.assert_not_called()

        # Two message inserts: user turn + assistant turn
        assert messages_table.insert.call_count == 2
        roles = [call.args[0]["role"] for call in messages_table.insert.call_args_list]
        assert roles == ["user", "assistant"]

    def test_reuses_existing_draft_anchored_session(self, authed_client):
        user_db, sessions_table, messages_table = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(FAKE_DRAFT_ID),
                }
            ],
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier turn",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "earlier reply",
                    "created_at": "2026-05-10T12:00:01+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "And spicier please",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == str(FAKE_SESSION_ID)

        # No insert on sessions table — reuse only
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()

        # Two message inserts still happen (user + assistant for THIS turn)
        assert messages_table.insert.call_count == 2

    def test_returns_full_riff_turn_response_shape(self, authed_client):
        user_db, _, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        body = resp.json()
        # Locked RiffTurnResponse shape (Phase 13.2)
        assert set(body.keys()) == {
            "session_id",
            "assistant_message",
            "assistant_message_id",
            "generated_recipe",
        }
        # No fenced block in the canned reply → generated_recipe is None
        assert body["generated_recipe"] is None
        # session_id and assistant_message_id are valid UUID strings
        UUID(body["session_id"])
        UUID(body["assistant_message_id"])

    def test_persists_user_then_assistant_messages_in_order(self, authed_client):
        user_db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        roles = [call.args[0]["role"] for call in messages_table.insert.call_args_list]
        assert roles == ["user", "assistant"]
        # Assistant insert payload carries generated_recipe field (None here).
        # Preserves append-only RLS: insert-with-blob, no follow-up UPDATE.
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert "generated_recipe" in assistant_payload

    def test_extracts_generated_recipe_from_assistant_reply(self, authed_client):
        user_db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(ASSISTANT_REPLY_WITH_RECIPE),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["generated_recipe"] is not None
        assert body["generated_recipe"]["title"] == "Dairy-Free Alfredo"

        # Assistant insert payload carries the parsed dict (not None)
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["generated_recipe"] is not None
        assert assistant_payload["generated_recipe"]["title"] == "Dairy-Free Alfredo"

    # ===== Group B — 404 paths =====

    def test_returns_404_for_missing_draft(self, authed_client):
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_NOT_FOUND"
        assert "Draft not found" in detail["message"]

    def test_returns_404_for_cross_user_draft_same_as_missing(self, authed_client):
        """Cross-user surfaces identically to missing via get_active_draft's
        user_id filter — locks the equivalence at the route boundary."""
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "DRAFT_NOT_FOUND"

    def test_returns_404_for_expired_draft(self, authed_client):
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_EXPIRED"
        assert "Draft expired" in detail["message"]

    def test_returns_404_for_missing_session(self, authed_client):
        # session_lookup_rows=[] → RLS-empty / not found
        user_db, _, _ = _mock_user_db(session_lookup_rows=[])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    def test_returns_404_for_recipe_anchored_session(self, authed_client):
        user_db, _, _ = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                    "source_draft_id": None,
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    def test_returns_404_for_session_anchored_to_different_draft(self, authed_client):
        user_db, _, _ = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(OTHER_DRAFT_ID),
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    # ===== Group C — Cap + tracking + ordering =====

    def test_returns_429_when_cap_exceeded(self, authed_client):
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded("cap reached", code="RIFF_DAILY_LIMIT"),
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 429
        assert "Daily Riff limit" in resp.json()["detail"]

    def test_returns_500_when_tracking_fails_no_user_msg_no_claude(
        self, authed_client
    ):
        user_db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn",
            side_effect=RiffUsageTrackingError(
                "track failed", code="RIFF_USAGE_INCREMENT_FAILED"
            ),
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 500
        # Locked Phase 13.7 invariant: no orphan user row on tracking failure
        messages_table.insert.assert_not_called()
        # No Claude dispatch
        anthropic_client.messages.create.assert_not_called()

    def test_record_called_before_user_message_insert(self, authed_client):
        """Order: record_riff_turn must fire BEFORE the user-row insert.

        Wraps messages_table.insert with a thin interceptor that snapshots
        the record_riff_turn call count at the moment any insert fires.
        """
        user_db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        record_spy = MagicMock()
        record_count_when_first_insert: list[int] = []

        original_insert = messages_table.insert

        def _insert_wrapper(*args, **kwargs):
            if not record_count_when_first_insert:
                record_count_when_first_insert.append(record_spy.call_count)
            return original_insert(*args, **kwargs)

        messages_table.insert = _insert_wrapper

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn", new=record_spy
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        # When the first messages_table.insert fired (the user message),
        # record_riff_turn had already been called exactly once.
        assert record_count_when_first_insert == [1]

    def test_draft_validation_before_cap_check(self, authed_client):
        """Expired draft → 404 BEFORE 429, even when cap is exhausted.

        Locks the contract §4 route order: draft validation precedes cap
        check, preventing cap-status leakage on non-owned anchors.
        """
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        cap_spy = MagicMock()
        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap", new=cap_spy
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "DRAFT_EXPIRED"
        cap_spy.assert_not_called()

    def test_session_validation_before_cap_check(self, authed_client):
        """Recipe-anchored session_id → 404 BEFORE 429."""
        user_db, _, _ = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                    "source_draft_id": None,
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        cap_spy = MagicMock()
        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap", new=cap_spy
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        cap_spy.assert_not_called()

    def test_does_not_call_claude_when_expired(self, authed_client):
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ), patch(
            "api.routes.riff.get_anthropic_client"
        ) as anthropic_ctor:
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 404
        anthropic_ctor.assert_not_called()

    def test_does_not_call_claude_when_cap_exceeded(self, authed_client):
        user_db, _, _ = _mock_user_db()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded("cap reached", code="RIFF_DAILY_LIMIT"),
        ), patch(
            "api.routes.riff.get_anthropic_client"
        ) as anthropic_ctor:
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 429
        anthropic_ctor.assert_not_called()

    # ===== Group D — entry_point + adapter integration =====

    def test_new_session_defaults_entry_point_to_draft_review(self, authed_client):
        user_db, sessions_table, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        assert sessions_table.insert.call_args.args[0]["entry_point"] == "draft_review"

    def test_new_session_custom_entry_point_persisted_as_is(self, authed_client):
        user_db, sessions_table, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={"message": "go", "entry_point": "custom_surface"},
            )

        assert resp.status_code == 200
        assert (
            sessions_table.insert.call_args.args[0]["entry_point"]
            == "custom_surface"
        )

    def test_existing_session_does_not_mutate_entry_point(self, authed_client):
        user_db, sessions_table, _ = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(FAKE_DRAFT_ID),
                }
            ],
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "reply",
                    "created_at": "2026-05-10T12:00:01+00:00",
                },
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_RIFF_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "more",
                    # Body sends a custom entry_point on a reused session;
                    # route must NOT mutate the existing row's value.
                    "entry_point": "should_be_ignored",
                },
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()

    def test_run_riff_turn_receives_adapter_output_not_raw_draft(self, authed_client):
        """Spy on run_riff_turn: recipe kwarg must be the 6-key Slice C
        adapter projection, NOT the full draft dict with confidence_score,
        expires_at, raw_model_json, etc."""
        user_db, _, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "msg",
                    "created_at": "2026-05-10T12:00:00+00:00",
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_client(),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ), patch(
            "api.routes.riff.run_riff_turn", return_value=ASSISTANT_REPLY
        ) as spy:
            resp = authed_client.post(DRAFT_RIFF_URL, json={"message": "go"})

        assert resp.status_code == 200
        spy.assert_called_once()
        recipe_arg = spy.call_args.kwargs["recipe"]

        # Contract §5.1 — exactly 6 keys
        assert set(recipe_arg.keys()) == {
            "title",
            "servings",
            "prep_time",
            "cook_time",
            "ingredients",
            "steps",
        }

        # Contract §5.2 — none of these out-of-scope draft columns leak
        forbidden = {
            "confidence_score",
            "expires_at",
            "image_storage_keys",
            "source_url",
            "raw_model_json",
            "model_version",
            "parser_version",
            "id",
            "user_id",
            "created_at",
            "updated_at",
        }
        assert forbidden.isdisjoint(recipe_arg.keys())


# =============================================================================
# Helpers — Phase 13.9 Slice E (draft stream)
# =============================================================================
#
# Streaming tests use the same module-level patching pattern as recipe
# stream (tests/test_riff_stream.py). Helpers below duplicate the small
# surface needed locally; refactor to conftest only if Slice F continues
# to add streaming-flavored helpers.


DRAFT_STREAM_URL = f"/api/drafts/{FAKE_DRAFT_ID}/riff/stream"
FAKE_USER_MSG_ID = UUID("00000000-0000-0000-0000-000000000030")
FAKE_ASSISTANT_MSG_ID = UUID("00000000-0000-0000-0000-000000000040")


def _fake_settings(*, riff_streaming_enabled: bool = True) -> SimpleNamespace:
    """Minimal stand-in for api.routes.riff.get_settings() in stream tests."""
    return SimpleNamespace(
        riff_streaming_enabled=riff_streaming_enabled,
        anthropic_api_key="test-key",
    )


def _make_rate_limit_error(message: str = "rate limit hit") -> anthropic.RateLimitError:
    """Real anthropic.RateLimitError for use as a stream side_effect."""
    request = httpx.Request("POST", "http://test/v1/messages")
    response = httpx.Response(429, request=request)
    return anthropic.RateLimitError(message, response=response, body=None)


def _make_connection_error(
    message: str = "conn dropped",
) -> anthropic.APIConnectionError:
    """Real anthropic.APIConnectionError for use as a stream side_effect."""
    request = httpx.Request("POST", "http://test/v1/messages")
    return anthropic.APIConnectionError(request=request, message=message)


def _make_text_stream(deltas, raise_after_n=None, exc=None):
    """Generator yielding deltas, optionally raising after `raise_after_n`
    yields.

    raise_after_n=0  -> raises before any yield (pre-first-byte failure).
    raise_after_n=N  -> raises after yielding N deltas (mid-stream failure).
    """
    for i, d in enumerate(deltas):
        if raise_after_n is not None and i == raise_after_n:
            assert exc is not None
            raise exc
        yield d
    if (
        raise_after_n is not None
        and raise_after_n >= len(deltas)
        and exc is not None
    ):
        raise exc


def _mock_anthropic_stream_client(
    *,
    deltas=None,
    raise_on_open=None,
    raise_after_n=None,
    raise_during_iteration_exc=None,
) -> MagicMock:
    """Build an anthropic.Anthropic mock whose .messages.stream() is a CM.

    Mirrors tests/test_riff_stream.py::_mock_anthropic_stream_client. The
    context manager's __enter__ returns an object exposing `text_stream`
    (the generator); __exit__ is a no-op stub.
    """
    cm = MagicMock()
    if raise_on_open is not None:
        cm.__enter__ = MagicMock(side_effect=raise_on_open)
    else:
        stream_obj = MagicMock()
        stream_obj.text_stream = _make_text_stream(
            deltas or [], raise_after_n, raise_during_iteration_exc
        )
        cm.__enter__ = MagicMock(return_value=stream_obj)
    cm.__exit__ = MagicMock(return_value=False)

    client = MagicMock()
    client.messages.stream = MagicMock(return_value=cm)
    return client


def _mock_user_db_for_stream(
    *,
    session_lookup_rows=None,
    session_insert_id=None,
    history_rows=None,
    user_insert_id=None,
    assistant_insert_id=None,
    assistant_insert_raises=None,
    assistant_insert_returns_empty: bool = False,
) -> tuple[MagicMock, MagicMock, MagicMock]:
    """Build (user_db, sessions_table, messages_table) for stream tests.

    Distinguishes user-insert (first call) from assistant-insert (second
    call) via a counter on insert side_effect. Mirrors
    tests/test_riff_stream.py::_mock_user_db_for_stream.
    """
    sessions_table = MagicMock()
    messages_table = MagicMock()

    if session_insert_id is not None:
        sessions_table.insert.return_value.execute.return_value.data = [
            {"id": str(session_insert_id)}
        ]
    if session_lookup_rows is not None:
        (
            sessions_table.select.return_value.eq.return_value.execute.return_value
        ).data = session_lookup_rows

    user_id_str = str(user_insert_id) if user_insert_id else str(uuid4())
    asst_id_str = (
        str(assistant_insert_id) if assistant_insert_id else str(uuid4())
    )

    insert_call_count = {"n": 0}

    def _insert_side_effect(payload):
        insert_call_count["n"] += 1
        result = MagicMock()
        if insert_call_count["n"] == 1:
            # user row
            result.execute.return_value.data = [{"id": user_id_str}]
        else:
            # assistant row
            if assistant_insert_raises is not None:
                result.execute.side_effect = assistant_insert_raises
            elif assistant_insert_returns_empty:
                result.execute.return_value.data = []
            else:
                result.execute.return_value.data = [{"id": asst_id_str}]
        return result

    messages_table.insert.side_effect = _insert_side_effect

    (
        messages_table.select.return_value.eq.return_value.order.return_value.execute.return_value
    ).data = history_rows or []

    def _table(name: str) -> MagicMock:
        if name == "riff_sessions":
            return sessions_table
        if name == "riff_messages":
            return messages_table
        raise AssertionError(f"unexpected table: {name}")

    user_db = MagicMock()
    user_db.table.side_effect = _table
    return user_db, sessions_table, messages_table


def _parse_sse_stream(text: str) -> list[tuple[str, dict]]:
    """Parse SSE response body into [(event_name, data_dict), ...]."""
    events: list[tuple[str, dict]] = []
    for raw_frame in text.split("\n\n"):
        frame = raw_frame.strip()
        if not frame:
            continue
        event_name = ""
        data_payload = ""
        for line in frame.split("\n"):
            if line.startswith("event: "):
                event_name = line[len("event: "):]
            elif line.startswith("data: "):
                data_payload = line[len("data: "):]
        events.append(
            (event_name, json.loads(data_payload) if data_payload else {})
        )
    return events


# =============================================================================
# Tests — Phase 13.9 Slice E (draft stream)
# =============================================================================


class TestRiffDraftStreamEndpoint:
    """POST /api/drafts/{draft_id}/riff/stream."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        """Default DB overrides so auth doesn't reject before route body runs."""
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # ===== Group A — Happy paths =====

    def test_draft_stream_creates_new_session_when_session_id_absent(
        self, authed_client
    ):
        user_db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["hello"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        # session_resolved event surfaces the inserted session id
        first = events[0]
        assert first[0] == "session_resolved"
        assert first[1]["session_id"] == str(FAKE_SESSION_ID)

        # Session insert payload locks the draft-anchor fields
        sessions_table.insert.assert_called_once()
        insert_payload = sessions_table.insert.call_args.args[0]
        assert insert_payload["user_id"] == str(FAKE_USER_ID)
        assert insert_payload["source_recipe_id"] is None
        assert insert_payload["source_draft_id"] == str(FAKE_DRAFT_ID)
        assert insert_payload["entry_point"] == "draft_review"

    def test_draft_stream_reuses_existing_draft_anchored_session(
        self, authed_client
    ):
        user_db, sessions_table, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(FAKE_DRAFT_ID),
                }
            ],
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "reply",
                    "created_at": "2026-05-10T12:00:01+00:00",
                },
            ],
        )
        stream_client = _mock_anthropic_stream_client(deltas=["new reply"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "more",
                },
            )

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        # session_resolved surfaces the reused session id
        assert events[0] == ("session_resolved", {"session_id": str(FAKE_SESSION_ID)})

        # No insert on the sessions table — reuse only
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()

    def test_draft_stream_event_ordering_session_user_deltas_complete_done(
        self, authed_client
    ):
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["a", "b", "c"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        # Locked Phase 13.5 ordering: session_resolved → user_message_committed
        # → assistant_delta × N → assistant_complete → done
        assert names == [
            "session_resolved",
            "user_message_committed",
            "assistant_delta",
            "assistant_delta",
            "assistant_delta",
            "assistant_complete",
            "done",
        ]

    def test_draft_stream_seq_counter_increments_monotonically(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["x", "y", "z", "w"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        events = _parse_sse_stream(resp.text)
        deltas = [e for e in events if e[0] == "assistant_delta"]
        seqs = [e[1]["seq"] for e in deltas]
        assert seqs == [0, 1, 2, 3]

    def test_draft_stream_emits_generated_recipe_ready_when_block_present(
        self, authed_client
    ):
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        # Single delta carrying the full fenced-block reply
        stream_client = _mock_anthropic_stream_client(
            deltas=[ASSISTANT_REPLY_WITH_RECIPE]
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        # generated_recipe_ready BETWEEN assistant_complete and done
        complete_idx = names.index("assistant_complete")
        gen_idx = names.index("generated_recipe_ready")
        done_idx = names.index("done")
        assert complete_idx < gen_idx < done_idx

        gen_event = next(e for e in events if e[0] == "generated_recipe_ready")
        assert gen_event[1]["generated_recipe"]["title"] == "Dairy-Free Alfredo"

    def test_draft_stream_assistant_insert_includes_generated_recipe_field(
        self, authed_client
    ):
        user_db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["hello"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        # Two inserts: user (call 0), assistant (call 1)
        assert messages_table.insert.call_count == 2
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["role"] == "assistant"
        # Append-only: generated_recipe lives in the same INSERT (no UPDATE).
        assert "generated_recipe" in assistant_payload

    # ===== Group B — Flag-off + 404 paths =====

    def test_draft_stream_returns_404_when_streaming_flag_off(self, authed_client):
        with patch(
            "api.routes.riff.get_settings",
            return_value=_fake_settings(riff_streaming_enabled=False),
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "hi"})
        assert resp.status_code == 404
        # JSON HTTP error response, NOT an SSE stream
        assert resp.headers.get("content-type", "").startswith("application/json")

    def test_draft_stream_returns_404_for_missing_draft(self, authed_client):
        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_NOT_FOUND"

    def test_draft_stream_returns_404_for_expired_draft(self, authed_client):
        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_EXPIRED"

    def test_draft_stream_returns_404_for_missing_session(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream(session_lookup_rows=[])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    def test_draft_stream_returns_404_for_recipe_anchored_session(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                    "source_draft_id": None,
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    def test_draft_stream_returns_404_for_session_anchored_to_different_draft(
        self, authed_client
    ):
        user_db, _, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(OTHER_DRAFT_ID),
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "go"},
            )

        assert resp.status_code == 404

    # ===== Group C — Cap + tracking + ordering =====

    def test_draft_stream_returns_429_when_cap_exceeded(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded("cap reached", code="RIFF_DAILY_LIMIT"),
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 429
        assert "Daily Riff limit" in resp.json()["detail"]

    def test_draft_stream_returns_500_when_tracking_fails_no_user_msg_no_stream(
        self, authed_client
    ):
        user_db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client"
        ) as anthropic_ctor, patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn",
            side_effect=RiffUsageTrackingError(
                "track failed", code="RIFF_USAGE_INCREMENT_FAILED"
            ),
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 500
        # No user-message insert and no Anthropic SDK construction
        messages_table.insert.assert_not_called()
        anthropic_ctor.assert_not_called()

    def test_draft_stream_draft_validation_before_cap_check(self, authed_client):
        """Expired draft → 404 BEFORE 429 even when cap is exhausted."""
        user_db, _, _ = _mock_user_db_for_stream()
        _install_overrides(authed_client, user_db)

        cap_spy = MagicMock()
        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap", new=cap_spy
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "DRAFT_EXPIRED"
        cap_spy.assert_not_called()

    def test_draft_stream_no_claude_when_expired(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ), patch(
            "api.routes.riff.get_anthropic_client"
        ) as anthropic_ctor:
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 404
        anthropic_ctor.assert_not_called()

    def test_draft_stream_no_claude_when_cap_exceeded(self, authed_client):
        user_db, _, _ = _mock_user_db_for_stream()
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded("cap reached", code="RIFF_DAILY_LIMIT"),
        ), patch(
            "api.routes.riff.get_anthropic_client"
        ) as anthropic_ctor:
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 429
        anthropic_ctor.assert_not_called()

    # ===== Group D — Orphan filter + SSE error events =====

    def test_draft_stream_applies_drop_orphaned_user_rows_before_dispatch(
        self, authed_client
    ):
        """Locks contract §4: _drop_orphaned_user_rows applied on draft stream
        (read-side filter; append-only RLS preserved)."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "old orphan",
                    "created_at": "2026-05-09T12:00:00+00:00",
                },
                {
                    "role": "user",
                    "content": "this turn",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
            ],
        )
        stream_client = _mock_anthropic_stream_client(deltas=["ok"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ), patch(
            "api.routes.riff._drop_orphaned_user_rows",
            side_effect=lambda rows: rows,
        ) as orphan_spy:
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "this turn"})

        assert resp.status_code == 200
        orphan_spy.assert_called_once()

    def test_draft_stream_emits_error_event_on_pre_first_byte_failure_retryable(
        self, authed_client
    ):
        """Pre-first-byte RATE_LIMIT → error event with retryable=True
        (per §16-G + _PRE_FIRST_BYTE_RETRYABLE_CODES)."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
        )
        # raise_after_n=0 → raises before any yield
        stream_client = _mock_anthropic_stream_client(
            deltas=["never_yielded"],
            raise_after_n=0,
            raise_during_iteration_exc=_make_rate_limit_error(),
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        error_event = next(e for e in events if e[0] == "error")
        assert error_event[1]["code"] == "RATE_LIMIT"
        assert error_event[1]["retryable"] is True
        # error followed by done; no assistant_delta, no assistant_complete
        assert "assistant_delta" not in names
        assert "assistant_complete" not in names
        assert names[-1] == "done"

    def test_draft_stream_emits_error_event_on_pre_first_byte_failure_non_retryable(
        self, authed_client
    ):
        """Pre-first-byte MODEL_ERROR-class failure → retryable=False."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
        )
        # Construct a status-error that's NOT 408/504 → MODEL_ERROR classification
        request = httpx.Request("POST", "http://test/v1/messages")
        response = httpx.Response(500, request=request)
        api_status_err = anthropic.APIStatusError(
            "internal", response=response, body=None
        )
        stream_client = _mock_anthropic_stream_client(
            deltas=["never_yielded"],
            raise_after_n=0,
            raise_during_iteration_exc=api_status_err,
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        error_event = next(e for e in events if e[0] == "error")
        assert error_event[1]["code"] == "MODEL_ERROR"
        assert error_event[1]["retryable"] is False

    def test_draft_stream_emits_error_event_on_mid_stream_failure_not_retryable(
        self, authed_client
    ):
        """Mid-stream failures (delta_count > 0) → always retryable=False
        per Phase 13.5 §16-G."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
        )
        # Yield 2 deltas, then raise
        stream_client = _mock_anthropic_stream_client(
            deltas=["one", "two", "never"],
            raise_after_n=2,
            raise_during_iteration_exc=_make_connection_error(),
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        # 2 deltas emitted before the error
        assert names.count("assistant_delta") == 2
        error_event = next(e for e in events if e[0] == "error")
        # Mid-stream: retryable=False regardless of the underlying code
        assert error_event[1]["retryable"] is False
        # No assistant_complete (insert never happened)
        assert "assistant_complete" not in names
        assert names[-1] == "done"

    def test_draft_stream_emits_error_event_on_assistant_insert_failure(
        self, authed_client
    ):
        """SDK stream completes normally but assistant INSERT raises →
        error event with INTERNAL_ERROR + retryable=False; no
        assistant_complete event."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_raises=Exception("db boom"),
        )
        stream_client = _mock_anthropic_stream_client(deltas=["hello"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        error_event = next(e for e in events if e[0] == "error")
        assert error_event[1]["code"] == "INTERNAL_ERROR"
        assert error_event[1]["retryable"] is False
        assert "assistant_complete" not in names
        assert names[-1] == "done"

    # ===== Group E — entry_point + adapter integration =====

    def test_draft_stream_new_session_defaults_entry_point_to_draft_review(
        self, authed_client
    ):
        user_db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["ok"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        assert (
            sessions_table.insert.call_args.args[0]["entry_point"]
            == "draft_review"
        )

    def test_draft_stream_new_session_custom_entry_point_persisted_as_is(
        self, authed_client
    ):
        user_db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        stream_client = _mock_anthropic_stream_client(deltas=["ok"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={"message": "go", "entry_point": "custom_surface"},
            )

        assert resp.status_code == 200
        assert (
            sessions_table.insert.call_args.args[0]["entry_point"]
            == "custom_surface"
        )

    def test_draft_stream_existing_session_does_not_mutate_entry_point(
        self, authed_client
    ):
        user_db, sessions_table, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": None,
                    "source_draft_id": str(FAKE_DRAFT_ID),
                }
            ],
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier",
                    "created_at": "2026-05-10T12:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "reply",
                    "created_at": "2026-05-10T12:00:01+00:00",
                },
            ],
        )
        stream_client = _mock_anthropic_stream_client(deltas=["ok"])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=stream_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                DRAFT_STREAM_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "more",
                    "entry_point": "should_be_ignored",
                },
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()

    def test_draft_stream_passes_adapter_output_to_run_riff_turn_stream(
        self, authed_client
    ):
        """Spy on run_riff_turn_stream: recipe kwarg must be the Slice C
        6-key adapter projection, NOT the full draft dict."""
        user_db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            user_insert_id=FAKE_USER_MSG_ID,
            assistant_insert_id=FAKE_ASSISTANT_MSG_ID,
        )
        _install_overrides(authed_client, user_db)

        # Patch run_riff_turn_stream entirely; .return_value is iterated
        # by the route's for-loop. iter([]) yields zero deltas — the route
        # still emits assistant_complete (zero-delta success path).
        with patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.get_active_draft", return_value=_fake_active_draft()
        ), patch(
            "api.routes.riff.get_anthropic_client",
            return_value=_mock_anthropic_stream_client(deltas=[]),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ), patch(
            "api.routes.riff.run_riff_turn_stream", return_value=iter([])
        ) as stream_spy:
            resp = authed_client.post(DRAFT_STREAM_URL, json={"message": "go"})

        assert resp.status_code == 200
        stream_spy.assert_called_once()
        recipe_arg = stream_spy.call_args.kwargs["recipe"]

        # Contract §5.1 — exactly 6 keys
        assert set(recipe_arg.keys()) == {
            "title",
            "servings",
            "prep_time",
            "cook_time",
            "ingredients",
            "steps",
        }
        # Contract §5.2 — out-of-scope columns absent
        forbidden = {
            "confidence_score",
            "expires_at",
            "image_storage_keys",
            "source_url",
            "raw_model_json",
            "model_version",
            "parser_version",
            "id",
            "user_id",
            "created_at",
            "updated_at",
        }
        assert forbidden.isdisjoint(recipe_arg.keys())


# =============================================================================
# Helpers — Phase 13.9 Slice F (draft save)
# =============================================================================
#
# Save tests mock get_active_draft + user_db lookups (session / recipe /
# message) + the save_draft_riff wrapper. They never hit Supabase or
# Anthropic. The recipes-table lookup is exercised only when the route's
# step 2a discriminator path runs (session.source_draft_id IS NULL).


DRAFT_SAVE_URL = f"/api/drafts/{FAKE_DRAFT_ID}/riff/save"
FAKE_NEW_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000099")
OTHER_SESSION_ID = UUID("00000000-0000-0000-0000-000000000050")


# Valid ParsedRecipe-shape generated_recipe (passes model_validate).
# Mirrors tests/test_riff.py::VALID_GENERATED_RECIPE.
VALID_GENERATED_RECIPE = {
    "title": "Dairy-Free Alfredo",
    "servings": "4",
    "prep_time": "10 min",
    "cook_time": "20 min",
    "confidence": 1.0,
    "ingredients": [
        {"quantity": "1", "unit": "cup", "name": "cashews", "prep": "soaked"},
    ],
    "steps": [
        {"position": 1, "instruction": "Blend cashews with water until smooth."},
    ],
}


_UNSET = object()


def _fake_save_session_row(
    *,
    source_recipe_id: str | None = None,
    source_draft_id: str | None = None,
    session_id: UUID = FAKE_SESSION_ID,
) -> dict:
    """Build a riff_sessions row for save-route tests.

    Per Slice A CHECK, exactly one of source_recipe_id / source_draft_id
    is non-null in real data. Tests pass arbitrary combinations to
    exercise route validation paths.
    """
    return {
        "id": str(session_id),
        "source_recipe_id": source_recipe_id,
        "source_draft_id": source_draft_id,
    }


def _fake_save_message_row(
    *,
    message_id: UUID = FAKE_ASSISTANT_MSG_ID,
    session_id: UUID | None = None,
    generated_recipe=_UNSET,
) -> dict:
    """Build a riff_messages row for save-route tests.

    generated_recipe sentinel: pass _UNSET (default) to inject
    VALID_GENERATED_RECIPE; pass None explicitly to test the 422 path;
    pass an arbitrary dict to inject test-specific shapes.
    """
    if generated_recipe is _UNSET:
        generated_recipe = VALID_GENERATED_RECIPE
    return {
        "id": str(message_id),
        "session_id": str(session_id) if session_id else str(FAKE_SESSION_ID),
        "generated_recipe": generated_recipe,
    }


def _mock_user_db_for_save(
    *,
    session_lookup_rows: list[dict] | None = None,
    recipe_lookup_rows: list[dict] | None = None,
    message_lookup_rows: list[dict] | None = None,
) -> MagicMock:
    """Build a user_db MagicMock for the draft save route.

    The route reads up to three tables:
      - riff_sessions (always)
      - recipes (only when session.source_draft_id IS NULL — for the
        bidirectional-link discriminator)
      - riff_messages (only when session is draft-anchored to this draft)

    Each lookup is configured independently. Default None -> empty data.
    """
    sessions_table = MagicMock()
    recipes_table = MagicMock()
    messages_table = MagicMock()

    sessions_table.select.return_value.eq.return_value.execute.return_value.data = (
        session_lookup_rows or []
    )
    recipes_table.select.return_value.eq.return_value.execute.return_value.data = (
        recipe_lookup_rows or []
    )
    messages_table.select.return_value.eq.return_value.execute.return_value.data = (
        message_lookup_rows or []
    )

    def _table(name: str) -> MagicMock:
        if name == "riff_sessions":
            return sessions_table
        if name == "recipes":
            return recipes_table
        if name == "riff_messages":
            return messages_table
        raise AssertionError(f"unexpected table: {name}")

    user_db = MagicMock()
    user_db.table.side_effect = _table
    return user_db


# =============================================================================
# Tests — Phase 13.9 Slice F (draft save)
# =============================================================================


@pytest.fixture(autouse=True)
def _stub_step_mapping():
    """Issue 1: the draft save route runs a save-time mapper + atomic attach
    after a created save. Stub both for every test in this module so no test
    can reach the live provider; the focused wiring test below asserts the
    stage itself.
    """
    with patch(
        "api.routes.riff.map_ingredients_to_steps", return_value=[[1]]
    ) as mapper, patch(
        "api.routes.riff.apply_step_mapping", return_value="complete"
    ) as apply_mock:
        yield SimpleNamespace(mapper=mapper, apply=apply_mock)


class TestRiffDraftSaveEndpoint:
    """POST /api/drafts/{draft_id}/riff/save."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # ===== Group A — Happy path =====

    def test_draft_save_happy_path_returns_riff_save_response(self, authed_client):
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                    "riff_label": "Dairy-Free",
                },
            )

        assert resp.status_code == 200
        assert resp.json()["recipe_id"] == str(FAKE_NEW_RECIPE_ID)

    def test_draft_save_response_shape_is_exactly_recipe_id(self, authed_client):
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        # Locked RiffSaveResponse shape — exactly one key.
        assert set(body.keys()) == {"recipe_id"}
        UUID(body["recipe_id"])  # valid UUID string

    def test_draft_save_does_not_call_cap_or_record_riff_turn(self, authed_client):
        """Save is not a billable Riff turn per contract §9 (matches recipe
        save). Neither cap-check nor turn-record is invoked."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        cap_spy = MagicMock()
        record_spy = MagicMock()
        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap", new=cap_spy
        ), patch(
            "api.routes.riff.record_riff_turn", new=record_spy
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 200
        cap_spy.assert_not_called()
        record_spy.assert_not_called()

    # ===== Group B — Draft validation =====

    def test_draft_save_missing_draft_returns_404_dict(self, authed_client):
        """A NON-migrated draft-anchored session with the draft genuinely
        missing still surfaces DRAFT_NOT_FOUND (the draft check now runs
        after the session-state checks)."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_NOT_FOUND"
        assert "Draft not found" in detail["message"]

    def test_draft_save_expired_draft_returns_404_dict(self, authed_client):
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftExpiredError(
                f"Draft expired: {FAKE_DRAFT_ID}",
                code="DRAFT_EXPIRED",
            ),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert detail["code"] == "DRAFT_EXPIRED"
        assert "Draft expired" in detail["message"]

    # ===== Group C — Session validation =====

    def test_draft_save_missing_session_returns_404(self, authed_client):
        user_db = _mock_user_db_for_save(session_lookup_rows=[])
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    @pytest.mark.parametrize(
        "recipe_riff_session_id",
        [None, str(OTHER_SESSION_ID)],
        ids=["null_riff_session_id", "different_session_id"],
    )
    def test_draft_save_plain_recipe_anchored_session_returns_404(
        self, authed_client, recipe_riff_session_id
    ):
        """Discriminator path: source_draft_id IS NULL, but the source
        recipe's riff_session_id does NOT match body.session_id. The
        session is plain recipe-anchored (or anchored to a recipe created
        by a different session) — NOT a valid save target for this
        draft. 404, non-leaky. Resolved without touching the draft."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(
                    source_recipe_id=str(FAKE_RECIPE_ID),
                    source_draft_id=None,
                )
            ],
            recipe_lookup_rows=[
                {
                    "id": str(FAKE_RECIPE_ID),
                    "riff_session_id": recipe_riff_session_id,
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    def test_draft_save_already_migrated_returns_409(self, authed_client):
        """POST-COMMIT RETRY REALITY: a successful save deleted the draft,
        so the retry arrives with the draft GONE. The route must resolve
        the migrated session to 409 ALREADY_SAVED without ever requiring
        the deleted draft (contract §9.1). Discriminator hit:
        session.source_recipe_id points at a recipe whose riff_session_id
        == body.session_id."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(
                    source_recipe_id=str(FAKE_NEW_RECIPE_ID),
                    source_draft_id=None,
                )
            ],
            recipe_lookup_rows=[
                {
                    "id": str(FAKE_NEW_RECIPE_ID),
                    # Bidirectional link — this recipe was created by THIS session
                    "riff_session_id": str(FAKE_SESSION_ID),
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ) as draft_mock:
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "ALREADY_SAVED"
        # The migrated path never touches the (correctly deleted) draft.
        draft_mock.assert_not_called()

    def test_draft_save_409_detail_includes_existing_recipe_id(self, authed_client):
        """409 detail body carries the existing recipe_id so mobile
        (Slice G+) can navigate forward gracefully per contract §9.1,
        with the draft gone, as it genuinely is after the commit."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(
                    source_recipe_id=str(FAKE_NEW_RECIPE_ID),
                    source_draft_id=None,
                )
            ],
            recipe_lookup_rows=[
                {
                    "id": str(FAKE_NEW_RECIPE_ID),
                    "riff_session_id": str(FAKE_SESSION_ID),
                }
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            side_effect=DraftNotFoundError(
                f"Draft not found: {FAKE_DRAFT_ID}",
                code="DRAFT_NOT_FOUND",
            ),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["recipe_id"] == str(FAKE_NEW_RECIPE_ID)

    def test_draft_save_different_draft_session_returns_404(self, authed_client):
        """Session anchored to OTHER_DRAFT_ID, not the URL's draft_id."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(OTHER_DRAFT_ID))
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        assert "Riff session not found" in resp.json()["detail"]

    # ===== Group D — Message + generated_recipe validation =====

    def test_draft_save_missing_message_returns_404(self, authed_client):
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        assert "Riff message not found" in resp.json()["detail"]

    def test_draft_save_message_cross_session_returns_404(self, authed_client):
        """Message exists but belongs to a different session
        (defensive — URL session_id is the source of truth)."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[
                _fake_save_message_row(session_id=OTHER_SESSION_ID)
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 404
        assert "Riff message not found" in resp.json()["detail"]

    def test_draft_save_no_generated_recipe_returns_422(self, authed_client):
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[
                _fake_save_message_row(generated_recipe=None)
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 422
        assert "No generated recipe" in resp.json()["detail"]

    def test_draft_save_invalid_generated_recipe_returns_422(self, authed_client):
        """ParsedRecipe re-validation catches schema drift between
        extraction time and save time. An empty dict is missing all
        required fields → ValidationError → 422."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[
                _fake_save_message_row(generated_recipe={})
            ],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 422
        assert "Generated recipe failed validation" in resp.json()["detail"]

    # ===== Group E — Wrapper integration =====

    def test_draft_save_wrapper_failure_returns_500(self, authed_client):
        """Generic wrapper failure (StorageError with non-422 code) → 500."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            side_effect=StorageError(
                "Save RPC failed: RuntimeError: db connection lost",
                code="RPC_FAILED",
            ),
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 500
        assert "Failed to save riff recipe" in resp.json()["detail"]

    def test_draft_save_calls_wrapper_with_exact_params(self, authed_client):
        """Spy on save_draft_riff: kwargs match the request body 1:1, and
        user_supabase is the same user_db object the route received."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ) as wrapper_spy:
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                    "riff_label": "Dairy-Free",
                },
            )

        assert resp.status_code == 200
        wrapper_spy.assert_called_once()
        kwargs = wrapper_spy.call_args.kwargs
        assert kwargs["draft_id"] == FAKE_DRAFT_ID
        assert kwargs["session_id"] == FAKE_SESSION_ID
        assert kwargs["message_id"] == FAKE_ASSISTANT_MSG_ID
        assert kwargs["riff_label"] == "Dairy-Free"
        assert kwargs["user_supabase"] is user_db

    def test_draft_save_created_runs_mapper_and_attach(
        self, authed_client, _stub_step_mapping
    ):
        """Issue 1 wiring: a created save runs the save-time mapper over the
        generated recipe and attaches the result to the new recipe id.
        Failure softness is owned by apply_step_mapping (never raises)."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 200
        _stub_step_mapping.mapper.assert_called_once()
        mapper_args = _stub_step_mapping.mapper.call_args.args
        generated = _fake_save_message_row()["generated_recipe"]
        assert mapper_args[0] == generated["ingredients"]
        assert mapper_args[1] == generated["steps"]
        _stub_step_mapping.apply.assert_called_once()
        apply_args = _stub_step_mapping.apply.call_args.args
        assert apply_args[0] == str(FAKE_NEW_RECIPE_ID)
        assert apply_args[1] == [[1]]
        # Issue 3: creation producers attach against content_rev DEFAULT 1.
        assert (
            _stub_step_mapping.apply.call_args.kwargs["expected_content_rev"]
            == 1
        )

    def test_draft_save_already_migrated_skips_mapper(
        self, authed_client, _stub_step_mapping
    ):
        """Idempotent 409 retry path never re-runs the mapper."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "already_migrated",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ):
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                },
            )

        assert resp.status_code == 409
        _stub_step_mapping.mapper.assert_not_called()
        _stub_step_mapping.apply.assert_not_called()

    def test_draft_save_omitted_riff_label_passes_none(self, authed_client):
        """Omitted riff_label in request body → wrapper called with
        riff_label=None (Pydantic default)."""
        user_db = _mock_user_db_for_save(
            session_lookup_rows=[
                _fake_save_session_row(source_draft_id=str(FAKE_DRAFT_ID))
            ],
            message_lookup_rows=[_fake_save_message_row()],
        )
        _install_overrides(authed_client, user_db)

        with patch(
            "api.routes.riff.get_active_draft",
            return_value=_fake_active_draft(),
        ), patch(
            "api.routes.riff.save_draft_riff",
            return_value={
                "status": "created",
                "recipe_id": str(FAKE_NEW_RECIPE_ID),
            },
        ) as wrapper_spy:
            resp = authed_client.post(
                DRAFT_SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_ASSISTANT_MSG_ID),
                    # riff_label intentionally omitted
                },
            )

        assert resp.status_code == 200
        assert wrapper_spy.call_args.kwargs["riff_label"] is None


# =============================================================================
# PROVIDER-S1.1 closure W1 — draft-save persistence pin (SQL contract)
# =============================================================================


class TestDraftSaveRpcPrepPersistenceContract:
    """W1 pin: the draft-anchored save path persists ingredient `prep`.

    Python passes only IDs to the save_draft_riff_recipe RPC; the ingredient
    INSERT lives in migrations/023_save_draft_riff_recipe.sql. This pins the
    SQL contract so a future migration edit cannot silently drop the
    substitution label the Grocery provenance pipeline depends on.
    """

    def test_migration_023_ingredient_insert_includes_prep(self):
        from pathlib import Path

        sql = (
            Path(__file__).resolve().parent.parent
            / "migrations"
            / "023_save_draft_riff_recipe.sql"
        ).read_text(encoding="utf-8")
        assert "(recipe_id, position, quantity, unit, name, prep)" in sql
        assert "v_ingredient->>'prep'" in sql
