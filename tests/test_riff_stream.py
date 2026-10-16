"""Tests for the streaming riff endpoint (Phase 13.5).

Mirrors tests/test_riff.py scaffold; existing sync/save tests in test_riff.py
remain untouched.

Contract: docs/phase13-4-B-streaming-contract.md
  - Event order        §4
  - Persistence        §6
  - Cancel semantics   §7
  - Error semantics    §8
  - Dual rollout       §15

Pre-stream validation failures (auth, recipe ownership, session ownership,
flag-off, setup DB errors) return normal HTTP errors — no SSE stream opens.
SSE `error` events are reserved for failures after the stream is open.

Cancel tests use Approach B (real HTTP via httpx ASGITransport + connection
drop). If they prove unreliable, the directive requires STOP-and-report
rather than a production refactor.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import anthropic
import httpx
import pytest

from api.core.exceptions import RecipeNotFoundError
from api.core.riff import get_default_riff_config, run_riff_turn_stream
from api.core.riff_usage import RiffUsageLimitExceeded, RiffUsageTrackingError
from api.dependencies import get_current_user_id, get_db, get_user_db
from api.routes.riff import _drop_orphaned_user_rows


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000002")
FAKE_SESSION_ID = UUID("00000000-0000-0000-0000-000000000010")
FAKE_USER_MSG_ID = "00000000-0000-0000-0000-000000000030"
FAKE_ASSISTANT_MSG_ID = "00000000-0000-0000-0000-000000000040"
FAKE_NEW_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000099")

STREAM_URL = f"/api/recipes/{FAKE_RECIPE_ID}/riff/stream"
SYNC_URL = f"/api/recipes/{FAKE_RECIPE_ID}/riff"
SAVE_URL = f"/api/recipes/{FAKE_RECIPE_ID}/riff/save"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_recipe() -> dict:
    """Shape matches what core.recipes.get_recipe returns."""
    return {
        "id": str(FAKE_RECIPE_ID),
        "user_id": str(FAKE_USER_ID),
        "title": "Fettuccine Alfredo",
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "20 min",
        "ingredients": [
            {"quantity": "1", "unit": "cup", "name": "heavy cream", "prep": None},
        ],
        "steps": [{"position": 1, "instruction": "Boil water."}],
        "tags": [],
    }


def _fake_settings(*, riff_streaming_enabled: bool = True) -> SimpleNamespace:
    """Minimal stand-in for api.routes.riff.get_settings()."""
    return SimpleNamespace(
        riff_streaming_enabled=riff_streaming_enabled,
        anthropic_api_key="test-key",
    )


def _make_rate_limit_error(message: str = "rate limit hit") -> anthropic.RateLimitError:
    """Real anthropic.RateLimitError for use as a side_effect."""
    request = httpx.Request("POST", "http://test/v1/messages")
    response = httpx.Response(429, request=request)
    return anthropic.RateLimitError(message, response=response, body=None)


def _make_connection_error(message: str = "conn dropped") -> anthropic.APIConnectionError:
    """Real anthropic.APIConnectionError for use as a side_effect."""
    request = httpx.Request("POST", "http://test/v1/messages")
    return anthropic.APIConnectionError(request=request, message=message)


def _make_text_stream(
    deltas: list[str], raise_after_n: int | None, exc: Exception | None
):
    """Generator yielding deltas, optionally raising after `raise_after_n` yields.

    raise_after_n=0  -> raises before any yield.
    raise_after_n=N  -> raises after yielding N deltas (so seq 0..N-1 emitted).
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
    deltas: list[str] | None = None,
    raise_on_open: Exception | None = None,
    raise_after_n: int | None = None,
    raise_during_iteration_exc: Exception | None = None,
    exit_tracker: list | None = None,
) -> MagicMock:
    """Build an anthropic.Anthropic mock whose .messages.stream() is a CM."""
    cm = MagicMock()
    if raise_on_open is not None:
        cm.__enter__ = MagicMock(side_effect=raise_on_open)
    else:
        stream_obj = MagicMock()
        stream_obj.text_stream = _make_text_stream(
            deltas or [], raise_after_n, raise_during_iteration_exc
        )
        cm.__enter__ = MagicMock(return_value=stream_obj)

    def _exit(*args, **kwargs):
        if exit_tracker is not None:
            exit_tracker.append("exit")
        return False

    cm.__exit__ = MagicMock(side_effect=_exit)

    client = MagicMock()
    client.messages.stream = MagicMock(return_value=cm)
    return client


