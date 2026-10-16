"""Tests for manual grocery item add — model validation, HTTP layer, core behavior.

Mirrors test_grocery_remake.py structure:
  Part 1: Pydantic model validation (no mocks, no network)
  Part 1b: HTTP endpoint validation (authed_client)
  Part 2: Core function behavior with mocked Supabase
"""

import logging
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.core.grocery import add_manual_item, MergeResult
from api.models.grocery import AddManualItemRequest

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_LIST_ID = "00000000-0000-0000-0000-000000000003"

logger = logging.getLogger("test")


# ====================================================================
# Part 1 — Model Validation
# ====================================================================


class TestAddManualItemRequest:
    """Validate the manual add request model."""

    def test_valid_name_only(self):
        req = AddManualItemRequest(name="Milk")
        assert req.name == "Milk"
        assert req.quantity is None
        assert req.unit is None
        assert req.list_id is None

    def test_valid_all_fields(self):
        req = AddManualItemRequest(
            name="Flour",
            quantity="2",
            unit="cups",
            list_id="00000000-0000-0000-0000-000000000003",
        )
        assert req.name == "Flour"
        assert req.quantity == "2"
        assert req.unit == "cups"
        assert req.list_id == UUID("00000000-0000-0000-0000-000000000003")

    def test_rejects_empty_name(self):
        with pytest.raises(ValidationError):
            AddManualItemRequest(name="")

    def test_rejects_name_over_200_chars(self):
        with pytest.raises(ValidationError):
            AddManualItemRequest(name="x" * 201)

    def test_accepts_name_at_200_chars(self):
        req = AddManualItemRequest(name="x" * 200)
        assert len(req.name) == 200

    def test_rejects_invalid_list_id(self):
        with pytest.raises(ValidationError):
            AddManualItemRequest(name="Milk", list_id="not-a-uuid")

    def test_rejects_extra_fields(self):
        with pytest.raises(ValidationError):
            AddManualItemRequest(name="Milk", recipe_id="00000000-0000-0000-0000-000000000001")


# ====================================================================
# Part 1b — HTTP Endpoint Validation
# ====================================================================


def test_manual_add_rejects_empty_name(authed_client):
    resp = authed_client.post(
        "/api/grocery/items",
        json={"name": ""},
    )
    assert resp.status_code == 422


def test_manual_add_rejects_missing_name(authed_client):
    resp = authed_client.post(
        "/api/grocery/items",
        json={},
    )
    assert resp.status_code == 422


def test_manual_add_rejects_invalid_list_id(authed_client):
    resp = authed_client.post(
        "/api/grocery/items",
        json={"name": "Milk", "list_id": "not-a-uuid"},
    )
    assert resp.status_code == 422


def test_manual_add_rejects_extra_fields(authed_client):
    resp = authed_client.post(
        "/api/grocery/items",
        json={"name": "Milk", "recipe_id": "00000000-0000-0000-0000-000000000001"},
    )
    assert resp.status_code == 422


# ====================================================================
# Part 2 — Core Behavior (mocked Supabase)
# ====================================================================


class TestAddManualItemCore:
    """Test add_manual_item routing and merge engine integration."""

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_auto_resolves_active_list_when_no_list_id(
        self, mock_get_active, mock_merge, mock_rename
    ):
        """When list_id is None, use get_or_create_active_list."""
        db = MagicMock()
        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_merge.return_value = MergeResult(inserted=1, merged=0)

        result = add_manual_item(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            name="Milk",
        )

        mock_get_active.assert_called_once_with(
            user_id=FAKE_USER_ID, supabase=db, logger=logger,
        )
        mock_merge.assert_called_once_with(
            FAKE_LIST_ID, None, None,
            [{"name": "Milk", "quantity": None, "unit": None}],
            supabase=db,
        )
        assert result["items_added"] == 1
        assert result["items_merged"] == 0

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_uses_target_list_when_list_id_provided(
        self, mock_fetch_list, mock_merge, mock_rename
    ):
        """When list_id is provided, validate and use that list."""
        db = MagicMock()
        target_id = UUID("00000000-0000-0000-0000-000000000099")
        mock_fetch_list.return_value = {"id": str(target_id), "user_id": str(FAKE_USER_ID)}
        mock_merge.return_value = MergeResult(inserted=1, merged=0)

        result = add_manual_item(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            name="Eggs",
            target_list_id=target_id,
        )

        mock_fetch_list.assert_called_once_with(
            target_id, user_id=FAKE_USER_ID, supabase=db,
        )
        assert result["items_added"] == 1

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_passes_recipe_id_none_to_merge(
        self, mock_get_active, mock_merge, mock_rename
    ):
        """Manual items pass recipe_id=None and recipe_title=None to merge engine."""
        db = MagicMock()
        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_merge.return_value = MergeResult(inserted=1, merged=0)

        add_manual_item(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            name="Butter",
            quantity="1",
            unit="stick",
        )

        call_args = mock_merge.call_args
        assert call_args[0][1] is None  # recipe_id
        assert call_args[0][2] is None  # recipe_title
        assert call_args[0][3] == [{"name": "Butter", "quantity": "1", "unit": "stick"}]

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_merge_counts_propagated(
        self, mock_get_active, mock_merge, mock_rename
    ):
        """When merge engine merges, counts are correctly returned."""
        db = MagicMock()
        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_merge.return_value = MergeResult(inserted=0, merged=1)

        result = add_manual_item(
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            name="Flour",
        )

        assert result["items_added"] == 1  # total = inserted + merged
        assert result["items_merged"] == 1

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_not_found_list_raises(
        self, mock_fetch_list, mock_merge, mock_rename
    ):
        """When list_id does not exist, raise GroceryListNotFoundError."""
        from api.core.exceptions import GroceryListNotFoundError

        db = MagicMock()
        mock_fetch_list.side_effect = GroceryListNotFoundError(
            "Grocery list not found", code="GROCERY_LIST_NOT_FOUND"
        )

        with pytest.raises(GroceryListNotFoundError):
            add_manual_item(
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                name="Milk",
                target_list_id=UUID("00000000-0000-0000-0000-000000000099"),
            )

        mock_merge.assert_not_called()

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._merge_items_into_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_foreign_list_raises(
        self, mock_fetch_list, mock_merge, mock_rename
    ):
        """When list_id is owned by another user, raise GroceryListForbiddenError."""
        from api.core.exceptions import GroceryListForbiddenError

        db = MagicMock()
        mock_fetch_list.side_effect = GroceryListForbiddenError(
            "Grocery list not owned by user", code="GROCERY_LIST_NOT_OWNED"
        )

        with pytest.raises(GroceryListForbiddenError):
            add_manual_item(
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                name="Milk",
                target_list_id=UUID("00000000-0000-0000-0000-000000000099"),
            )

        mock_merge.assert_not_called()


