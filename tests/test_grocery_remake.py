"""Tests for grocery remake request contract and core behavior.

Part 1: Pydantic model validation (no mocks, no network).
Part 2: Core function behavior with mocked Supabase (remake_recipe branching,
         _add_override_items ordering, source immutability).
"""

from unittest.mock import MagicMock, patch, call
from uuid import UUID

import pytest
from pydantic import ValidationError

from api.models.grocery import RemakeItemInput, RemakeRequest


# ====================================================================
# Part 1 — Model Validation
# ====================================================================


class TestRemakeItemInput:
    """Validate the override item model."""

    def test_valid_item_all_fields(self):
        item = RemakeItemInput(name="flour", quantity="2", unit="cups")
        assert item.name == "flour"
        assert item.quantity == "2"
        assert item.unit == "cups"

    def test_valid_item_nullable_quantity_and_unit(self):
        item = RemakeItemInput(name="salt", quantity=None, unit=None)
        assert item.name == "salt"
        assert item.quantity is None
        assert item.unit is None

    def test_valid_item_empty_string_quantity(self):
        """Empty string quantity is allowed (permissive transport contract)."""
        item = RemakeItemInput(name="herbs", quantity="", unit=None)
        assert item.quantity == ""

    def test_rejects_empty_name(self):
        with pytest.raises(ValidationError):
            RemakeItemInput(name="", quantity="1", unit="cup")

    def test_rejects_extra_fields(self):
        with pytest.raises(ValidationError):
            RemakeItemInput(name="flour", quantity="1", unit="cup", prep="sifted")


class TestRemakeRequestBasePath:
    """Base path: recipe_id only, no items."""

    def test_base_request_valid(self):
        req = RemakeRequest(recipe_id="00000000-0000-0000-0000-000000000001")
        assert req.items is None

    def test_base_request_with_list_id(self):
        req = RemakeRequest(
            recipe_id="00000000-0000-0000-0000-000000000001",
            list_id="00000000-0000-0000-0000-000000000099",
        )
        assert req.list_id == UUID("00000000-0000-0000-0000-000000000099")
        assert req.items is None

    def test_list_id_defaults_none(self):
        req = RemakeRequest(recipe_id="00000000-0000-0000-0000-000000000001")
        assert req.list_id is None

    def test_rejects_force_new_list_field(self):
        """force_new_list was removed — extra=forbid should reject it."""
        with pytest.raises(ValidationError):
            RemakeRequest(
                recipe_id="00000000-0000-0000-0000-000000000001",
                force_new_list=True,
            )

    def test_rejects_invalid_list_id(self):
        with pytest.raises(ValidationError):
            RemakeRequest(
                recipe_id="00000000-0000-0000-0000-000000000001",
                list_id="not-a-uuid",
            )

    def test_rejects_missing_recipe_id(self):
        with pytest.raises(ValidationError):
            RemakeRequest()


class TestRemakeRequestOverridePath:
    """Override path: recipe_id + items."""

    def test_override_request_valid(self):
        req = RemakeRequest(
            recipe_id="00000000-0000-0000-0000-000000000001",
            items=[
                RemakeItemInput(name="flour", quantity="4", unit="cups"),
                RemakeItemInput(name="salt", quantity=None, unit=None),
            ],
        )
        assert req.items is not None
        assert len(req.items) == 2

    def test_override_preserves_item_order(self):
        items = [
            RemakeItemInput(name="flour", quantity="4", unit="cups"),
            RemakeItemInput(name="sugar", quantity="2", unit="cups"),
            RemakeItemInput(name="salt", quantity=None, unit=None),
        ]
        req = RemakeRequest(
            recipe_id="00000000-0000-0000-0000-000000000001",
            items=items,
        )
        assert [i.name for i in req.items] == ["flour", "sugar", "salt"]

    def test_allows_empty_items_list(self):
        """Empty items list is accepted by the model — mobile never sends it."""
        req = RemakeRequest(
            recipe_id="00000000-0000-0000-0000-000000000001",
            items=[],
        )
        assert req.items == []

    def test_rejects_extra_fields_on_request(self):
        with pytest.raises(ValidationError):
            RemakeRequest(
                recipe_id="00000000-0000-0000-0000-000000000001",
                items=[RemakeItemInput(name="flour", quantity="1", unit="cup")],
                servings="4",
            )


# ====================================================================
# Part 1b — Endpoint Validation (HTTP layer)
# ====================================================================


