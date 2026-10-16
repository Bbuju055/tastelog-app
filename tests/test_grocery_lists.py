"""Tests for grocery list creation, renaming, and display_name resolution.

Part 1: Pydantic model validation (CreateGroceryListRequest, RenameGroceryListRequest).
Part 2: Core function behavior (create_grocery_list, rename_grocery_list).
Part 3: Route transform functions (_resolve_display_name, _transform_list_summary).
Part 4: _recompute_list_name user_name skip behavior.
"""

import logging
from unittest.mock import MagicMock
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.models.grocery import (
    CreateGroceryListRequest,
    GroceryListResponse,
    RenameGroceryListRequest,
)
from api.core.grocery import create_grocery_list, rename_grocery_list, _recompute_list_name
from api.core.exceptions import GroceryListNotFoundError

logger = logging.getLogger("test")

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_LIST_ID = "00000000-0000-0000-0000-000000000002"


# ====================================================================
# Part 1 — Model Validation
# ====================================================================


class TestCreateGroceryListRequest:
    """Validate the create list request model."""

    def test_valid_name(self):
        req = CreateGroceryListRequest(name="Weekend BBQ")
        assert req.name == "Weekend BBQ"

    def test_empty_name_rejected(self):
        with pytest.raises(ValidationError):
            CreateGroceryListRequest(name="")

    def test_name_max_length(self):
        req = CreateGroceryListRequest(name="a" * 200)
        assert len(req.name) == 200

    def test_name_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            CreateGroceryListRequest(name="a" * 201)

    def test_extra_fields_rejected(self):
        with pytest.raises(ValidationError):
            CreateGroceryListRequest(name="Test", extra="field")


class TestRenameGroceryListRequest:
    """Validate the rename list request model."""

    def test_valid_name(self):
        req = RenameGroceryListRequest(name="Saturday Shop")
        assert req.name == "Saturday Shop"

    def test_empty_name_rejected(self):
        with pytest.raises(ValidationError):
            RenameGroceryListRequest(name="")

    def test_extra_fields_rejected(self):
        with pytest.raises(ValidationError):
            RenameGroceryListRequest(name="Test", user_name="leak")


# ====================================================================
# Part 2 — Core Functions
# ====================================================================


class TestCreateGroceryList:
    """Test create_grocery_list core function."""

    def test_creates_with_user_name(self):
        db = MagicMock()
        db.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{
                "id": FAKE_LIST_ID,
                "user_id": str(FAKE_USER_ID),
                "name": "Weekend BBQ",
                "user_name": "Weekend BBQ",
                "completed_at": None,
                "created_at": "2026-03-22T00:00:00Z",
                "updated_at": "2026-03-22T00:00:00Z",
            }]
        )

        result = create_grocery_list(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            user_name="Weekend BBQ",
        )

        assert result["user_name"] == "Weekend BBQ"
        assert result["name"] == "Weekend BBQ"

        # Verify the insert payload includes user_name
        insert_call = db.table.return_value.insert.call_args[0][0]
        assert insert_call["user_name"] == "Weekend BBQ"
        assert insert_call["name"] == "Weekend BBQ"

    def test_creates_without_user_name_uses_default(self):
        db = MagicMock()
        db.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{
                "id": FAKE_LIST_ID,
                "user_id": str(FAKE_USER_ID),
                "name": "Grocery List",
                "user_name": None,
                "completed_at": None,
                "created_at": "2026-03-22T00:00:00Z",
                "updated_at": "2026-03-22T00:00:00Z",
            }]
        )

        result = create_grocery_list(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
        )

        assert result["name"] == "Grocery List"
        assert result["user_name"] is None

        # Verify the insert payload does NOT include user_name
        insert_call = db.table.return_value.insert.call_args[0][0]
        assert "user_name" not in insert_call