# ====================================================================
# Part 3 — Merge Engine: manual items (recipe_id=None)
# ====================================================================


def _mock_db_empty_list():
    """Mock Supabase for an empty grocery list (no existing items)."""
    db = MagicMock()

    select_chain = MagicMock()
    select_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.select.return_value.eq.return_value.order.return_value = select_chain

    insert_chain = MagicMock()
    insert_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.insert.return_value = insert_chain

    return db


def _mock_db_with_existing_item(*, name, unit, quantity, source_recipes=None):
    """Mock Supabase with one existing item for merge testing."""
    db = MagicMock()

    existing_row = {
        "id": "existing-item-1",
        "name": name,
        "unit": unit,
        "quantity": quantity,
        "position": 1,
        "source_recipes": source_recipes,
    }

    select_chain = MagicMock()
    select_chain.execute.return_value = MagicMock(data=[existing_row])
    db.table.return_value.select.return_value.eq.return_value.order.return_value = select_chain

    update_chain = MagicMock()
    update_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.update.return_value.eq.return_value = update_chain

    return db


class TestMergeEngineManualItems:
    """Test that merge engine handles recipe_id=None correctly."""

    def test_manual_insert_has_no_recipe_id(self):
        """Inserted manual item has recipe_id=None."""
        from api.core.grocery import _merge_items_into_list

        db = _mock_db_empty_list()
        incoming = [{"name": "Milk", "quantity": None, "unit": None}]

        result = _merge_items_into_list(FAKE_LIST_ID, None, None, incoming, supabase=db)

        assert result.inserted == 1
        rows = db.table.return_value.insert.call_args[0][0]
        assert rows[0]["recipe_id"] is None

    def test_manual_insert_has_no_source_recipes(self):
        """Inserted manual item has source_recipes=None."""
        from api.core.grocery import _merge_items_into_list

        db = _mock_db_empty_list()
        incoming = [{"name": "Eggs", "quantity": "6", "unit": None}]

        _merge_items_into_list(FAKE_LIST_ID, None, None, incoming, supabase=db)

        rows = db.table.return_value.insert.call_args[0][0]
        assert rows[0]["source_recipes"] is None

    def test_manual_merge_preserves_existing_attribution(self):
        """When manual item merges into a recipe-sourced row, existing source_recipes is untouched."""
        from api.core.grocery import _merge_items_into_list

        existing_sources = [{"id": "recipe-1", "title": "Pancakes"}]
        db = _mock_db_with_existing_item(
            name="Flour", unit="cups", quantity="2",
            source_recipes=existing_sources,
        )
        incoming = [{"name": "Flour", "quantity": "1", "unit": "cups"}]

        result = _merge_items_into_list(FAKE_LIST_ID, None, None, incoming, supabase=db)

        assert result.merged == 1
        assert result.inserted == 0

        # Verify the update call: quantity summed, source_recipes NOT in update payload
        update_call = db.table.return_value.update.call_args[0][0]
        assert "quantity" in update_call
        assert "source_recipes" not in update_call

    def test_manual_merge_into_unattributed_row_stays_unattributed(self):
        """When manual item merges into a row with no source_recipes, it stays None."""
        from api.core.grocery import _merge_items_into_list

        db = _mock_db_with_existing_item(
            name="Butter", unit="stick", quantity="1",
            source_recipes=None,
        )
        incoming = [{"name": "Butter", "quantity": "1", "unit": "stick"}]

        result = _merge_items_into_list(FAKE_LIST_ID, None, None, incoming, supabase=db)

        assert result.merged == 1
        update_call = db.table.return_value.update.call_args[0][0]
        assert "source_recipes" not in update_call