def test_remake_rejects_invalid_recipe_id(authed_client):
    """Remake endpoint rejects invalid UUID for recipe_id."""
    resp = authed_client.post(
        "/api/grocery/remake",
        json={"recipe_id": "not-a-uuid"},
    )
    assert resp.status_code == 422


def test_remake_rejects_items_with_empty_name(authed_client):
    """Remake endpoint rejects override items with empty name."""
    resp = authed_client.post(
        "/api/grocery/remake",
        json={
            "recipe_id": "00000000-0000-0000-0000-000000000001",
            "items": [{"name": "", "quantity": "1", "unit": "cup"}],
        },
    )
    assert resp.status_code == 422


def test_remake_rejects_extra_fields_in_items(authed_client):
    """Remake endpoint rejects extra fields in override items (extra=forbid)."""
    resp = authed_client.post(
        "/api/grocery/remake",
        json={
            "recipe_id": "00000000-0000-0000-0000-000000000001",
            "items": [{"name": "flour", "quantity": "1", "unit": "cup", "prep": "sifted"}],
        },
    )
    assert resp.status_code == 422


# ====================================================================
# Part 2 — Core Behavior Tests (mocked Supabase)
# ====================================================================

import logging

from api.core.grocery import remake_recipe, _add_override_items, _merge_key, _compute_list_name, MergeResult

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_RECIPE_ID = UUID("00000000-0000-0000-0000-000000000002")
FAKE_LIST_ID = "00000000-0000-0000-0000-000000000003"
FAKE_RECIPE_TITLE = "Test Recipe"

logger = logging.getLogger("test")


