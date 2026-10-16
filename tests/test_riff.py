"""Tests for the riff endpoint (Phase 13.1).

Placement note: preflight nominated tests/api/test_riff.py, but this repo
uses a flat tests/ layout (see test_cook_events.py, test_drafts.py, etc.).
Following the real convention.

Strategy:
- authed_client fixture provides a TestClient with get_current_user_id
  overridden to FAKE_USER_ID.
- Per-test dependency_overrides for get_db and get_user_db give us explicit
  mock Supabase clients without touching the real DB.
- api.routes.riff.get_recipe is patched to control recipe-ownership flow.
- api.routes.riff.get_anthropic_client is patched so messages.create is a
  MagicMock — exercising run_riff_turn for real against the mocked SDK.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from api.core.exceptions import RecipeNotFoundError
from api.core.riff import (
    MAX_RECIPE_BLOCK_BYTES,
    RIFF_SYSTEM_PROMPT_TEMPLATE,
    _draft_to_riff_recipe_dict,
    build_riff_system_prompt,
    extract_recipe_block,
)
from api.core.riff_usage import RiffUsageLimitExceeded, RiffUsageTrackingError
from api.dependencies import get_db, get_user_db


FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000002")
FAKE_SESSION_ID = UUID("00000000-0000-0000-0000-000000000010")
FAKE_MESSAGE_ID = UUID("00000000-0000-0000-0000-000000000020")
FAKE_NEW_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000099")

ASSISTANT_REPLY = "Here's a dairy-free version using cashew cream..."

RIFF_URL = f"/api/recipes/{FAKE_RECIPE_ID}/riff"
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


def _mock_user_db(
    *,
    session_lookup_rows: list[dict] | None = None,
    session_insert_id: UUID | None = None,
    history_rows: list[dict] | None = None,
) -> tuple[MagicMock, MagicMock, MagicMock]:
    """Build a user_db MagicMock for the riff flow.

    Each call to user_db.table("riff_sessions") or ("riff_messages") returns
    a distinct child mock, configured per the scenario.
    """
    sessions_table = MagicMock()
    messages_table = MagicMock()

    # riff_sessions INSERT — only configured when session_insert_id is given
    if session_insert_id is not None:
        sessions_table.insert.return_value.execute.return_value.data = [
            {"id": str(session_insert_id)}
        ]

    # riff_sessions SELECT — only configured when session_lookup_rows is given
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

    db = MagicMock()
    db.table.side_effect = _table
    return db, sessions_table, messages_table


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
# Helpers — Phase 13.2 (/riff/save)
# ---------------------------------------------------------------------------


# Schema-aligned fixture for the JSONB stored on riff_messages.generated_recipe.
# Matches the 13.2 contract: ParsedRecipe fields with confidence injected,
# no raw_text on ingredients (the riff prompt does not elicit it).
VALID_GENERATED_RECIPE = {
    "title": "Dairy-Free Alfredo",
    "servings": "4",
    "prep_time": "10 min",
    "cook_time": "20 min",
    "confidence": 1.0,
    "ingredients": [
        {
            "quantity": "1",
            "unit": "cup",
            "name": "cashews",
            "prep": "soaked",
        },
    ],
    "steps": [
        {"position": 1, "instruction": "Blend cashews with water until smooth."},
    ],
}


def _mock_save_clients(
    *,
    session_row: dict | None = None,
    message_row: dict | None = None,
    inserted_recipe_id: UUID | None = None,
) -> tuple[MagicMock, MagicMock, MagicMock, MagicMock, MagicMock, MagicMock, MagicMock]:
    """Build (db, user_db, db_recipes, db_ingredients, db_steps,
    user_sessions, user_messages) mocks for the /riff/save endpoint.

    db handles recipes / recipe_ingredients / recipe_steps inserts.
    user_db handles riff_sessions / riff_messages selects.
    """
    user_sessions = MagicMock()
    user_messages = MagicMock()
    user_sessions.select.return_value.eq.return_value.execute.return_value.data = (
        [session_row] if session_row is not None else []
    )
    user_messages.select.return_value.eq.return_value.execute.return_value.data = (
        [message_row] if message_row is not None else []
    )

    def _user_table(name: str) -> MagicMock:
        if name == "riff_sessions":
            return user_sessions
        if name == "riff_messages":
            return user_messages
        raise AssertionError(f"unexpected user_db table: {name}")

    user_db = MagicMock()
    user_db.table.side_effect = _user_table
    # Issue 1: the write path is the save_riff_recipe_atomic RPC (user_db).
    user_db.rpc.return_value.execute.return_value.data = (
        {"status": "created", "recipe_id": str(inserted_recipe_id)}
        if inserted_recipe_id is not None
        else None
    )

    db_recipes = MagicMock()
    db_ingredients = MagicMock()
    db_steps = MagicMock()
    if inserted_recipe_id is not None:
        db_recipes.insert.return_value.execute.return_value.data = [
            {"id": str(inserted_recipe_id)}
        ]
    db_ingredients.insert.return_value.execute.return_value.data = []
    db_steps.insert.return_value.execute.return_value.data = []

    def _db_table(name: str) -> MagicMock:
        if name == "recipes":
            return db_recipes
        if name == "recipe_ingredients":
            return db_ingredients
        if name == "recipe_steps":
            return db_steps
        raise AssertionError(f"unexpected db table: {name}")

    db = MagicMock()
    db.table.side_effect = _db_table

    return (
        db,
        user_db,
        db_recipes,
        db_ingredients,
        db_steps,
        user_sessions,
        user_messages,
    )


# ---------------------------------------------------------------------------
# Tests — required coverage
# ---------------------------------------------------------------------------


class TestRiffEndpoint:
    """POST /api/recipes/{recipe_id}/riff."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        """Default-override the two DB deps for every test in this class.

        Without this, get_user_db -> get_bearer_token rejects with 401 before
        Pydantic body validation or get_recipe mocks can run, masking the
        real assertion (e.g. 422 / 404) under an Authorization-header error.

        Tests that need to drive DB behavior call `_install_overrides(...)`
        afterwards — later dict assignment replaces these defaults.
        """
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    def test_creates_session_when_session_id_absent(self, authed_client):
        db, sessions_table, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "Make it dairy-free",
                    "created_at": "2026-04-12T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL, json={"message": "Make it dairy-free"}
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == ASSISTANT_REPLY

        # Session was created, not looked up
        sessions_table.insert.assert_called_once()
        sessions_table.select.assert_not_called()

        # Two message inserts: user turn + assistant turn
        assert messages_table.insert.call_count == 2
        roles = [call.args[0]["role"] for call in messages_table.insert.call_args_list]
        assert roles == ["user", "assistant"]

        # Anthropic SDK was called exactly once
        anthropic_client.messages.create.assert_called_once()

    def test_reuses_session_when_session_id_provided(self, authed_client):
        db, sessions_table, messages_table = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                }
            ],
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier turn",
                    "created_at": "2026-04-12T00:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "earlier reply",
                    "created_at": "2026-04-12T00:00:01+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "And make it spicier",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == ASSISTANT_REPLY

        sessions_table.insert.assert_not_called()
        sessions_table.select.assert_called_once()
        assert messages_table.insert.call_count == 2

    def test_session_owned_by_other_user_returns_404(self, authed_client):
        # RLS causes cross-user SELECTs to return 0 rows.
        db, _, messages_table = _mock_user_db(session_lookup_rows=[])
        _install_overrides(authed_client, db)

        with patch("api.routes.riff.get_recipe", return_value=_fake_recipe()):
            resp = authed_client.post(
                RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "hello"},
            )

        assert resp.status_code == 404
        # No messages should have been written when session lookup fails.
        messages_table.insert.assert_not_called()

    def test_session_belongs_to_different_recipe_returns_404(self, authed_client):
        # Session exists + owned by this user, but points at another recipe.
        other_recipe_id = uuid4()
        db, _, messages_table = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(other_recipe_id),
                }
            ]
        )
        _install_overrides(authed_client, db)

        with patch("api.routes.riff.get_recipe", return_value=_fake_recipe()):
            resp = authed_client.post(
                RIFF_URL,
                json={"session_id": str(FAKE_SESSION_ID), "message": "hello"},
            )

        assert resp.status_code == 404
        messages_table.insert.assert_not_called()

    def test_recipe_owned_by_other_user_returns_404(self, authed_client):
        with patch(
            "api.routes.riff.get_recipe",
            side_effect=RecipeNotFoundError("not found"),
        ):
            resp = authed_client.post(RIFF_URL, json={"message": "hello"})

        assert resp.status_code == 404

    def test_empty_message_returns_422(self, authed_client):
        resp = authed_client.post(RIFF_URL, json={"message": ""})
        assert resp.status_code == 422

    def test_whitespace_only_message_returns_422(self, authed_client):
        resp = authed_client.post(RIFF_URL, json={"message": "   \n\t"})
        assert resp.status_code == 422

    def test_missing_message_returns_422(self, authed_client):
        resp = authed_client.post(RIFF_URL, json={})
        assert resp.status_code == 422

    def test_extra_field_returns_422(self, authed_client):
        resp = authed_client.post(
            RIFF_URL, json={"message": "hi", "surprise": "boom"}
        )
        assert resp.status_code == 422

    def test_anthropic_failure_returns_502(self, authed_client):
        db, _, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-04-12T00:00:00+00:00",
                },
            ],
        )

        # Anthropic client whose .messages.create blows up — caught by
        # run_riff_turn's final except-Exception branch → RiffError → 502.
        anthropic_client = MagicMock()
        anthropic_client.messages.create.side_effect = RuntimeError(
            "service unavailable"
        )

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
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 502

    # ------------------------------------------------------------------
    # Phase 13.2 — turn-time generated_recipe population
    # ------------------------------------------------------------------

    def test_assistant_text_with_valid_recipe_block_populates_generated_recipe(
        self, authed_client
    ):
        """Assistant reply containing a valid recipe-json block:
        - response includes session_id, assistant_message, assistant_message_id,
          and a non-null generated_recipe
        - the assistant-row INSERT payload includes generated_recipe populated
        """
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
        db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "make it dairy-free",
                    "created_at": "2026-04-12T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client(text=valid_text)
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
            resp = authed_client.post(
                RIFF_URL, json={"message": "make it dairy-free"}
            )

        assert resp.status_code == 200
        body = resp.json()

        # 13.1 backward-compat: original fields unchanged.
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == valid_text

        # 13.2 additive: assistant_message_id mirrors the mock's INSERT id.
        expected_id = (
            messages_table.insert.return_value.execute.return_value.data[0]["id"]
        )
        assert body["assistant_message_id"] == expected_id

        # 13.2 additive: generated_recipe is the validated ParsedRecipe dump.
        gr = body["generated_recipe"]
        assert gr is not None
        assert gr["title"] == "Dairy-Free Alfredo"
        assert gr["servings"] == "4"
        assert gr["confidence"] == 1.0
        assert len(gr["ingredients"]) == 1
        assert gr["ingredients"][0]["name"] == "cashews"
        assert len(gr["steps"]) == 1
        assert gr["steps"][0]["instruction"] == "Blend cashews with water until smooth."

        # Assistant-row INSERT payload includes generated_recipe populated
        # in the SAME insert (no follow-up UPDATE).
        assert messages_table.insert.call_count == 2
        # Index 0 is the user message insert; index 1 is the assistant row.
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["role"] == "assistant"
        assert assistant_payload["content"] == valid_text
        assert assistant_payload["generated_recipe"] is not None
        assert assistant_payload["generated_recipe"]["title"] == "Dairy-Free Alfredo"
        assert assistant_payload["generated_recipe"]["confidence"] == 1.0

        # No UPDATE was issued on the messages table.
        messages_table.update.assert_not_called()

    def test_assistant_text_without_recipe_block_returns_null_generated_recipe(
        self, authed_client
    ):
        """Assistant reply with no fenced block:
        - response includes generated_recipe = null
        - the assistant-row INSERT payload includes generated_recipe = None
          (explicit null, not omitted)
        """
        db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "tell me about this dish",
                    "created_at": "2026-04-12T00:00:00+00:00",
                },
            ],
        )
        # Default text from the helper has no fenced block.
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL, json={"message": "tell me about this dish"}
            )

        assert resp.status_code == 200
        body = resp.json()

        # 13.1 backward-compat preserved.
        assert body["session_id"] == str(FAKE_SESSION_ID)
        assert body["assistant_message"] == ASSISTANT_REPLY

        # 13.2 additive: assistant_message_id present, generated_recipe null.
        expected_id = (
            messages_table.insert.return_value.execute.return_value.data[0]["id"]
        )
        assert body["assistant_message_id"] == expected_id
        assert body["generated_recipe"] is None

        # Assistant-row INSERT payload includes the key explicitly set to None.
        assert messages_table.insert.call_count == 2
        # Index 0 is the user message insert; index 1 is the assistant row.
        assistant_payload = messages_table.insert.call_args_list[1].args[0]
        assert assistant_payload["role"] == "assistant"
        assert "generated_recipe" in assistant_payload
        assert assistant_payload["generated_recipe"] is None

        # No UPDATE was issued.
        messages_table.update.assert_not_called()


# ---------------------------------------------------------------------------
# Phase 13.2 — extract_recipe_block unit tests (pure function, no TestClient)
# ---------------------------------------------------------------------------


class TestExtractRecipeBlock:
    """Unit tests for api.core.riff.extract_recipe_block.

    Pure function — no DB, no network, no TestClient needed.
    Lives outside TestRiffEndpoint so the autouse DB-override fixture
    does not run for these tests.
    """

    VALID_BLOCK = (
        "Some prose intro.\n\n"
        "```recipe-json\n"
        "{\n"
        '  "title": "Test Recipe",\n'
        '  "servings": "2",\n'
        '  "prep_time": "5 min",\n'
        '  "cook_time": "15 min",\n'
        '  "ingredients": [\n'
        '    {"quantity": "1", "unit": "cup", "name": "flour", "prep": null}\n'
        "  ],\n"
        '  "steps": [\n'
        '    {"position": 1, "instruction": "Mix dry ingredients."}\n'
        "  ]\n"
        "}\n"
        "```"
    )

    def test_valid_block_returns_validated_dict(self):
        result = extract_recipe_block(self.VALID_BLOCK)
        assert result is not None
        assert result["title"] == "Test Recipe"
        assert result["servings"] == "2"
        assert result["prep_time"] == "5 min"
        assert result["cook_time"] == "15 min"
        assert len(result["ingredients"]) == 1
        assert result["ingredients"][0]["name"] == "flour"
        assert len(result["steps"]) == 1
        assert result["steps"][0]["position"] == 1

    def test_returned_dict_includes_confidence_1_0(self):
        result = extract_recipe_block(self.VALID_BLOCK)
        assert result is not None
        assert result["confidence"] == 1.0

    def test_no_block_returns_none(self):
        text = "Just prose, no recipe block here."
        assert extract_recipe_block(text) is None

    def test_malformed_json_returns_none(self):
        text = (
            "```recipe-json\n"
            "{ not valid json at all\n"
            "```"
        )
        assert extract_recipe_block(text) is None

    def test_payload_over_max_size_returns_none(self):
        # Schema-valid recipe with one field inflated past
        # MAX_RECIPE_BLOCK_BYTES so the size guard is what trips, not
        # validation. Padding the title is the cleanest way to overrun.
        huge_value = "x" * (MAX_RECIPE_BLOCK_BYTES + 100)
        text = (
            "```recipe-json\n"
            "{\n"
            f'  "title": "{huge_value}",\n'
            '  "servings": null,\n'
            '  "prep_time": null,\n'
            '  "cook_time": null,\n'
            '  "ingredients": [\n'
            '    {"quantity": null, "unit": null, "name": "salt", "prep": null}\n'
            "  ],\n"
            '  "steps": [\n'
            '    {"position": 1, "instruction": "Do something."}\n'
            "  ]\n"
            "}\n"
            "```"
        )
        assert extract_recipe_block(text) is None

    def test_multiple_blocks_last_wins(self):
        text = (
            "```recipe-json\n"
            "{\n"
            '  "title": "First",\n'
            '  "servings": null, "prep_time": null, "cook_time": null,\n'
            '  "ingredients": [{"quantity": null, "unit": null, "name": "salt", "prep": null}],\n'
            '  "steps": [{"position": 1, "instruction": "Add salt."}]\n'
            "}\n"
            "```\n"
            "Some prose between.\n"
            "```recipe-json\n"
            "{\n"
            '  "title": "Second",\n'
            '  "servings": null, "prep_time": null, "cook_time": null,\n'
            '  "ingredients": [{"quantity": null, "unit": null, "name": "pepper", "prep": null}],\n'
            '  "steps": [{"position": 1, "instruction": "Add pepper."}]\n'
            "}\n"
            "```"
        )
        result = extract_recipe_block(text)
        assert result is not None
        assert result["title"] == "Second"
        assert result["ingredients"][0]["name"] == "pepper"

    def test_missing_required_field_returns_none(self):
        # title is required (Field min_length=1) on ParsedRecipe.
        text = (
            "```recipe-json\n"
            "{\n"
            '  "servings": "2",\n'
            '  "ingredients": [],\n'
            '  "steps": []\n'
            "}\n"
            "```"
        )
        assert extract_recipe_block(text) is None

    def test_commas_inside_strings_preserved(self):
        # Proves we did NOT add a trailing-comma regex stripper that could
        # corrupt commas inside string values. Real JSON parsing only.
        text = (
            "```recipe-json\n"
            "{\n"
            '  "title": "Spice Mix",\n'
            '  "servings": null,\n'
            '  "prep_time": null,\n'
            '  "cook_time": null,\n'
            '  "ingredients": [\n'
            '    {"quantity": "1", "unit": "tsp", "name": "salt, pepper, and herbs", "prep": null}\n'
            "  ],\n"
            '  "steps": [\n'
            '    {"position": 1, "instruction": "Combine salt, pepper, and herbs thoroughly."}\n'
            "  ]\n"
            "}\n"
            "```"
        )
        result = extract_recipe_block(text)
        assert result is not None
        assert result["ingredients"][0]["name"] == "salt, pepper, and herbs"
        assert result["steps"][0]["instruction"] == "Combine salt, pepper, and herbs thoroughly."


# ---------------------------------------------------------------------------
# Phase 13.2 — POST /api/recipes/{recipe_id}/riff/save
# ---------------------------------------------------------------------------


class TestRiffSaveEndpoint:
    """POST /api/recipes/{recipe_id}/riff/save."""

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        """Mirrors the TestRiffEndpoint pattern: defaults so the auth
        dependency doesn't 401 before body / mocks resolve. Tests that
        need to drive DB behavior replace these via direct dict assignment.
        """
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    def test_happy_path_inserts_recipe_with_lineage(self, authed_client):
        """End-to-end: 200 + recipe_id, lineage + ingredients + steps written."""
        db, user_db, db_recipes, db_ingredients, db_steps, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": VALID_GENERATED_RECIPE,
            },
            inserted_recipe_id=FAKE_NEW_RECIPE_ID,
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps", return_value=[[1]]
        ) as mock_mapper:
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                    "riff_label": "Dairy-Free",
                },
            )

        assert resp.status_code == 200
        assert resp.json() == {"recipe_id": str(FAKE_NEW_RECIPE_ID)}

        # Issue 1: the base save is the atomic save_riff_recipe_atomic RPC
        # (one transaction, idempotent on source_riff_message_id). Recipe /
        # ingredient / step insert content, lineage columns, and the
        # no-raw_text 13.2 contract live in the migration 026 SQL body.
        user_db.rpc.assert_called_once()
        rpc_name, rpc_params = user_db.rpc.call_args.args
        assert rpc_name == "save_riff_recipe_atomic"
        assert rpc_params == {
            "p_recipe_id": str(FAKE_RECIPE_ID),
            "p_session_id": str(FAKE_SESSION_ID),
            "p_message_id": str(FAKE_MESSAGE_ID),
            "p_riff_label": "Dairy-Free",
        }
        # No Python-side child-table inserts remain on this path.
        db_recipes.insert.assert_not_called()
        db_ingredients.insert.assert_not_called()
        db_steps.insert.assert_not_called()

        # Save-time mapper ran over the generated recipe and its result was
        # attached atomically, then the outcome recorded as complete.
        mock_mapper.assert_called_once()
        db.rpc.assert_called_once()
        attach_name, attach_params = db.rpc.call_args.args
        assert attach_name == "attach_step_ingredient_mapping"
        # Issue 3: creation producers attach via the 3-arg rev-guarded RPC
        # against content_rev DEFAULT 1.
        assert attach_params == {
            "p_recipe_id": str(FAKE_NEW_RECIPE_ID),
            "p_expected_content_rev": 1,
            "p_mappings": [{"step_position": 1, "ingredient_positions": [1]}],
        }
        db_recipes.update.assert_called_once_with(
            {"step_mapping_outcome": "complete"}
        )

    def test_already_saved_retry_returns_409_with_recipe_id(self, authed_client):
        """Idempotent retry: RPC already_saved status -> 409 ALREADY_SAVED."""
        db, user_db, _, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": VALID_GENERATED_RECIPE,
            },
        )
        user_db.rpc.return_value.execute.return_value.data = {
            "status": "already_saved",
            "recipe_id": str(FAKE_NEW_RECIPE_ID),
        }
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps"
        ) as mock_mapper:
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "ALREADY_SAVED",
            "recipe_id": str(FAKE_NEW_RECIPE_ID),
        }
        # No second mapping pass on a retry.
        mock_mapper.assert_not_called()

    def test_mapper_failure_still_saves_with_degraded_outcome(
        self, authed_client
    ):
        """Mapper soft-failure: recipe saved, steps unknown, outcome degraded."""
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": VALID_GENERATED_RECIPE,
            },
            inserted_recipe_id=FAKE_NEW_RECIPE_ID,
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps", return_value=None
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        # Normal user-facing success: degradation is recorded internally.
        assert resp.status_code == 200
        assert resp.json() == {"recipe_id": str(FAKE_NEW_RECIPE_ID)}
        db.rpc.assert_not_called()
        db_recipes.update.assert_called_once_with(
            {"step_mapping_outcome": "degraded"}
        )

    def test_null_generated_recipe_returns_422(self, authed_client):
        """Message exists but generated_recipe is NULL → 422 cleaned message."""
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": None,
            },
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 422
        assert resp.json()["detail"] == "No generated recipe available for this message"
        db_recipes.insert.assert_not_called()

    def test_invalid_generated_recipe_returns_422(self, authed_client):
        """Stored generated_recipe fails ParsedRecipe.model_validate() → 422.

        Simulates schema drift / direct-DB tampering: missing required `title`.
        """
        invalid = {
            "servings": "4",
            "confidence": 1.0,
            "ingredients": [],
            "steps": [],
        }
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": invalid,
            },
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 422
        assert resp.json()["detail"] == "Generated recipe failed validation"
        db_recipes.insert.assert_not_called()

    def test_session_recipe_mismatch_returns_409(self, authed_client):
        """Session belongs to a different source recipe → 409."""
        other_recipe_id = uuid4()
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(other_recipe_id),
            },
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 409
        assert "does not belong" in resp.json()["detail"]
        db_recipes.insert.assert_not_called()

    def test_recipe_not_found_returns_404(self, authed_client):
        """get_recipe raises RecipeNotFoundError (covers cross-user / missing) → 404."""
        # No need to mock user_db reads — route bails before reaching them.
        with patch(
            "api.routes.recipes.get_recipe",
            side_effect=RecipeNotFoundError("not found"),
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 404

    def test_message_not_found_returns_404(self, authed_client):
        """Session resolves but message lookup returns empty → 404."""
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row=None,
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 404
        db_recipes.insert.assert_not_called()

    def test_whitespace_riff_label_persisted_as_null(self, authed_client):
        """Whitespace riff_label → Pydantic _trim_or_null → None in DB payload."""
        db, user_db, db_recipes, _, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": VALID_GENERATED_RECIPE,
            },
            inserted_recipe_id=FAKE_NEW_RECIPE_ID,
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps", return_value=[[1]]
        ):
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                    "riff_label": "   \t\n   ",
                },
            )

        assert resp.status_code == 200
        rpc_params = user_db.rpc.call_args.args[1]
        assert rpc_params["p_riff_label"] is None


# ---------------------------------------------------------------------------
# Phase 13.7 — Per-user usage tracking + entry-point telemetry (sync route)
# ---------------------------------------------------------------------------


class TestRiffEndpointUsageTracking:
    """POST /api/recipes/{recipe_id}/riff — usage helpers + entry_point.

    Helper-interaction tests that drive the new Phase 13.7 behavior in
    api/routes/riff.py through enforce_riff_daily_cap and
    record_riff_turn patched at the route-import site.
    """

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    # --- successful path: usage recorded once ------------------------------

    def test_successful_riff_records_usage_once(self, authed_client):
        db, _, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "Make it dairy-free",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(
                RIFF_URL, json={"message": "Make it dairy-free"}
            )

        assert resp.status_code == 200
        assert mock_cap.call_count == 1
        assert mock_record.call_count == 1
        assert mock_record.call_args.args == (FAKE_USER_ID,)

    # --- claude failure after dispatch still records -----------------------

    def test_claude_failure_after_dispatch_still_records_usage(
        self, authed_client
    ):
        """record fires BEFORE Claude is called. A subsequent Claude
        error does not unwind the count — the user paid for the attempt."""
        db, _, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = MagicMock()
        anthropic_client.messages.create.side_effect = RuntimeError(
            "anthropic boom"
        )
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 502
        assert mock_record.call_count == 1

    # --- recipe-not-found does not record usage ----------------------------

    def test_recipe_not_found_does_not_record_usage(self, authed_client):
        """get_recipe raising RecipeNotFoundError → 404 → cap and record
        never fire (404 is raised before either helper)."""
        with patch(
            "api.routes.riff.get_recipe",
            side_effect=RecipeNotFoundError("not found"),
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 404
        assert mock_cap.call_count == 0
        assert mock_record.call_count == 0

    # --- session mismatch does not record usage ----------------------------

    def test_session_mismatch_does_not_record_usage(self, authed_client):
        """Existing session belongs to a different recipe → 404 → cap
        and record never fire (session validation is step 2, before cap
        step 3 and record step 5)."""
        other_recipe_id = uuid4()
        db, _, _ = _mock_user_db(
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
            "api.routes.riff.enforce_riff_daily_cap"
        ) as mock_cap, patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(
                RIFF_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "hi",
                },
            )

        assert resp.status_code == 404
        assert mock_cap.call_count == 0
        assert mock_record.call_count == 0

    # --- cap exceeded → 429 + no user msg + no Claude ---------------------

    def test_cap_exceeded_returns_429_no_user_message_no_claude(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db()
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap",
            side_effect=RiffUsageLimitExceeded(
                "Daily Riff limit reached (25/25)", code="RIFF_DAILY_LIMIT"
            ),
        ), patch(
            "api.routes.riff.record_riff_turn"
        ) as mock_record:
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 429
        # record never fires — cap raises first
        assert mock_record.call_count == 0
        # No user-message insert
        assert messages_table.insert.call_count == 0
        # No Claude dispatch
        anthropic_client.messages.create.assert_not_called()

    # --- tracking failure → 500 + no user msg + no Claude -----------------

    def test_tracking_failure_returns_500_no_user_message_no_claude(
        self, authed_client
    ):
        db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, db)

        with patch(
            "api.routes.riff.get_recipe", return_value=_fake_recipe()
        ), patch(
            "api.routes.riff.get_anthropic_client", return_value=anthropic_client
        ), patch(
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn",
            side_effect=RiffUsageTrackingError(
                "Failed to record Riff turn",
                code="RIFF_USAGE_INCREMENT_FAILED",
            ),
        ):
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 500
        # User-message insert never happened (record fires before insert)
        assert messages_table.insert.call_count == 0
        # No Claude dispatch
        anthropic_client.messages.create.assert_not_called()

    # --- order: record fires BEFORE user-message insert -------------------

    def test_record_called_before_user_message_insert(self, authed_client):
        """Locked order: record_riff_turn is called BEFORE any
        riff_messages INSERT, so a tracking failure cannot leave an
        orphan user row."""
        db, _, messages_table = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
        _install_overrides(authed_client, db)

        # Capture messages_table.insert.call_count at the moment
        # record_riff_turn is invoked. Locked order requires 0.
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
            "api.routes.riff.enforce_riff_daily_cap"
        ), patch(
            "api.routes.riff.record_riff_turn", side_effect=_record_spy
        ):
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 200
        assert observed["msg_inserts_at_record_time"] == 0

    # --- new session insert defaults entry_point to "recipe_detail" -------

    def test_new_session_insert_includes_default_entry_point(
        self, authed_client
    ):
        """Body omits entry_point → server default 'recipe_detail' lands
        on the riff_sessions INSERT payload."""
        db, sessions_table, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(RIFF_URL, json={"message": "hi"})

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "recipe_detail"

    # --- custom entry_point persisted as-is (no allow-list) ---------------

    def test_custom_entry_point_persisted_as_is(self, authed_client):
        """Body provides entry_point='cooking_mode' → persisted verbatim.
        No DB enum, no allow-list — route does not validate the string
        beyond max_length."""
        db, sessions_table, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL,
                json={"message": "hi", "entry_point": "cooking_mode"},
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "cooking_mode"

    # --- Phase 13.8: grocery_substitute persists same as any custom value -

    def test_grocery_substitute_entry_point_persisted_as_is(self, authed_client):
        """Phase 13.8 mirror: entry_point='grocery_substitute' persists
        verbatim on a new sync Riff session insert. Same path as any other
        custom value — no allow-list, no DB enum. Documents the canonical
        Grocery Substitute label round-trips end-to-end."""
        db, sessions_table, _ = _mock_user_db(
            session_insert_id=FAKE_SESSION_ID,
            history_rows=[
                {
                    "role": "user",
                    "content": "hi",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL,
                json={"message": "hi", "entry_point": "grocery_substitute"},
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_called_once()
        payload = sessions_table.insert.call_args.args[0]
        assert payload["entry_point"] == "grocery_substitute"

    # --- existing session does not mutate entry_point ---------------------

    def test_existing_session_does_not_mutate_entry_point(self, authed_client):
        """Body provides session_id → no INSERT on riff_sessions, no
        UPDATE either. entry_point is set at create time only — even if
        the body sends a custom entry_point on a reused session, the
        route ignores it."""
        db, sessions_table, _ = _mock_user_db(
            session_lookup_rows=[
                {
                    "id": str(FAKE_SESSION_ID),
                    "source_recipe_id": str(FAKE_RECIPE_ID),
                }
            ],
            history_rows=[
                {
                    "role": "user",
                    "content": "earlier",
                    "created_at": "2026-05-06T00:00:00+00:00",
                },
                {
                    "role": "assistant",
                    "content": "earlier reply",
                    "created_at": "2026-05-06T00:00:01+00:00",
                },
            ],
        )
        anthropic_client = _mock_anthropic_client()
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
            resp = authed_client.post(
                RIFF_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message": "And spicier please",
                    # body sends a custom entry_point on a reused session;
                    # route must ignore it (existing sessions never mutate)
                    "entry_point": "cooking_mode",
                },
            )

        assert resp.status_code == 200
        sessions_table.insert.assert_not_called()
        sessions_table.update.assert_not_called()


# =============================================================================
# _draft_to_riff_recipe_dict adapter — Phase 13.9 Slice C
# =============================================================================
#
# Helper-level only — no FastAPI client, no Anthropic, no Supabase. The
# adapter is a pure key projection that lets draft-anchored Riff routes
# (Slices D/E) reuse build_riff_system_prompt + RIFF_SYSTEM_PROMPT_TEMPLATE
# unchanged. Spot-check tests prove recipe-shape and adapted-draft-shape
# inputs render byte-identical system prompts.


def _make_full_draft_dict() -> dict:
    """recipe_drafts row dict with every column populated.

    Used to prove out-of-scope columns do NOT leak through the adapter.
    Shape mirrors what get_draft / get_active_draft return after a real
    PostgREST SELECT *.
    """
    return {
        "id": "00000000-0000-0000-0000-000000000abc",
        "user_id": str(FAKE_USER_ID),
        "image_storage_keys": ["users/abc/recipe1.jpg"],
        "source_url": "https://example.com/recipe",
        "title": "Fettuccine Alfredo",
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "20 min",
        "confidence_score": 0.95,
        "ingredients": [
            {"quantity": "1", "unit": "cup", "name": "heavy cream", "prep": None},
            {"quantity": "2", "unit": "tbsp", "name": "butter", "prep": "softened"},
        ],
        "steps": [
            {"position": 1, "instruction": "Boil water."},
            {"position": 2, "instruction": "Cook pasta."},
        ],
        "raw_model_json": {"parser_v": "1.0", "raw": "..."},
        "model_version": "claude-sonnet-4-20250514",
        "parser_version": "1.0",
        "created_at": "2026-05-10T12:00:00+00:00",
        "updated_at": "2026-05-10T12:00:00+00:00",
        "expires_at": "2026-05-17T12:00:00+00:00",
    }


def _make_recipe_shape_dict_from(draft: dict) -> dict:
    """Build a recipe-shaped dict (as get_recipe returns) sharing the
    six prompt-relevant fields with the given draft.

    Used for spot-check equality: same data, two shapes, one rendered
    system prompt.
    """
    return {
        "id": str(FAKE_RECIPE_ID),
        "user_id": str(FAKE_USER_ID),
        "title": draft["title"],
        "servings": draft["servings"],
        "prep_time": draft["prep_time"],
        "cook_time": draft["cook_time"],
        "ingredients": draft["ingredients"],
        "steps": draft["steps"],
        "tags": [],
        "favorite": False,
        "created_at": "2026-05-10T12:00:00+00:00",
        "updated_at": "2026-05-10T12:00:00+00:00",
    }


def test_draft_adapter_returns_exactly_six_keys():
    """Adapter output dict has length 6 and exactly the contract §5.1 keys."""
    out = _draft_to_riff_recipe_dict(_make_full_draft_dict())
    assert len(out) == 6
    assert set(out.keys()) == {
        "title",
        "servings",
        "prep_time",
        "cook_time",
        "ingredients",
        "steps",
    }


def test_draft_adapter_preserves_all_six_prompt_relevant_fields():
    """Full draft → adapter copies the six fields straight through;
    ingredients/steps are SAME references (no deep copy)."""
    draft = _make_full_draft_dict()
    out = _draft_to_riff_recipe_dict(draft)

    assert out["title"] == "Fettuccine Alfredo"
    assert out["servings"] == "4"
    assert out["prep_time"] == "10 min"
    assert out["cook_time"] == "20 min"
    # Reference equality — adapter does not deep-copy mutable members.
    assert out["ingredients"] is draft["ingredients"]
    assert out["steps"] is draft["steps"]


def test_draft_adapter_returns_none_for_nullable_string_fields():
    """servings/prep_time/cook_time absent or null → adapter output retains
    None. Template substitutes '(not specified)' downstream in
    build_riff_system_prompt."""
    draft = _make_full_draft_dict()
    draft["servings"] = None
    draft["prep_time"] = None
    draft["cook_time"] = None
    out = _draft_to_riff_recipe_dict(draft)
    assert out["servings"] is None
    assert out["prep_time"] is None
    assert out["cook_time"] is None

    # Also covers the missing-key case (e.g., column not selected back).
    draft = _make_full_draft_dict()
    del draft["servings"]
    del draft["prep_time"]
    del draft["cook_time"]
    out = _draft_to_riff_recipe_dict(draft)
    assert out["servings"] is None
    assert out["prep_time"] is None
    assert out["cook_time"] is None


@pytest.mark.parametrize(
    "ingredients_value",
    [None, [], {}],  # missing-as-None, empty-list, falsy-non-list edge
    ids=["null", "empty_list", "falsy_dict"],
)
def test_draft_adapter_returns_empty_list_for_missing_ingredients(ingredients_value):
    """Missing / null / empty-falsy ingredients → adapter returns []."""
    draft = _make_full_draft_dict()
    if ingredients_value is None:
        del draft["ingredients"]
    else:
        draft["ingredients"] = ingredients_value
    out = _draft_to_riff_recipe_dict(draft)
    assert out["ingredients"] == []


@pytest.mark.parametrize(
    "steps_value",
    [None, [], {}],
    ids=["null", "empty_list", "falsy_dict"],
)
def test_draft_adapter_returns_empty_list_for_missing_steps(steps_value):
    """Missing / null / empty-falsy steps → adapter returns []."""
    draft = _make_full_draft_dict()
    if steps_value is None:
        del draft["steps"]
    else:
        draft["steps"] = steps_value
    out = _draft_to_riff_recipe_dict(draft)
    assert out["steps"] == []


def test_draft_adapter_does_not_leak_out_of_scope_fields():
    """Every recipe_drafts column outside the 6-key contract MUST NOT
    appear in adapter output. Locks contract §5.2 verbatim."""
    out = _draft_to_riff_recipe_dict(_make_full_draft_dict())

    # Contract §5.2 enumeration
    forbidden = {
        "confidence_score",
        "raw_model_json",
        "model_version",
        "parser_version",
        "expires_at",
        "image_storage_keys",
        "source_url",
    }
    # Row-identity / lifecycle columns not in the 6-key contract
    forbidden |= {"id", "user_id", "created_at", "updated_at"}

    leaked = forbidden & set(out.keys())
    assert leaked == set(), f"Adapter leaked out-of-scope fields: {leaked}"


def test_adapter_output_renders_through_build_riff_system_prompt_without_error():
    """Round-trip: adapter output → build_riff_system_prompt → non-empty
    str containing the source title verbatim. Contract §13 Slice C acceptance."""
    draft = _make_full_draft_dict()
    out = _draft_to_riff_recipe_dict(draft)

    prompt = build_riff_system_prompt(out, RIFF_SYSTEM_PROMPT_TEMPLATE)

    assert isinstance(prompt, str)
    assert len(prompt) > 0
    assert "Fettuccine Alfredo" in prompt
    assert "heavy cream" in prompt
    assert "Boil water." in prompt


def test_adapter_renders_identical_prompt_to_recipe_shape_simple_case():
    """Spot-check #1 (contract §13 Slice C acceptance).

    Minimal data identical across recipe-shape and draft-shape. Adapter
    must produce a system prompt byte-identical to rendering the recipe
    shape directly."""
    draft = {
        "id": "00000000-0000-0000-0000-000000000abc",
        "user_id": str(FAKE_USER_ID),
        "image_storage_keys": [],
        "source_url": None,
        "title": "Toast",
        "servings": "1",
        "prep_time": None,
        "cook_time": "3 min",
        "confidence_score": 0.9,
        "ingredients": [
            {"quantity": "1", "unit": "slice", "name": "bread", "prep": None},
        ],
        "steps": [{"position": 1, "instruction": "Toast it."}],
        "raw_model_json": None,
        "model_version": "test",
        "parser_version": "test",
        "created_at": "2026-05-10T12:00:00+00:00",
        "updated_at": "2026-05-10T12:00:00+00:00",
        "expires_at": "2026-05-17T12:00:00+00:00",
    }
    recipe_shape = _make_recipe_shape_dict_from(draft)

    prompt_from_recipe = build_riff_system_prompt(
        recipe_shape, RIFF_SYSTEM_PROMPT_TEMPLATE
    )
    prompt_from_draft = build_riff_system_prompt(
        _draft_to_riff_recipe_dict(draft), RIFF_SYSTEM_PROMPT_TEMPLATE
    )

    assert prompt_from_recipe == prompt_from_draft


def test_adapter_renders_identical_prompt_to_recipe_shape_full_case():
    """Spot-check #2 (contract §13 Slice C acceptance).

    Multi-ingredient + multi-step + all timing fields populated. Equality
    proves no field drift between recipe-anchored and draft-anchored
    rendering paths under realistic data."""
    draft = _make_full_draft_dict()
    recipe_shape = _make_recipe_shape_dict_from(draft)

    prompt_from_recipe = build_riff_system_prompt(
        recipe_shape, RIFF_SYSTEM_PROMPT_TEMPLATE
    )
    prompt_from_draft = build_riff_system_prompt(
        _draft_to_riff_recipe_dict(draft), RIFF_SYSTEM_PROMPT_TEMPLATE
    )

    assert prompt_from_recipe == prompt_from_draft


def test_adapter_renders_identical_prompt_to_recipe_shape_null_fields_case():
    """Spot-check #3 (additive — null/empty path equality).

    All nullable strings None, ingredients/steps empty. Proves the
    template's null-handling substitutions ('(not specified)', '(none)')
    fire identically across both rendering paths."""
    draft = _make_full_draft_dict()
    draft["servings"] = None
    draft["prep_time"] = None
    draft["cook_time"] = None
    draft["ingredients"] = []
    draft["steps"] = []
    recipe_shape = _make_recipe_shape_dict_from(draft)

    prompt_from_recipe = build_riff_system_prompt(
        recipe_shape, RIFF_SYSTEM_PROMPT_TEMPLATE
    )
    prompt_from_draft = build_riff_system_prompt(
        _draft_to_riff_recipe_dict(draft), RIFF_SYSTEM_PROMPT_TEMPLATE
    )

    assert prompt_from_recipe == prompt_from_draft


# =============================================================================
# PROVIDER-S1 — shared model constant (sync path)
# =============================================================================


def test_riff_default_config_consumes_shared_model_constant():
    from api.core.anthropic_client import DEFAULT_CLAUDE_MODEL
    from api.core.riff import get_default_riff_config

    assert get_default_riff_config().model == DEFAULT_CLAUDE_MODEL
    assert DEFAULT_CLAUDE_MODEL == "claude-sonnet-4-6"


# =============================================================================
# PROVIDER-S1.1 — prompt-contract durability guards
# =============================================================================


class TestRiffPromptContractProviderS11:
    """PROVIDER-S1.1 durability guards: semantic contract markers on
    RIFF_SYSTEM_PROMPT_TEMPLATE (not a snapshot).

    The behavioral acceptance gate is the fixed-input 14-case evaluation;
    these assertions only keep the calibrated block-emission instructions
    from being silently edited away later.
    """

    def test_question_form_method_conversion_named_as_modification(self):
        assert (
            'phrased as a question such as "Can I bake this instead?"'
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert "Cooking-method conversions" in RIFF_SYSTEM_PROMPT_TEMPLATE

    def test_meal_prep_block_at_source_scale(self):
        assert (
            "Meal-prep or make-ahead workflow adaptations"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "do NOT permit multiplying ingredient quantities"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert "INSIDE the recipe-json block" in RIFF_SYSTEM_PROMPT_TEMPLATE
        # The old prose license must be REPLACED, not merely contradicted by
        # additional text. (The distinct line-135 phrase "in steps or prose"
        # is a different rule and is intentionally not asserted on.)
        assert "inside steps and prose" not in RIFF_SYSTEM_PROMPT_TEMPLATE

    def test_yes_with_adjustments_scoped_not_a_classifier(self):
        assert (
            '"Yes, with adjustments" answers count as prose-only'
            not in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "does not warrant a recipe-json block" in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_escape_hatch_and_midconversation_reserve_survive(self):
        # All three markers pre-date PROVIDER-S1.1 — this test also passes
        # against the unedited template; it is a pure preservation guard.
        assert "DO NOT emit the block" in RIFF_SYSTEM_PROMPT_TEMPLATE
        assert (
            "A prose-only response is always preferred over a malformed or "
            "partial block." in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "reserve the block for full-recipe responses"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_dietary_completeness_and_truthful_title_rules(self):
        # Dietary completeness: incompatible core ingredients replaced or
        # removed, propagated through ingredients AND every affected step,
        # overriding preserve-unchanged only for incompatible ingredients.
        assert (
            "including the recipe's core protein or main ingredient"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "BOTH the ingredients list AND every step that uses it"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "the preserve-unchanged discipline does not protect them"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "NEVER present a recipe as vegetarian, vegan, gluten-free, "
            "dairy-free, or otherwise compliant"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Truthful title: ingredient exception.
        assert (
            "change ONLY the words naming that ingredient"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Truthful title: method/equipment exception, fired only on falseness.
        assert (
            "makes a method or equipment term in the title false"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "change ONLY those method or equipment words to the actual "
            "resulting method"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Only affected words may change.
        assert (
            "In both cases preserve every other word and the title's "
            "structure."
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Combined-request precedence: meal-prep alone preserves the title;
        # combined requests apply the corresponding truthfulness exceptions.
        assert (
            "Meal-prep and make-ahead adaptations by themselves keep the "
            "source title exactly."
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "If the same request also replaces a title-named core ingredient"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "apply only the corresponding truthfulness exception or exceptions"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "prefer a compatible same-category replacement"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # No general title rewriting; no added dietary/workflow labels.
        assert (
            "Never use these exceptions as permission for general title "
            "rewriting."
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            'NO "Dairy-Free", "Gluten-Free", "Vegetarian", "Vegan"'
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Front-loaded truthfulness precedence: the truthful-description
        # principle and the two exceptions come BEFORE default preservation.
        assert (
            'The "title" field MUST truthfully describe the adapted recipe.'
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "except for the TWO narrow truthfulness exceptions below"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "MUST truthfully describe the adapted recipe"
        ) < RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "Outside these two exceptions, do NOT prepend"
        )
        # Local retitle actions at each transformation trigger.
        assert (
            "Before emitting, check the title: if the source title names the "
            "old method or equipment"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "After selecting the actual replacement and before emitting the "
            "block, check the title"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # No title wording may contradict the adapted recipe.
        assert (
            "Never leave title wording that contradicts the actual adapted "
            "ingredients or cooking method"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_saved_block_self_containedness_principle(self):
        # Fenced-block-only persistence + surrounding-prose loss.
        assert (
            "ONLY the fenced Recipe block is stored"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "none of your surrounding prose is saved with it"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Scoped to an ADDED replacement row colliding with a retained row —
        # deliberately NOT a blanket rule over legitimate pre-existing
        # duplicate rows.
        assert (
            "When an added replacement row has the same ingredient name as "
            "a retained row"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Prose may never carry the distinction, and the retained row is not
        # edited just to hold the explanation.
        assert (
            "never rely on surrounding prose to distinguish the rows"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "do not alter the retained row solely to add that explanation"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # The principle sits before the escape hatch and does not replace it.
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "Saved-block self-containedness"
        ) < RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "If you CANNOT produce a recipe that conforms"
        )
        # Structural pinning: the principle lives inside RECIPE-JSON RULES —
        # after the section heading (the escape-hatch bound above closes the
        # other side).
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "## RECIPE-JSON RULES"
        ) < RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "Saved-block self-containedness"
        )

    def test_dietary_collision_replacement_row_action(self):
        # Collision trigger, retained row exactly unchanged, and a separate
        # replacement row at the removed ingredient's position.
        assert (
            "When replacing an incompatible ingredient with an ingredient "
            "the recipe already lists"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "keep the existing row exactly unchanged"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "add a separate replacement row at the removed ingredient's "
            "position"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Structural pinning: the local action lives inside the DIETARY /
        # HEALTH COMPLETENESS section, and fires before the global
        # saved-block self-containedness principle in template order (the
        # dual-site pattern: local action first, global principle later).
        _collision_idx = RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "When replacing an incompatible ingredient with an ingredient"
        )
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "## DIETARY / HEALTH COMPLETENESS"
        ) < _collision_idx
        assert _collision_idx < RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "## CLARIFICATION DISCIPLINE"
        )
        assert _collision_idx < RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            "Saved-block self-containedness"
        )

    def test_dietary_collision_quantity_default_and_ratio_exception(self):
        # Default to the removed row's quantity and unit; deviation only via
        # the narrow substitution-requires-it exception; no folding into the
        # retained row.
        assert (
            "Preserve the removed row's quantity and unit by default"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "only when the substitution itself requires a different ratio "
            "or measure"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        assert (
            "Never fold the replacement into the existing row"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_dietary_collision_prep_label_convention(self):
        # Bare unparenthesized "in place of ..." prep label — the renderer
        # (_format_ingredient) adds parentheses and the mobile UI adds a
        # comma suffix, so the raw value must carry neither.
        assert (
            "bare, unparenthesized phrase beginning with the words in place "
            "of and naming the removed ingredient"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # An unlabeled same-name replacement row is prohibited.
        assert (
            "or emit the replacement row without that label"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )
        # Removal-without-replacement stays permitted.
        assert (
            "If you remove the incompatible ingredient without a "
            "replacement, add no extra row."
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_dietary_collision_rules_add_no_fixture_terms(self):
        # The two collision insertions add no C09 fixture wording. Counts
        # pin the whole template: "fish sauce" appears only in the
        # hidden-hazards enumeration; "soy sauce" only there and in the
        # tamari same-category title example.
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.count("fish sauce") == 1
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.count("soy sauce") == 2

    def test_preexisting_contract_markers_survive_collision_edit(self):
        # Pure preservation guard: every marker below pre-dates the
        # collision insertions and must survive them byte-identically.
        for marker in (
            # Dietary completeness.
            "Replace or remove EVERY ingredient that is incompatible",
            "Do NOT note a needed substitution in prose and leave the "
            "violating ingredient in the block",
            # Title truthfulness.
            'The "title" field MUST truthfully describe the adapted recipe.',
            # Ordering.
            "Preserve ingredient ordering and step ordering.",
            "Do NOT re-sort, re-section, or refactor",
            # Quantity / scaling.
            "Do NOT rewrite unrelated ingredients or multiply quantities",
            "keep servings unchanged unless the user also explicitly "
            "requested scaling",
            # Prose-only ceiling + block emission.
            "Prose-only answer: at most ONE short paragraph OR two tight "
            "bullets.",
            "Append a single fenced ```recipe-json``` block at the end of "
            "your message",
            # Escape hatch, unbroadened.
            "A prose-only response is always preferred over a malformed or "
            "partial block.",
        ):
            assert marker in RIFF_SYSTEM_PROMPT_TEMPLATE, marker


# =============================================================================
# PROVIDER-S1.1-R1 — retained-row exactness prompt correction (Strategy B)
# =============================================================================

# The two approved bullets, pinned VERBATIM (leading "- " included). Any
# wording, punctuation, capitalization, or placement drift is a test failure.
_R1_RETAINED_ROW_DISCIPLINE_BULLET = "- Retained ingredient rows are structured records, not just readable text. For every ingredient row you keep that the user did not ask to change and that neither cooking correctness nor the DIETARY / HEALTH COMPLETENESS rules require you to change, reproduce the row exactly as sourced — quantity, unit, name, and prep all unchanged. Do not move words between name and prep, and do not normalize spelling, punctuation, or word order on a retained row. Only rows the user asked to replace, remove, add, scale, or otherwise explicitly adjust — plus rows those correctness or dietary rules require you to change — may differ, and an explicitly requested scaling changes quantity only."

_R1_RETAINED_ROW_EXACTNESS_BULLET = "- Retained-row exactness: each SOURCE RECIPE ingredient line above reads quantity, then unit, then the ingredient's name, with the prep field in trailing parentheses when one exists. For every ingredient row you are not changing, copy those fields back unchanged: name is every word of the source name exactly as written — including descriptors like bone-in, skin-on, low-sodium, toasted, or fresh — and prep is exactly the source parenthetical, or null when there is none. Never move descriptors between name and prep, and never re-spell, re-punctuate, reorder, or clean up a retained row. This applies in every recipe-json block — meal-prep, method-conversion, dietary, and scaling responses alike; a scaled retained row updates quantity only."


class TestRiffPromptRetainedRowContractProviderS11R1:
    """PROVIDER-S1.1-R1 durability guards: the Strategy B two-site
    retained-row prompt correction (Stage C C10 rep3 strict-parity failure —
    name→prep descriptor relocation on a retained row).

    Pins both approved bullets byte-verbatim AND their exact structural
    placement. Structural-index audit of the insertion: both bullets sit
    strictly between pre-existing anchors without reordering any marker
    used by TestRiffPromptContractProviderS11, so no pre-existing index
    assertion required updating; the pre-existing tests run unmodified.
    """

    def test_retained_row_discipline_bullet_pinned_verbatim(self):
        assert _R1_RETAINED_ROW_DISCIPLINE_BULLET in RIFF_SYSTEM_PROMPT_TEMPLATE
        # Exactly once — never duplicated by a later edit.
        assert (
            RIFF_SYSTEM_PROMPT_TEMPLATE.count(_R1_RETAINED_ROW_DISCIPLINE_BULLET)
            == 1
        )

    def test_retained_row_exactness_bullet_pinned_verbatim(self):
        assert _R1_RETAINED_ROW_EXACTNESS_BULLET in RIFF_SYSTEM_PROMPT_TEMPLATE
        assert (
            RIFF_SYSTEM_PROMPT_TEMPLATE.count(_R1_RETAINED_ROW_EXACTNESS_BULLET)
            == 1
        )

    def test_retained_row_discipline_bullet_exact_placement(self):
        # Immediately after the MODIFICATION DISCIPLINE preserve-cuisine
        # bullet, immediately before the no-bonus-ingredients bullet.
        assert (
            "- Preserve cuisine, flavor profile, servings, timing, equipment,"
            " and any ingredient or step the user did not ask to change.\n"
            + _R1_RETAINED_ROW_DISCIPLINE_BULLET
            + "\n- Do NOT add bonus ingredients, garnishes, sauces,"
            " side recipes, or new components beyond the request."
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_retained_row_exactness_bullet_exact_placement(self):
        # Immediately after the RECIPE-JSON RULES ordering bullet,
        # immediately before the strict schema rules bullet.
        assert (
            '- Preserve ingredient ordering and step ordering. Do NOT'
            ' re-sort, re-section, or refactor for "better" flow.\n'
            + _R1_RETAINED_ROW_EXACTNESS_BULLET
            + "\n- Schema rules — strict:"
            in RIFF_SYSTEM_PROMPT_TEMPLATE
        )

    def test_retained_row_bullets_section_membership(self):
        # Site 1 lives inside MODIFICATION DISCIPLINE; site 2 inside
        # RECIPE-JSON RULES, before the saved-block self-containedness rule.
        _d_idx = RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            _R1_RETAINED_ROW_DISCIPLINE_BULLET
        )
        assert (
            RIFF_SYSTEM_PROMPT_TEMPLATE.index("## MODIFICATION DISCIPLINE")
            < _d_idx
            < RIFF_SYSTEM_PROMPT_TEMPLATE.index("## DIETARY / HEALTH COMPLETENESS")
        )
        _e_idx = RIFF_SYSTEM_PROMPT_TEMPLATE.index(
            _R1_RETAINED_ROW_EXACTNESS_BULLET
        )
        assert (
            RIFF_SYSTEM_PROMPT_TEMPLATE.index("## RECIPE-JSON RULES")
            < _e_idx
            < RIFF_SYSTEM_PROMPT_TEMPLATE.index("Saved-block self-containedness")
        )

    def test_retained_row_bullets_add_no_fixture_terms(self):
        # The R1 insertions must not disturb the pinned fixture-term counts
        # (mirrors test_dietary_collision_rules_add_no_fixture_terms).
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.count("fish sauce") == 1
        assert RIFF_SYSTEM_PROMPT_TEMPLATE.count("soy sauce") == 2


# ---------------------------------------------------------------------------
# PROVIDER-S1.1 closure W1 — save-path persistence pin (recipe path)
# ---------------------------------------------------------------------------


class TestRiffSaveSubstitutionLabelPersistence:
    """W1 pin: a dietary-collision block (retained row + labeled replacement
    row sharing the same ingredient name) persists BOTH rows through
    /riff/save with `prep` written verbatim — the substitution label the
    Grocery provenance pipeline (`grocery_items.note`) depends on downstream.
    """

    @pytest.fixture(autouse=True)
    def _install_default_db_overrides(self, authed_client):
        authed_client.app.dependency_overrides[get_db] = lambda: MagicMock()
        authed_client.app.dependency_overrides[get_user_db] = lambda: MagicMock()
        yield
        authed_client.app.dependency_overrides.pop(get_db, None)
        authed_client.app.dependency_overrides.pop(get_user_db, None)

    def test_save_persists_labeled_collision_rows_verbatim(self, authed_client):
        collision_recipe = {
            "title": "Soy-Glazed Sheet-Pan Portobello Mushrooms",
            "servings": None,
            "prep_time": "15 min",
            "cook_time": "25 min",
            "confidence": 1.0,
            "ingredients": [
                {"quantity": "2", "unit": "tbsp", "name": "soy sauce", "prep": None},
                {
                    "quantity": "1",
                    "unit": "tsp",
                    "name": "soy sauce",
                    "prep": "in place of fish sauce",
                },
            ],
            "steps": [
                {
                    "position": 1,
                    "instruction": "Whisk both soy sauce additions into the glaze.",
                },
            ],
        }
        db, user_db, _, db_ingredients, _, _, _ = _mock_save_clients(
            session_row={
                "id": str(FAKE_SESSION_ID),
                "source_recipe_id": str(FAKE_RECIPE_ID),
            },
            message_row={
                "id": str(FAKE_MESSAGE_ID),
                "session_id": str(FAKE_SESSION_ID),
                "generated_recipe": collision_recipe,
            },
            inserted_recipe_id=FAKE_NEW_RECIPE_ID,
        )
        authed_client.app.dependency_overrides[get_db] = lambda: db
        authed_client.app.dependency_overrides[get_user_db] = lambda: user_db

        with patch(
            "api.routes.recipes.get_recipe", return_value={"id": str(FAKE_RECIPE_ID)}
        ), patch(
            "api.routes.recipes.map_ingredients_to_steps",
            return_value=[[1, 2]],
        ) as mock_mapper:
            resp = authed_client.post(
                SAVE_URL,
                json={
                    "session_id": str(FAKE_SESSION_ID),
                    "message_id": str(FAKE_MESSAGE_ID),
                },
            )

        assert resp.status_code == 200

        # Row persistence is SQL-owned since Issue 1 (save_riff_recipe_atomic
        # inserts verbatim from generated_recipe inside migration 026). The
        # Python-observable preservation contract: the labeled collision rows
        # reach the save-time mapper verbatim and both map into the step.
        mapper_ingredients = mock_mapper.call_args.args[0]
        assert len(mapper_ingredients) == 2
        assert mapper_ingredients[0]["name"] == "soy sauce"
        assert mapper_ingredients[0]["quantity"] == "2"
        assert mapper_ingredients[0]["unit"] == "tbsp"
        assert mapper_ingredients[0]["prep"] is None
        assert mapper_ingredients[1]["name"] == "soy sauce"
        assert mapper_ingredients[1]["quantity"] == "1"
        assert mapper_ingredients[1]["unit"] == "tsp"
        assert mapper_ingredients[1]["prep"] == "in place of fish sauce"
        attach_params = db.rpc.call_args.args[1]
        assert attach_params["p_mappings"] == [
            {"step_position": 1, "ingredient_positions": [1, 2]}
        ]