class TestRenameGroceryList:
    """Test rename_grocery_list core function."""

    def _setup_db(self):
        db = MagicMock()
        # Ownership check succeeds
        db.table.return_value.select.return_value.eq.return_value.eq.return_value.single.return_value.execute.return_value = MagicMock(
            data={"id": FAKE_LIST_ID}
        )
        # Update succeeds
        db.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[{
                "id": FAKE_LIST_ID,
                "user_id": str(FAKE_USER_ID),
                "name": "Saturday Shop",
                "user_name": "Saturday Shop",
                "completed_at": None,
                "created_at": "2026-03-22T00:00:00Z",
                "updated_at": "2026-03-22T00:00:00Z",
            }]
        )
        return db

    def test_renames_successfully(self):
        db = self._setup_db()
        result = rename_grocery_list(
            UUID(FAKE_LIST_ID),
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            new_name="Saturday Shop",
        )
        assert result["user_name"] == "Saturday Shop"
        assert result["name"] == "Saturday Shop"

    def test_sets_both_user_name_and_name(self):
        db = self._setup_db()
        rename_grocery_list(
            UUID(FAKE_LIST_ID),
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            new_name="Saturday Shop",
        )
        update_payload = db.table.return_value.update.call_args[0][0]
        assert update_payload["user_name"] == "Saturday Shop"
        assert update_payload["name"] == "Saturday Shop"

    def test_strips_whitespace(self):
        db = self._setup_db()
        rename_grocery_list(
            UUID(FAKE_LIST_ID),
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            new_name="  Sunday List  ",
        )
        update_payload = db.table.return_value.update.call_args[0][0]
        assert update_payload["user_name"] == "Sunday List"

    def test_rejects_empty_after_strip(self):
        db = self._setup_db()
        with pytest.raises(ValueError, match="List name cannot be empty"):
            rename_grocery_list(
                UUID(FAKE_LIST_ID),
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                new_name="   ",
            )

    def test_not_found_raises(self):
        db = MagicMock()
        db.table.return_value.select.return_value.eq.return_value.eq.return_value.single.return_value.execute.side_effect = Exception(
            "no rows"
        )
        with pytest.raises(GroceryListNotFoundError):
            rename_grocery_list(
                UUID(FAKE_LIST_ID),
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                new_name="Test",
            )


# ====================================================================
# Part 3 — Transform Functions
# ====================================================================


class TestResolveDisplayName:
    """Test _resolve_display_name from routes."""

    def test_user_name_wins(self):
        from api.routes.grocery import _resolve_display_name
        row = {"name": "Auto Name", "user_name": "My List"}
        assert _resolve_display_name(row) == "My List"

    def test_falls_back_to_name(self):
        from api.routes.grocery import _resolve_display_name
        row = {"name": "Auto Name", "user_name": None}
        assert _resolve_display_name(row) == "Auto Name"

    def test_empty_user_name_falls_back(self):
        from api.routes.grocery import _resolve_display_name
        row = {"name": "Auto Name", "user_name": ""}
        assert _resolve_display_name(row) == "Auto Name"

    def test_missing_user_name_key_falls_back(self):
        from api.routes.grocery import _resolve_display_name
        row = {"name": "Auto Name"}
        assert _resolve_display_name(row) == "Auto Name"


class TestTransformListSummary:
    """Test _transform_list_summary produces valid model input."""

    def test_includes_display_name(self):
        from api.routes.grocery import _transform_list_summary
        row = {
            "id": FAKE_LIST_ID,
            "user_id": str(FAKE_USER_ID),
            "name": "Auto",
            "user_name": "My List",
            "completed_at": None,
            "created_at": "2026-03-22T00:00:00Z",
            "updated_at": "2026-03-22T00:00:00Z",
        }
        result = _transform_list_summary(row)
        assert result["display_name"] == "My List"
        assert "user_name" not in result

    def test_validates_with_model(self):
        from api.routes.grocery import _transform_list_summary
        row = {
            "id": FAKE_LIST_ID,
            "user_id": str(FAKE_USER_ID),
            "name": "Auto",
            "user_name": None,
            "completed_at": None,
            "created_at": "2026-03-22T00:00:00Z",
            "updated_at": "2026-03-22T00:00:00Z",
        }
        transformed = _transform_list_summary(row)
        model = GroceryListResponse.model_validate(transformed)
        assert model.display_name == "Auto"


# ====================================================================
# Part 4 — Recompute Skip
# ====================================================================


class TestRecomputeListNameSkip:
    """Test that _recompute_list_name skips when user_name is set."""

    def test_skips_when_user_name_set(self):
        db = MagicMock()
        _recompute_list_name(FAKE_LIST_ID, supabase=db, user_name="My List")
        # Should not touch the database at all
        db.table.assert_not_called()

    def test_proceeds_when_user_name_is_none(self):
        db = MagicMock()
        # Mock the items fetch for recompute
        db.table.return_value.select.return_value.eq.return_value.order.return_value.execute.return_value = MagicMock(
            data=[]
        )
        # Mock the list name update
        db.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

        _recompute_list_name(FAKE_LIST_ID, supabase=db, user_name=None)
        # Should have queried the database
        db.table.assert_called()

    def test_proceeds_when_user_name_is_empty_string(self):
        db = MagicMock()
        db.table.return_value.select.return_value.eq.return_value.order.return_value.execute.return_value = MagicMock(
            data=[]
        )
        db.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

        _recompute_list_name(FAKE_LIST_ID, supabase=db, user_name="")
        # Empty string is falsy — should proceed with recompute
        db.table.assert_called()
