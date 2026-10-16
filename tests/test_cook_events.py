"""Tests for cook event endpoints and core logic (Phase 9.B).

Part 1: Core function behavior (create, list, recent, delete).
Part 2: HTTP endpoint validation.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from api.core.cook_events import (
    create_cook_event,
    delete_cook_event,
    list_cook_events,
    list_recent_cooks,
)
from api.core.exceptions import CookEventNotFoundError, RecipeNotFoundError, StorageError

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000002")
FAKE_EVENT_ID = UUID("00000000-0000-0000-0000-000000000010")

NOW = datetime.now(timezone.utc)


def _make_event_row(
    *,
    event_id: UUID = FAKE_EVENT_ID,
    recipe_id: UUID = FAKE_RECIPE_ID,
    user_id: UUID = FAKE_USER_ID,
    rating: int | None = None,
    notes: str | None = None,
    scale: str | None = None,
    cooked_at: datetime | None = None,
) -> dict:
    """Build a fake cook_events DB row."""
    return {
        "id": str(event_id),
        "recipe_id": str(recipe_id),
        "user_id": str(user_id),
        "cooked_at": (cooked_at or NOW).isoformat(),
        "rating": rating,
        "notes": notes,
        "scale": scale,
        "created_at": NOW.isoformat(),
    }


def _mock_db_for_create(
    *,
    recipe_exists: bool = True,
    insert_row: dict | None = None,
    recipe_select_raises: Exception | None = None,
    insert_raises: Exception | None = None,
) -> MagicMock:
    """Mock Supabase for create_cook_event."""
    db = MagicMock()

    # Recipe ownership check: table("recipes").select("id").eq(...).eq(...).single().execute()
    recipe_chain = (
        db.table.return_value
        .select.return_value
        .eq.return_value
        .eq.return_value
        .single.return_value
    )
    if recipe_select_raises:
        recipe_chain.execute.side_effect = recipe_select_raises
    elif not recipe_exists:
        recipe_chain.execute.side_effect = Exception("0 rows returned")
    else:
        recipe_chain.execute.return_value.data = {"id": str(FAKE_RECIPE_ID)}

    # Insert: table("cook_events").insert(row).execute()
    insert_chain = db.table.return_value.insert.return_value
    if insert_raises:
        insert_chain.execute.side_effect = insert_raises
    else:
        row = insert_row or _make_event_row()
        insert_chain.execute.return_value.data = [row]

    return db


# ====================================================================
# Part 1 — Core Functions
# ====================================================================


class TestCreateCookEvent:
    """create_cook_event core function."""

    def test_creates_with_all_fields(self):
        row = _make_event_row(rating=4, notes="Great", scale="doubled")
        db = _mock_db_for_create(insert_row=row)
        result = create_cook_event(
            FAKE_RECIPE_ID, FAKE_USER_ID,
            rating=4, notes="Great", scale="doubled",
            supabase=db,
        )
        assert result.rating == 4
        assert result.notes == "Great"
        assert result.scale == "doubled"

    def test_creates_with_no_fields(self):
        db = _mock_db_for_create()
        result = create_cook_event(
            FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db,
        )
        assert result.rating is None
        assert result.notes is None
        assert result.scale is None

    def test_recipe_not_found_raises(self):
        db = _mock_db_for_create(recipe_exists=False)
        with pytest.raises(RecipeNotFoundError):
            create_cook_event(FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db)

    def test_future_cooked_at_raises_value_error(self):
        db = _mock_db_for_create()
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        with pytest.raises(ValueError, match="future"):
            create_cook_event(
                FAKE_RECIPE_ID, FAKE_USER_ID,
                cooked_at=future, supabase=db,
            )

    def test_cooked_at_within_tolerance_accepted(self):
        """Dates up to 5 minutes in the future are accepted (clock skew)."""
        db = _mock_db_for_create()
        near_future = datetime.now(timezone.utc) + timedelta(minutes=3)
        row = _make_event_row(cooked_at=near_future)
        db.table.return_value.insert.return_value.execute.return_value.data = [row]
        result = create_cook_event(
            FAKE_RECIPE_ID, FAKE_USER_ID,
            cooked_at=near_future, supabase=db,
        )
        assert result.cooked_at is not None

    def test_notes_trimmed_whitespace_becomes_none(self):
        row = _make_event_row(notes=None)
        db = _mock_db_for_create(insert_row=row)
        create_cook_event(
            FAKE_RECIPE_ID, FAKE_USER_ID,
            notes="   ", supabase=db,
        )
        # Verify the insert call got None for notes
        insert_call = db.table.return_value.insert.call_args[0][0]
        assert insert_call["notes"] is None

    def test_scale_trimmed_whitespace_becomes_none(self):
        row = _make_event_row(scale=None)
        db = _mock_db_for_create(insert_row=row)
        create_cook_event(
            FAKE_RECIPE_ID, FAKE_USER_ID,
            scale="  ", supabase=db,
        )
        insert_call = db.table.return_value.insert.call_args[0][0]
        assert insert_call["scale"] is None

    def test_insert_db_error_raises_storage_error(self):
        db = _mock_db_for_create(insert_raises=Exception("connection lost"))
        with pytest.raises(StorageError):
            create_cook_event(FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db)


class TestListCookEvents:
    """list_cook_events core function."""

    def test_returns_events_ordered(self):
        db = MagicMock()
        rows = [
            _make_event_row(cooked_at=NOW),
            _make_event_row(event_id=uuid4(), cooked_at=NOW - timedelta(days=1)),
        ]
        chain = (
            db.table.return_value
            .select.return_value
            .eq.return_value
            .eq.return_value
            .order.return_value
            .limit.return_value
        )
        chain.execute.return_value.data = rows
        result = list_cook_events(FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db)
        assert len(result) == 2

    def test_empty_list(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .select.return_value
            .eq.return_value
            .eq.return_value
            .order.return_value
            .limit.return_value
        )
        chain.execute.return_value.data = []
        result = list_cook_events(FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db)
        assert result == []

    def test_db_error_raises_storage_error(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .select.return_value
            .eq.return_value
            .eq.return_value
            .order.return_value
            .limit.return_value
        )
        chain.execute.side_effect = Exception("timeout")
        with pytest.raises(StorageError):
            list_cook_events(FAKE_RECIPE_ID, FAKE_USER_ID, supabase=db)


class TestListRecentCooks:
    """list_recent_cooks core function."""

    @staticmethod
    def _mock_db_for_recent(
        event_rows: list[dict],
        recipe_rows: list[dict] | None = None,
    ) -> MagicMock:
        """Build mock that handles two sequential table() calls:
        first for cook_events, then for recipes."""
        db = MagicMock()

        # Track call count to return different chains
        call_count = {"n": 0}
        original_table = db.table

        def table_side_effect(name: str):
            call_count["n"] += 1
            mock_table = MagicMock()
            if call_count["n"] == 1:
                # cook_events query
                chain = (
                    mock_table.select.return_value
                    .eq.return_value
                    .order.return_value
                    .limit.return_value
                )
                chain.execute.return_value.data = event_rows
            else:
                # recipes query
                chain = (
                    mock_table.select.return_value
                    .in_.return_value
                )
                chain.execute.return_value.data = (
                    recipe_rows if recipe_rows is not None
                    else [{"id": str(FAKE_RECIPE_ID), "title": "Pasta Carbonara"}]
                )
            return mock_table

        db.table.side_effect = table_side_effect
        return db

    def test_returns_flat_shape_with_recipe_title(self):
        event_rows = [
            {
                "id": str(FAKE_EVENT_ID),
                "recipe_id": str(FAKE_RECIPE_ID),
                "cooked_at": NOW.isoformat(),
                "rating": 4,
            },
        ]
        db = self._mock_db_for_recent(event_rows)
        result = list_recent_cooks(FAKE_USER_ID, supabase=db)
        assert len(result) == 1
        assert result[0].recipe_title == "Pasta Carbonara"
        assert result[0].rating == 4

    def test_missing_recipe_falls_back_to_untitled(self):
        event_rows = [
            {
                "id": str(FAKE_EVENT_ID),
                "recipe_id": str(FAKE_RECIPE_ID),
                "cooked_at": NOW.isoformat(),
                "rating": None,
            },
        ]
        db = self._mock_db_for_recent(event_rows, recipe_rows=[])
        result = list_recent_cooks(FAKE_USER_ID, supabase=db)
        assert result[0].recipe_title == "Untitled"

    def test_empty_events_skips_recipe_fetch(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .select.return_value
            .eq.return_value
            .order.return_value
            .limit.return_value
        )
        chain.execute.return_value.data = []
        result = list_recent_cooks(FAKE_USER_ID, supabase=db)
        assert result == []
        # Only one table() call (cook_events), no recipes fetch
        assert db.table.call_count == 1

    def test_db_error_raises_storage_error(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .select.return_value
            .eq.return_value
            .order.return_value
            .limit.return_value
        )
        chain.execute.side_effect = Exception("timeout")
        with pytest.raises(StorageError):
            list_recent_cooks(FAKE_USER_ID, supabase=db)


class TestDeleteCookEvent:
    """delete_cook_event core function."""

    def test_success(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .delete.return_value
            .eq.return_value
            .eq.return_value
        )
        chain.execute.return_value.data = [{"id": str(FAKE_EVENT_ID)}]
        # Should not raise
        delete_cook_event(FAKE_EVENT_ID, FAKE_USER_ID, supabase=db)

    def test_not_found_raises(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .delete.return_value
            .eq.return_value
            .eq.return_value
        )
        chain.execute.return_value.data = []
        with pytest.raises(CookEventNotFoundError):
            delete_cook_event(FAKE_EVENT_ID, FAKE_USER_ID, supabase=db)

    def test_db_error_raises_storage_error(self):
        db = MagicMock()
        chain = (
            db.table.return_value
            .delete.return_value
            .eq.return_value
            .eq.return_value
        )
        chain.execute.side_effect = Exception("connection lost")
        with pytest.raises(StorageError):
            delete_cook_event(FAKE_EVENT_ID, FAKE_USER_ID, supabase=db)


# ====================================================================
# Part 2 — HTTP Endpoints
# ====================================================================


class TestLogCookEventEndpoint:
    """POST /api/recipes/{recipe_id}/cook."""

    def test_creates_with_all_fields(self, authed_client):
        event = _make_event_row(rating=5, notes="Perfect", scale="doubled")
        with patch("api.routes.cook_events.create_cook_event") as mock:
            from api.models.cook_event import CookEventResponse
            mock.return_value = CookEventResponse.model_validate(event)
            resp = authed_client.post(
                f"/api/recipes/{FAKE_RECIPE_ID}/cook",
                json={"rating": 5, "notes": "Perfect", "scale": "doubled"},
            )
        assert resp.status_code == 201
        data = resp.json()
        assert data["rating"] == 5
        assert data["notes"] == "Perfect"

    def test_creates_with_empty_body(self, authed_client):
        event = _make_event_row()
        with patch("api.routes.cook_events.create_cook_event") as mock:
            from api.models.cook_event import CookEventResponse
            mock.return_value = CookEventResponse.model_validate(event)
            resp = authed_client.post(
                f"/api/recipes/{FAKE_RECIPE_ID}/cook",
                json={},
            )
        assert resp.status_code == 201

    def test_recipe_not_found_returns_404(self, authed_client):
        with patch(
            "api.routes.cook_events.create_cook_event",
            side_effect=RecipeNotFoundError("not found"),
        ):
            resp = authed_client.post(
                f"/api/recipes/{FAKE_RECIPE_ID}/cook",
                json={},
            )
        assert resp.status_code == 404

    def test_future_date_returns_400(self, authed_client):
        with patch(
            "api.routes.cook_events.create_cook_event",
            side_effect=ValueError("cooked_at must not be in the future"),
        ):
            resp = authed_client.post(
                f"/api/recipes/{FAKE_RECIPE_ID}/cook",
                json={},
            )
        assert resp.status_code == 400

    def test_invalid_rating_returns_422(self, authed_client):
        resp = authed_client.post(
            f"/api/recipes/{FAKE_RECIPE_ID}/cook",
            json={"rating": 6},
        )
        assert resp.status_code == 422

    def test_rating_zero_returns_422(self, authed_client):
        resp = authed_client.post(
            f"/api/recipes/{FAKE_RECIPE_ID}/cook",
            json={"rating": 0},
        )
        assert resp.status_code == 422

    def test_extra_fields_returns_422(self, authed_client):
        resp = authed_client.post(
            f"/api/recipes/{FAKE_RECIPE_ID}/cook",
            json={"surprise_field": "hello"},
        )
        assert resp.status_code == 422


class TestListCookEventsEndpoint:
    """GET /api/recipes/{recipe_id}/cooks."""

    def test_returns_events(self, authed_client):
        events = [_make_event_row(), _make_event_row(event_id=uuid4())]
        with patch("api.routes.cook_events.list_cook_events") as mock:
            from api.models.cook_event import CookEventResponse
            mock.return_value = [CookEventResponse.model_validate(e) for e in events]
            resp = authed_client.get(f"/api/recipes/{FAKE_RECIPE_ID}/cooks")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_limit_param(self, authed_client):
        with patch("api.routes.cook_events.list_cook_events") as mock:
            mock.return_value = []
            resp = authed_client.get(f"/api/recipes/{FAKE_RECIPE_ID}/cooks?limit=5")
        assert resp.status_code == 200
        mock.assert_called_once()
        assert mock.call_args.kwargs["limit"] == 5


class TestRecentCooksEndpoint:
    """GET /api/cooks/recent."""

    def test_returns_recent_cooks(self, authed_client):
        with patch("api.routes.cook_events.list_recent_cooks") as mock:
            from api.models.cook_event import RecentCookResponse
            mock.return_value = [
                RecentCookResponse.model_validate({
                    "id": str(FAKE_EVENT_ID),
                    "recipe_id": str(FAKE_RECIPE_ID),
                    "recipe_title": "Pasta",
                    "cooked_at": NOW.isoformat(),
                    "rating": 3,
                }),
            ]
            resp = authed_client.get("/api/cooks/recent")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["recipe_title"] == "Pasta"

    def test_limit_param(self, authed_client):
        with patch("api.routes.cook_events.list_recent_cooks") as mock:
            mock.return_value = []
            resp = authed_client.get("/api/cooks/recent?limit=3")
        assert resp.status_code == 200
        mock.assert_called_once()
        assert mock.call_args.kwargs["limit"] == 3


class TestDeleteCookEventEndpoint:
    """DELETE /api/cooks/{cook_event_id}."""

    def test_returns_204(self, authed_client):
        with patch("api.routes.cook_events.delete_cook_event"):
            resp = authed_client.delete(f"/api/cooks/{FAKE_EVENT_ID}")
        assert resp.status_code == 204
        assert resp.content == b""

    def test_not_found_returns_404(self, authed_client):
        with patch(
            "api.routes.cook_events.delete_cook_event",
            side_effect=CookEventNotFoundError("not found"),
        ):
            resp = authed_client.delete(f"/api/cooks/{FAKE_EVENT_ID}")
        assert resp.status_code == 404

    def test_invalid_uuid_returns_422(self, authed_client):
        resp = authed_client.delete("/api/cooks/not-a-uuid")
        assert resp.status_code == 422