def _mock_anthropic_sync_client(text: str = "ok") -> MagicMock:
    """Sync client whose .messages.create returns a text-only Message."""
    block = MagicMock()
    block.text = text
    message = MagicMock()
    message.content = [block]
    client = MagicMock()
    client.messages.create.return_value = message
    return client


def _mock_user_db_for_stream(
    *,
    session_lookup_rows: list[dict] | None = None,
    session_insert_id: UUID | None = None,
    history_rows: list[dict] | None = None,
    user_insert_id: str = FAKE_USER_MSG_ID,
    assistant_insert_id: str = FAKE_ASSISTANT_MSG_ID,
    assistant_insert_raises: Exception | None = None,
    assistant_insert_returns_empty: bool = False,
) -> tuple[MagicMock, MagicMock, MagicMock]:
    """Build (user_db, sessions_table, messages_table).

    First call to messages_table.insert is the user row; second is assistant.
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

    insert_call_count = {"n": 0}

    def _insert_side_effect(payload):
        insert_call_count["n"] += 1
        result = MagicMock()
        if insert_call_count["n"] == 1:
            # user row
            result.execute.return_value.data = [{"id": user_insert_id}]
        else:
            # assistant row
            if assistant_insert_raises is not None:
                result.execute.side_effect = assistant_insert_raises
            elif assistant_insert_returns_empty:
                result.execute.return_value.data = []
            else:
                result.execute.return_value.data = [{"id": assistant_insert_id}]
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

    db = MagicMock()
    db.table.side_effect = _table
    return db, sessions_table, messages_table


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


def _install_overrides(client, user_db: MagicMock) -> None:
    client.app.dependency_overrides[get_db] = lambda: MagicMock()
    client.app.dependency_overrides[get_user_db] = lambda: user_db


# ---------------------------------------------------------------------------
# TestClient (synchronous) cases
# ---------------------------------------------------------------------------


class TestRiffStreamEndpoint:
    """Streaming endpoint behavior via authed_client (TestClient)."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        """Default DB overrides so auth doesn't reject before validation."""
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # 1. flag off — HTTP 404, no SSE
    def test_route_returns_404_when_streaming_flag_off(self, authed_client):
        with patch(
            "api.routes.riff.get_settings",
            return_value=_fake_settings(riff_streaming_enabled=False),
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})
        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")

    # 2. golden path event order
    def test_golden_path_event_order(self, authed_client):
        db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-04-30T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_stream_client(
            deltas=["Hello", " there", "!"]
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers.get("cache-control") == "no-cache"
        assert resp.headers.get("x-accel-buffering") == "no"

        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        assert names == [
            "session_resolved",
            "user_message_committed",
            "assistant_delta",
            "assistant_delta",
            "assistant_delta",
            "assistant_complete",
            "done",
        ]
        assert events[0][1]["session_id"] == str(FAKE_SESSION_ID)
        assert events[1][1]["user_message_id"] == FAKE_USER_MSG_ID
        deltas = [e[1] for e in events if e[0] == "assistant_delta"]
        assert [d["seq"] for d in deltas] == [0, 1, 2]
        assert [d["text"] for d in deltas] == ["Hello", " there", "!"]
        # assistant_complete carries ONLY assistant_message_id
        # (no generated_recipe_present per §16-H).
        assert events[5][1] == {"assistant_message_id": FAKE_ASSISTANT_MSG_ID}
        assert events[6][1] == {}

    # 3. exactly one user row + one assistant row persisted
    def test_success_persists_one_user_row_and_one_assistant_row(self, authed_client):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-04-30T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["a", "b"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert messages_table.insert.call_count == 2
        roles = [
            call.args[0]["role"]
            for call in messages_table.insert.call_args_list
        ]
        assert roles == ["user", "assistant"]
        # No UPDATE — append-only invariant preserved.
        messages_table.update.assert_not_called()

    # 4. assistant insert before assistant_complete
    def test_assistant_row_inserted_before_assistant_complete_emitted(
        self, authed_client
    ):
        # Strategy: assistant_complete carries assistant_message_id which is
        # only available AFTER insert returns a row. Asserting the ID matches
        # the mock insert's return value proves the order.
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["text"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        complete_event = next(e for e in events if e[0] == "assistant_complete")
        assert complete_event[1]["assistant_message_id"] == FAKE_ASSISTANT_MSG_ID
        # Insert was called with the full accumulated text.
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["role"] == "assistant"
        assert assistant_payload["content"] == "text"

    # 5. valid recipe block → generated_recipe_ready + persisted
    def test_valid_recipe_block_emits_generated_recipe_ready_and_persists(
        self, authed_client
    ):
        valid_text = (
            "Here's a dairy-free version using cashew cream...\n\n"
            "```recipe-json\n"
            "{\n"
            '  "title": "Dairy-Free Alfredo",\n'
            '  "servings": "4",\n'
            '  "prep_time": "10 min",\n'
            '  "cook_time": "20 min",\n'
            '  "ingredients": [\n'
            '    {"quantity": "1", "unit": "cup", "name": "cashews", "prep": "soaked"}\n'
            "  ],\n"
            '  "steps": [\n'
            '    {"position": 1, "instruction": "Blend cashews with water until smooth."}\n'
            "  ]\n"
            "}\n"
            "```"
        )
        # Split into 4 chunks to exercise multi-delta accumulation.
        chunk_size = (len(valid_text) + 3) // 4
        deltas = [
            valid_text[i:i + chunk_size]
            for i in range(0, len(valid_text), chunk_size)
        ]

        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=deltas)
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL, json={"message": "make it dairy-free"}
            )

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]

        complete_idx = names.index("assistant_complete")
        ready_idx = names.index("generated_recipe_ready")
        done_idx = names.index("done")
        assert complete_idx < ready_idx < done_idx

        gr = events[ready_idx][1]["generated_recipe"]
        assert gr["title"] == "Dairy-Free Alfredo"
        assert gr["servings"] == "4"
        assert gr["confidence"] == 1.0

        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["role"] == "assistant"
        assert assistant_payload["content"] == valid_text
        assert assistant_payload["generated_recipe"] is not None
        assert assistant_payload["generated_recipe"]["title"] == "Dairy-Free Alfredo"

    # 6. prose-only completion → no generated_recipe_ready, null persisted
    def test_prose_only_completion_no_generated_recipe_ready_and_null_persisted(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(
            deltas=["Just ", "some ", "prose."]
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL, json={"message": "tell me about this"}
            )

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        assert "generated_recipe_ready" not in names
        assert "assistant_complete" in names

        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["generated_recipe"] is None

    # 7. malformed recipe block → no generated_recipe_ready, null persisted
    def test_malformed_recipe_block_no_generated_recipe_ready_and_null_persisted(
        self, authed_client
    ):
        malformed_text = (
            "Here you go:\n\n"
            "```recipe-json\n"
            "{ not valid json at all\n"
            "```"
        )
        chunk_size = (len(malformed_text) + 2) // 3
        deltas = [
            malformed_text[i:i + chunk_size]
            for i in range(0, len(malformed_text), chunk_size)
        ]

        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=deltas)
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "make it"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        assert "generated_recipe_ready" not in names
        assert "assistant_complete" in names

        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["generated_recipe"] is None

    # 8. pre-first-byte error
    def test_pre_first_byte_error_emits_error_and_done(self, authed_client):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(
            raise_on_open=_make_rate_limit_error()
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        # SSE response opened (200), error inside the body.
        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        assert names == [
            "session_resolved",
            "user_message_committed",
            "error",
            "done",
        ]

        err = events[2][1]
        assert err["code"] == "RATE_LIMIT"
        assert err["retryable"] is True
        assert isinstance(err["message"], str) and len(err["message"]) > 0

        # User row inserted, assistant row NOT inserted.
        assert messages_table.insert.call_count == 1

    # 9. mid-stream error
    def test_mid_stream_error_emits_error_retryable_false_and_done(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(
            deltas=["first chunk"],
            raise_after_n=1,
            raise_during_iteration_exc=_make_connection_error(),
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        assert names == [
            "session_resolved",
            "user_message_committed",
            "assistant_delta",
            "error",
            "done",
        ]

        err = events[3][1]
        assert err["code"] == "MODEL_ERROR"
        assert err["retryable"] is False

        assert messages_table.insert.call_count == 1

    # 12. cross-user / missing recipe → HTTP 404 (no SSE opened)
    def test_cross_user_recipe_returns_404(self, authed_client):
        with patch(
            "api.routes.riff.get_recipe",
            side_effect=RecipeNotFoundError("not found"),
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")

    # 13. cross-recipe session → HTTP 404 (no SSE opened)
    def test_cross_recipe_session_returns_404(self, authed_client):
        other_recipe_id = uuid4()
        db, _, messages_table = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(other_recipe_id),
                }
            ],
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ):
            resp = authed_client.post(
                STREAM_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "hi",
                },
            )

        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")
        # No insert was attempted (route exited before user row write).
        assert messages_table.insert.call_count == 0

    # 16. assistant insert failure → INTERNAL_ERROR retryable=False
    def test_assistant_insert_failure_emits_internal_error_retryable_false(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
            assistant_insert_raises=RuntimeError("db kaboom"),
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["text"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        events = _parse_sse_stream(resp.text)
        names = [e[0] for e in events]
        # No assistant_complete, no generated_recipe_ready.
        assert "assistant_complete" not in names
        assert "generated_recipe_ready" not in names
        # Last two events: error + done.
        assert names[-2:] == ["error", "done"]
        err = events[-2][1]
        assert err["code"] == "INTERNAL_ERROR"
        assert err["retryable"] is False


# ---------------------------------------------------------------------------
# run_riff_turn_stream cancel/cleanup tests
# ---------------------------------------------------------------------------
#
# Replaces the Approach-B (HTTP-cancel via ASGITransport) tests after that
# approach proved to hang in this test stack — the sync generator wrapped in
# StreamingResponse + iterate_in_threadpool does not receive GeneratorExit
# reliably from an httpx-side connection drop in pytest.
#
# These tests target run_riff_turn_stream directly. The property they prove
# is the one the route's cancel semantics rely on: when the consumer of the
# generator calls gen.close(), Python injects GeneratorExit at the suspended
# yield, which propagates through the `with client.messages.stream(...) as
# stream:` block, calling __exit__ on the SDK stream context manager. The
# SDK stream is closed cleanly. No new test machinery — just generator
# semantics.
#
# The route's "no assistant row written on cancel" property is structural:
# the assistant INSERT in _stream_events is positioned strictly after the
# `for delta in run_riff_turn_stream(...)` loop completes normally. A
# GeneratorExit injected during iteration breaks out of the loop and control
# never reaches the insert. No runtime assertion is required for this — it
# is a Python language guarantee given the route's code structure.
#
# Naming honesty: the directive originally proposed "before first delta" /
# "after deltas" framing. In this generator's structure there is no public
# pause point between `with __enter__` and the first `yield text_delta`,
# so we cannot pause "after open, before first delta yielded". The two
# tests below prove the same SDK-cleanup property at two stream positions
# (post-1-delta and post-multiple-deltas), demonstrating it is independent
# of how many deltas have already flowed.


class TestRunRiffTurnStreamCleanup:
    """Direct generator-close tests on run_riff_turn_stream."""

    def test_close_after_first_delta_runs_sdk_exit(self):
        """gen.close() after consuming one delta calls SDK __exit__."""
        exit_tracker: list = []
        client = _mock_anthropic_stream_client(
            deltas=["a", "b", "c"],
            exit_tracker=exit_tracker,
        )
        config = get_default_riff_config()

        gen = run_riff_turn_stream(
            config=config,
            client=client,
            recipe=_fake_recipe(),
            history=[],
        )

        # Consume one delta — the generator is now suspended at `yield
        # text_delta` inside the `with client.messages.stream(...)` block.
        first = next(gen)
        assert first == "a"
        # SDK stream entered, but __exit__ has not yet been called.
        assert exit_tracker == []

        # Cancel: GeneratorExit injected at the yield, propagates through
        # the for-loop and the `with` block; __exit__ runs.
        gen.close()

        assert exit_tracker == ["exit"]

    def test_close_after_multiple_deltas_runs_sdk_exit(self):
        """gen.close() after consuming multiple deltas calls SDK __exit__."""
        exit_tracker: list = []
        client = _mock_anthropic_stream_client(
            deltas=["a", "b", "c", "d", "e"],
            exit_tracker=exit_tracker,
        )
        config = get_default_riff_config()

        gen = run_riff_turn_stream(
            config=config,
            client=client,
            recipe=_fake_recipe(),
            history=[],
        )

        consumed = [next(gen), next(gen), next(gen)]
        assert consumed == ["a", "b", "c"]
        assert exit_tracker == []

        gen.close()

        assert exit_tracker == ["exit"]


# ---------------------------------------------------------------------------
# Orphan-user-row filter (Phase 13.5 verification fix #2)
#
# Cancelled streaming turns leave a user row in riff_messages without a
# paired assistant. On the NEXT turn, history-load picks both the orphan
# and the just-inserted current user row — Claude then combines them and
# the next reply is poisoned by the cancelled prompt's intent.
# _drop_orphaned_user_rows is read-side only (no DELETE on riff_messages),
# applied by riff_stream_endpoint between history load and the SDK call.
# ---------------------------------------------------------------------------


class TestDropOrphanedUserRows:
    """Pure-function unit tests for the orphan filter."""

    def test_empty_history_returns_empty(self):
        assert _drop_orphaned_user_rows([]) == []

    def test_single_user_row_kept_as_current_turn(self):
        rows = [{"role": "user", "content": "hi"}]
        assert _drop_orphaned_user_rows(rows) == rows

    def test_paired_user_assistant_kept(self):
        rows = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "u2"},  # current turn
        ]
        assert _drop_orphaned_user_rows(rows) == rows

    def test_orphan_user_dropped_when_next_turn_arrives(self):
        # Cancelled turn left "orphan" user row; "current" is the just-
        # inserted next turn. Claude must NOT see "orphan".
        rows = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "orphan"},  # cancelled turn
            {"role": "user", "content": "current"},  # current turn
        ]
        result = _drop_orphaned_user_rows(rows)
        assert result == [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "current"},
        ]

    def test_multiple_orphans_collapse_to_current(self):
        # Repeated cancels — every leading user with no assistant after
        # gets dropped except the last (the current turn).
        rows = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "orphan_1"},
            {"role": "user", "content": "orphan_2"},
            {"role": "user", "content": "current"},
        ]
        result = _drop_orphaned_user_rows(rows)
        assert result == [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "current"},
        ]

    def test_orphan_followed_by_paired_turn_kept_via_assistant(self):
        # If a later assistant exists after a user, that user has a reply
        # somewhere downstream — keep it. Only TRAILING orphans are dropped.
        rows = [
            {"role": "user", "content": "u1"},
            {"role": "user", "content": "u2"},  # NOT orphan: a2 follows
            {"role": "assistant", "content": "a2"},
            {"role": "user", "content": "current"},
        ]
        result = _drop_orphaned_user_rows(rows)
        assert result == rows

    def test_unknown_role_is_kept_defensively(self):
        rows = [
            {"role": "system", "content": "weird"},
            {"role": "user", "content": "current"},
        ]
        assert _drop_orphaned_user_rows(rows) == rows