class TestRemakeRecipeBranching:
    """Test that remake_recipe branches correctly on override_items."""

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._add_override_items")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_base_path_uses_recipe_derived_items(
        self, mock_get_active, mock_override, mock_recipe_to_list, mock_rename
    ):
        """When override_items is None, use _add_recipe_to_list, not _add_override_items."""
        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_recipe_to_list.return_value = MergeResult(inserted=3, merged=0)

        result = remake_recipe(
            FAKE_RECIPE_ID,
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            override_items=None,
        )

        mock_recipe_to_list.assert_called_once_with(
            FAKE_LIST_ID,
            str(FAKE_RECIPE_ID),
            FAKE_RECIPE_TITLE,
            supabase=db,
        )
        mock_override.assert_not_called()
        assert result["items_added"] == 3
        assert result["items_merged"] == 0
        mock_rename.assert_called_once_with(FAKE_LIST_ID, supabase=db, user_name=None)

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._add_override_items")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_override_path_uses_provided_items(
        self, mock_get_active, mock_override, mock_recipe_to_list, mock_rename
    ):
        """When override_items is provided, use _add_override_items, not _add_recipe_to_list."""
        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_override.return_value = MergeResult(inserted=2, merged=0)

        items = [
            RemakeItemInput(name="flour", quantity="4", unit="cups"),
            RemakeItemInput(name="salt", quantity=None, unit=None),
        ]

        result = remake_recipe(
            FAKE_RECIPE_ID,
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            override_items=items,
        )

        mock_override.assert_called_once_with(
            FAKE_LIST_ID,
            str(FAKE_RECIPE_ID),
            FAKE_RECIPE_TITLE,
            items,
            supabase=db,
        )
        mock_recipe_to_list.assert_not_called()
        assert result["items_added"] == 2
        assert result["items_merged"] == 0

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._add_override_items")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_override_path_does_not_fetch_recipe_ingredients(
        self, mock_get_active, mock_override, mock_recipe_to_list, mock_rename
    ):
        """Override path must not call recipe-derived helper (source immutability)."""
        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_override.return_value = MergeResult(inserted=1, merged=0)

        items = [RemakeItemInput(name="flour", quantity="2", unit="cups")]

        remake_recipe(
            FAKE_RECIPE_ID,
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            override_items=items,
        )

        mock_recipe_to_list.assert_not_called()

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_target_list_id_skips_active_list(
        self, mock_fetch_list, mock_recipe_to_list, mock_rename
    ):
        """When target_list_id is provided, use that list — not get_or_create_active_list."""
        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        target_id = UUID("00000000-0000-0000-0000-000000000099")
        mock_fetch_list.return_value = {"id": str(target_id), "user_id": str(FAKE_USER_ID)}
        mock_recipe_to_list.return_value = MergeResult(inserted=2, merged=0)

        result = remake_recipe(
            FAKE_RECIPE_ID,
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            target_list_id=target_id,
        )

        mock_fetch_list.assert_called_once_with(
            target_id,
            user_id=FAKE_USER_ID,
            supabase=db,
        )
        assert result["items_added"] == 2
        assert result["items_merged"] == 0

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_target_list_id_not_found_raises_404(
        self, mock_fetch_list, mock_recipe_to_list, mock_rename
    ):
        """When target_list_id does not exist, raise GroceryListNotFoundError."""
        from api.core.exceptions import GroceryListNotFoundError

        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_fetch_list.side_effect = GroceryListNotFoundError(
            "Grocery list not found", code="GROCERY_LIST_NOT_FOUND"
        )

        with pytest.raises(GroceryListNotFoundError):
            remake_recipe(
                FAKE_RECIPE_ID,
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                target_list_id=UUID("00000000-0000-0000-0000-000000000099"),
            )

        mock_recipe_to_list.assert_not_called()

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._fetch_grocery_list_for_user")
    def test_target_list_id_foreign_owner_raises_forbidden(
        self, mock_fetch_list, mock_recipe_to_list, mock_rename
    ):
        """When target_list_id is owned by another user, raise GroceryListForbiddenError."""
        from api.core.exceptions import GroceryListForbiddenError

        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_fetch_list.side_effect = GroceryListForbiddenError(
            "Grocery list not owned by user", code="GROCERY_LIST_NOT_OWNED"
        )

        with pytest.raises(GroceryListForbiddenError):
            remake_recipe(
                FAKE_RECIPE_ID,
                user_id=FAKE_USER_ID,
                supabase=db,
                logger=logger,
                target_list_id=UUID("00000000-0000-0000-0000-000000000099"),
            )

        mock_recipe_to_list.assert_not_called()

    @patch("api.core.grocery._recompute_list_name")
    @patch("api.core.grocery._add_recipe_to_list")
    @patch("api.core.grocery._add_override_items")
    @patch("api.core.grocery.get_or_create_active_list")
    def test_items_merged_propagated_in_response(
        self, mock_get_active, mock_override, mock_recipe_to_list, mock_rename
    ):
        """When merge engine reports merged items, response carries both counts."""
        db = MagicMock()

        recipe_chain = MagicMock()
        recipe_chain.execute.return_value = MagicMock(
            data={"title": FAKE_RECIPE_TITLE}
        )
        db.table.return_value.select.return_value.eq.return_value.single.return_value = recipe_chain

        mock_get_active.return_value = {"id": FAKE_LIST_ID}
        mock_recipe_to_list.return_value = MergeResult(inserted=1, merged=2)

        result = remake_recipe(
            FAKE_RECIPE_ID,
            user_id=FAKE_USER_ID,
            supabase=db,
            logger=logger,
            override_items=None,
        )

        assert result["items_added"] == 3
        assert result["items_merged"] == 2


# ====================================================================
# Part 2b — Merge Engine Unit Tests
# ====================================================================


class TestMergeKey:
    """Test merge key computation."""

    def test_basic_key(self):
        assert _merge_key("Flour", "cups") == "flour::cups"

    def test_trims_whitespace(self):
        assert _merge_key("  Flour  ", "  cups  ") == "flour::cups"

    def test_null_unit(self):
        assert _merge_key("Salt", None) == "salt::"

    def test_case_insensitive(self):
        assert _merge_key("FLOUR", "CUPS") == _merge_key("flour", "cups")

    def test_different_units_different_keys(self):
        assert _merge_key("flour", "cups") != _merge_key("flour", "tbsp")


class TestComputeListName:
    """Test bounded list naming."""

    def test_empty_sources(self):
        assert _compute_list_name([]) == "Grocery List"

    def test_single_recipe(self):
        assert _compute_list_name([{"id": "1", "title": "Carbonara"}]) == "Carbonara"

    def test_two_recipes(self):
        sources = [
            {"id": "1", "title": "Carbonara"},
            {"id": "2", "title": "Risotto"},
        ]
        assert _compute_list_name(sources) == "Carbonara + Risotto"

    def test_three_recipes(self):
        sources = [
            {"id": "1", "title": "Carbonara"},
            {"id": "2", "title": "Risotto"},
            {"id": "3", "title": "Soup"},
        ]
        assert _compute_list_name(sources) == "Carbonara + Risotto + 1 more"

    def test_five_recipes(self):
        sources = [{"id": str(i), "title": f"Recipe {i}"} for i in range(5)]
        assert _compute_list_name(sources) == "Recipe 0 + Recipe 1 + 3 more"


# ====================================================================
# Part 2c — Override Items (into empty list, no merge)
# ====================================================================


def _mock_db_empty_list():
    """Mock Supabase for an empty grocery list (no existing items)."""
    db = MagicMock()

    # grocery_items.select(...).eq(...).order(...).execute() → empty
    select_chain = MagicMock()
    select_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.select.return_value.eq.return_value.order.return_value = select_chain

    # grocery_items.insert(...).execute()
    insert_chain = MagicMock()
    insert_chain.execute.return_value = MagicMock(data=[])
    db.table.return_value.insert.return_value = insert_chain

    return db


class TestAddOverrideItemsOrdering:
    """Test that _add_override_items preserves order and assigns correct positions."""

    def test_inserts_items_in_order_with_sequential_positions(self):
        """Items into empty list get positions 1, 2, 3 with source_recipes."""
        db = _mock_db_empty_list()

        items = [
            RemakeItemInput(name="flour", quantity="4", unit="cups"),
            RemakeItemInput(name="sugar", quantity="2", unit="cups"),
            RemakeItemInput(name="salt", quantity=None, unit=None),
        ]

        result = _add_override_items(
            FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE,
            items, supabase=db,
        )

        assert result.inserted == 3
        assert result.merged == 0

        insert_call_args = db.table.return_value.insert.call_args[0][0]
        assert len(insert_call_args) == 3

        expected_source = [{"id": str(FAKE_RECIPE_ID), "title": FAKE_RECIPE_TITLE}]

        assert insert_call_args[0]["name"] == "flour"
        assert insert_call_args[0]["quantity"] == "4"
        assert insert_call_args[0]["unit"] == "cups"
        assert insert_call_args[0]["position"] == 1
        assert insert_call_args[0]["checked"] is False
        assert insert_call_args[0]["recipe_id"] == str(FAKE_RECIPE_ID)
        assert insert_call_args[0]["source_recipes"] == expected_source

        assert insert_call_args[1]["name"] == "sugar"
        assert insert_call_args[1]["position"] == 2

        assert insert_call_args[2]["name"] == "salt"
        assert insert_call_args[2]["position"] == 3

    def test_all_items_have_checked_false(self):
        db = _mock_db_empty_list()

        items = [
            RemakeItemInput(name="flour", quantity="1", unit="cup"),
            RemakeItemInput(name="salt", quantity=None, unit=None),
        ]

        _add_override_items(FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE,
                            items, supabase=db)

        rows = db.table.return_value.insert.call_args[0][0]
        assert all(row["checked"] is False for row in rows)

    def test_all_items_retain_recipe_id(self):
        db = _mock_db_empty_list()

        items = [
            RemakeItemInput(name="flour", quantity="1", unit="cup"),
        ]

        _add_override_items(FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE,
                            items, supabase=db)

        rows = db.table.return_value.insert.call_args[0][0]
        assert all(row["recipe_id"] == str(FAKE_RECIPE_ID) for row in rows)

    def test_skips_items_with_whitespace_only_name(self):
        db = _mock_db_empty_list()

        items = [
            RemakeItemInput(name="flour", quantity="1", unit="cup"),
            RemakeItemInput(name="   ", quantity="2", unit="tbsp"),
            RemakeItemInput(name="sugar", quantity="3", unit="cups"),
        ]

        result = _add_override_items(FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE,
                                     items, supabase=db)

        assert result.inserted == 2
        assert result.merged == 0
        rows = db.table.return_value.insert.call_args[0][0]
        assert len(rows) == 2
        assert rows[0]["name"] == "flour"
        assert rows[0]["position"] == 1
        assert rows[1]["name"] == "sugar"
        assert rows[1]["position"] == 2

    def test_all_invalid_names_returns_zero_no_insert(self):
        db = _mock_db_empty_list()

        items = [
            RemakeItemInput(name="   ", quantity="1", unit="cup"),
        ]

        result = _add_override_items(FAKE_LIST_ID, str(FAKE_RECIPE_ID), FAKE_RECIPE_TITLE,
                                     items, supabase=db)

        assert result.inserted == 0
        assert result.merged == 0
        db.table.return_value.insert.assert_not_called()