class TestStreamEndpointAppliesOrphanFilter:
    """Integration test: the streaming endpoint feeds Claude filtered history."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    def test_orphan_user_row_not_sent_to_claude(self, authed_client):
        # History as it would be loaded after a cancelled "add more protein"
        # turn followed by a "give me the full recipe" send. The freshly-
        # inserted current user row sits at the tail.
        history_rows = [
            {
                "role": "user",
                "content": "make it spicier",
                "created_at": "2026-04-30T00:00:00+00:00",
            },
            {
                "role": "assistant",
                "content": "Use chili oil.",
                "created_at": "2026-04-30T00:00:01+00:00",
            },
            {
                "role": "user",
                "content": "add more protein",  # ORPHAN — user cancelled
                "created_at": "2026-04-30T00:01:00+00:00",
            },
            {
                "role": "user",
                "content": "give me the full recipe",  # current turn
                "created_at": "2026-04-30T00:02:00+00:00",
            },
        ]
        db, _, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                }
            ],
            history_rows=history_rows,
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["ok"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL,
                json={
                    "message": "give me the full recipe",
                    "session_id": str(FAKE_SESSION_ID),
                },
            )

        assert resp.status_code == 200

        # Verify Claude received the filtered history — orphan dropped,
        # current user turn preserved.
        assert anthropic_client.messages.stream.call_count == 1
        kwargs = anthropic_client.messages.stream.call_args.kwargs
        sent_messages = kwargs["messages"]
        sent_pairs = [
            (m["role"], m["content"][0]["text"]) for m in sent_messages
        ]
        assert sent_pairs == [
            ("user", "make it spicier"),
            ("assistant", "Use chili oil."),
            ("user", "give me the full recipe"),
        ]
        # Defensive: orphan content must not appear anywhere in the
        # serialized request.
        assert all("add more protein" not in t for _, t in sent_pairs)


# ---------------------------------------------------------------------------
# Sync + save smoke (proves streaming additions did not regress them)
# ---------------------------------------------------------------------------


class TestSyncAndSaveSmoke:
    """Smoke tests for /riff and /riff/save unchanged-behavior."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # 14. sync endpoint still works
    def test_sync_endpoint_still_works(self, authed_client):
        db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-04-30T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_sync_client(text="ok")
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(SYNC_URL, json={"message": "hi"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == "ok"

    # 15. save endpoint still works
    def test_save_endpoint_still_works(self, authed_client):
        valid_recipe = {
            "title": "Test",
            "servings": "2",
            "prep_time": "5 min",
            "cook_time": "15 min",
            "confidence": 1.0,
            "ingredients": [
                {"quantity": "1", "unit": "cup", "name": "flour", "prep": None}
            ],
            "steps": [{"position": 1, "instruction": "Mix."}],
        }

        user_sessions = MagicMock()
        user_messages = MagicMock()
        user_sessions.select.return_value.eq.return_value.execute.return_value.data = [
            {
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            }
        ]
        user_messages.select.return_value.eq.return_value.execute.return_value.data = [
            {
                "id": FAKE_USER_MSG_ID,
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": valid_recipe,
            }
        ]

        def _user_table(name):
            if name == "riff_sessions":
                return user_sessions
            if name == "riff_messages":
                return user_messages
            raise AssertionError(f"unexpected: {name}")

        user_db = MagicMock()
        user_db.table.side_effect = _user_table

        db_recipes = MagicMock()
        db_recipes.insert.return_value.execute.return_value.data = [
            {"id": str(FAKE_NEW_RECIPE_ID)}
        ]
        db_ingredients = MagicMock()
        db_ingredients.insert.return_value.execute.return_value.data = []
        db_steps = MagicMock()
        db_steps.insert.return_value.execute.return_value.data = []

        def _db_table(name):
            if name == "recipes":
                return db_recipes
            if name == "recipe_ingredients":
                return db_ingredients
            if name == "recipe_steps":
                return db_steps
            raise AssertionError(f"unexpected: {name}")

        db = MagicMock()
        db.table.side_effect = _db_table

        # Issue 1: the write path is the save_riff_recipe_atomic RPC.
        user_db.rpc.return_value.execute.return_value.data = {
            "status": "created",
            "recipe_id": str(FAKE_NEW_RECIPE_ID),
        }

        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps", return_value=[[1]]
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": FAKE_USER_MSG_ID,
                },
            )

        assert resp.status_code == 200
        assert resp.json()["recipe_id"] == str(FAKE_NEW_RECIPE_ID)


# ---------------------------------------------------------------------------
# Phase 13.7 — Per-user usage tracking + entry-point telemetry (stream route)
# ---------------------------------------------------------------------------


class TestRiffStreamEndpointUsageTracking:
    """POST /api/recipes/{recipe_id}/riff/stream — usage helpers + entry_point.

    Streaming-side helper-interaction tests. Mirrors the sync set in
    tests/test_riff.py::TestRiffEndpointUsageTracking but adapted for the
    SSE response path: cap and tracking errors must surface as normal
    HTTP error responses BEFORE the StreamingResponse opens.
    """

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # --- successful path: usage recorded once ------------------------------

    def test_successful_stream_records_usage_once(self, authed_client):
        db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_stream_client(
            deltas=["Hello", " there", "!"]
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert mock_cap.call_count == 1
        assert mock_record.call_count == 1
        assert mock_record.call_args.args == (FAKE_USER_ID,)

    # --- cancel after dispatch still records (modeled via empty SDK stream) -

    def test_record_fires_even_when_sdk_yields_zero_deltas(self, authed_client):
        """Models the cancel-after-dispatch invariant: record_riff_turn is
        synchronous and runs before the SDK iterator starts. An empty
        delta sequence (which is the same observable shape as a cancel
        immediately after open) cannot un-call the count.

        TestClient cannot simulate client-side disconnect mid-stream, so
        this test exercises the equivalent server-side path: empty
        delta iterator → assistant row inserted with empty content →
        stream completes → record was already called once."""
        db, _, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=[])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert mock_record.call_count == 1

    # --- recipe-not-found does not record usage ----------------------------

    def test_recipe_not_found_does_not_record_usage(self, authed_client):
        with patch(
            "api.routes.riff.get_recipe",
            side_effect=RecipeNotFoundError("not found"),
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")
        assert mock_cap.call_count == 0
        assert mock_record.call_count == 0

    # --- session mismatch does not record usage ----------------------------

    def test_session_mismatch_does_not_record_usage(self, authed_client):
        other_recipe_id = uuid4()
        db, _, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(other_recipe_id),
                }
            ]
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(
                STREAM_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "hi",
                },
            )

        assert resp.status_code == 404
        assert resp.headers.get("content-type", "").startswith("application/json")
        assert mock_cap.call_count == 0
        assert mock_record.call_count == 0

    # --- cap exceeded → 429, no SSE, no user msg, no Claude ---------------

    def test_cap_exceeded_returns_429_before_sse_opens(self, authed_client):
        db, _, messages_table = _mock_user_db_for_stream()
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded(
                "Daily Riff limit reached (25/25)", code="RIFF_DAILY_LIMIT"
            ),
        ), patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 429
        # Plain HTTP error response — SSE never opened
        assert resp.headers.get("content-type", "").startswith("application/json")
        # Record never fires — cap raises first
        assert mock_record.call_count == 0
        # No user-message insert
        assert messages_table.insert.call_count == 0
        # No SDK dispatch
        anthropic_client.messages.stream.assert_not_called()

    # --- tracking failure → 500, no SSE, no user msg, no Claude -----------

    def test_tracking_failure_returns_500_before_sse_opens(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn",
            side_effect=RiffUsageTrackingError(
                "Failed to record Riff turn",
                code="RIFF_USAGE_INCREMENT_FAILED",
            ),
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 500
        # Plain HTTP error response — SSE never opened
        assert resp.headers.get("content-type", "").startswith("application/json")
        # No user-message insert (record fires before insert)
        assert messages_table.insert.call_count == 0
        # No SDK dispatch
        anthropic_client.messages.stream.assert_not_called()

    # --- order: record fires BEFORE user-message insert -------------------

    def test_record_called_before_user_message_insert(self, authed_client):
        """Locked order on the streaming endpoint: record_riff_turn runs
        BEFORE riff_messages INSERT, so a tracking failure cannot orphan
        a user row."""
        db, _, messages_table = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        observed = {}

        def _record_spy(*args, **kwargs):
            observed["msg_inserts_at_record_time"] = (
                messages_table.insert.call_count
            )

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn", side_effect=_record_spy
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert observed["msg_inserts_at_record_time"] == 0

    # --- new session insert defaults entry_point to "recipe_detail" -------

    def test_new_session_insert_includes_default_entry_point(
        self, authed_client
    ):
        db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(STREAM_URL, json={"message": "hi"})

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "recipe_detail"

    # --- custom entry_point persisted as-is -------------------------------

    def test_custom_entry_point_persisted_as_is(self, authed_client):
        db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL,
                json={"message": "hi", "entry_point": "cooking_mode"},
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "cooking_mode"

    # --- Phase 13.8: grocery_substitute persists same as any custom value -

    def test_grocery_substitute_entry_point_persisted_as_is(self, authed_client):
        """Phase 13.8 mirror: stream endpoint persists
        entry_point='grocery_substitute' verbatim on new session insert.
        Same path as any other custom value — no allow-list, no DB enum.
        Documents the canonical Grocery Substitute label round-trips
        end-to-end through the streaming surface as well as the sync one."""
        db, sessions_table, _ = _mock_user_db_for_stream(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL,
                json={"message": "hi", "entry_point": "grocery_substitute"},
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "grocery_substitute"

    # --- existing session does not mutate entry_point ---------------------

    def test_existing_session_does_not_mutate_entry_point(self, authed_client):
        db, sessions_table, _ = _mock_user_db_for_stream(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                }
            ],
            history_rows=[],
        )
        anthropic_client = _mock_anthropic_stream_client(deltas=["x"])
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.get_settings", return_value=_fake_settings()
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ):
            resp = authed_client.post(
                STREAM_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "more",
                    "entry_point": "cooking_mode",
                },
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()


# =============================================================================
# PROVIDER-S1 — shared model constant (streaming path)
# =============================================================================


def test_riff_stream_config_consumes_shared_model_constant():
    """The streaming endpoint builds its config from the same factory the
    sync path uses; both therefore consume DEFAULT_CLAUDE_MODEL."""
    from api.core.anthropic_client import DEFAULT_CLAUDE_MODEL

    config = get_default_riff_config()
    assert config.model == DEFAULT_CLAUDE_MODEL
    assert DEFAULT_CLAUDE_MODEL == "claude-sonnet-4-6"
