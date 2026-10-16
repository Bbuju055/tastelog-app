"""Tests for individual grocery item deletion.

Part 1: Core function behavior (delete_grocery_item).
Part 2: HTTP endpoint validation (DELETE /api/grocery/items/{item_id}).
"""

import logging
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest

from api.core.exceptions import GroceryListNotFoundError, StorageError
from api.core.grocery import delete_grocery_item

logger = logging.getLogger("test")

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_ITEM_ID = UUID("00000000-0000-0000-0000-000000000010")
FAKE_LIST_ID = "00000000-0000-0000-0000-000000000002"
OTHER_USER_ID = UUID("00000000-0000-0000-0000-000000000099")


# ====================================================================
# Part 1 — Core Function
# ====================================================================


def _mock_supabase_for_delete(
    owner_id: str = str(FAKE_USER_ID),
    list_id: str = FAKE_LIST_ID,
    select_raises: Exception | None = None,
    delete_raises: Exception | None = None,
) -> MagicMock:
    """Build a mock Supabase client for delete_grocery_item tests."""
    db = MagicMock()

    # Chain: table("grocery_items").select(...).eq(...).single().execute()
    select_chain = db.table.return_value.select.return_value.eq.return_value.single.return_value

    if select_raises:
        select_chain.execute.side_effect = select_raises
    else:
        select_chain.execute.return_value.data = {
            "id": str(FAKE_ITEM_ID),
            "list_id": list_id,
            "grocery_lists": {"user_id": owner_id},
        }

    # Chain: table("grocery_items").delete().eq(...).execute()
    delete_chain = db.table.return_value.delete.return_value.eq.return_value
    if delete_raises:
        delete_chain.execute.side_effect = delete_raises
    else:
        delete_chain.execute.return_value = MagicMock()

    return db


class TestDeleteGroceryItem:
    """Core delete_grocery_item function."""

    def test_success_returns_list_id(self):
        db = _mock_supabase_for_delete()
        result = delete_grocery_item(
            FAKE_ITEM_ID, user_id=FAKE_USER_ID, supabase=db, logger=logger,
        )
        assert result == FAKE_LIST_ID
        # Verify delete was actually executed
        db.table.return_value.delete.return_value.eq.return_value.execute.assert_called_once()

    def test_not_found_raises(self):
        db = _mock_supabase_for_delete(
            select_raises=Exception("0 rows returned"),
        )
        with pytest.raises(GroceryListNotFoundError):
            delete_grocery_item(
                FAKE_ITEM_ID, user_id=FAKE_USER_ID, supabase=db, logger=logger,
            )

    def test_wrong_owner_raises(self):
        db = _mock_supabase_for_delete(owner_id=str(OTHER_USER_ID))
        with pytest.raises(GroceryListNotFoundError):
            delete_grocery_item(
                FAKE_ITEM_ID, user_id=FAKE_USER_ID, supabase=db, logger=logger,
            )
        # Verify delete was NOT executed when ownership fails
        db.table.return_value.delete.assert_not_called()

    def test_delete_db_error_raises_storage_error(self):
        db = _mock_supabase_for_delete(
            delete_raises=Exception("connection lost"),
        )
        with pytest.raises(StorageError):
            delete_grocery_item(
                FAKE_ITEM_ID, user_id=FAKE_USER_ID, supabase=db, logger=logger,
            )

    def test_select_db_error_raises_storage_error(self):
        db = _mock_supabase_for_delete(
            select_raises=Exception("timeout"),
        )
        with pytest.raises(StorageError):
            delete_grocery_item(
                FAKE_ITEM_ID, user_id=FAKE_USER_ID, supabase=db, logger=logger,
            )


# ====================================================================
# Part 2 — HTTP Endpoint
# ====================================================================


class TestDeleteGroceryItemEndpoint:
    """DELETE /api/grocery/items/{item_id}."""

    def test_valid_delete_returns_204(self, authed_client):
        with patch(
            "api.routes.grocery.delete_grocery_item",
            return_value=FAKE_LIST_ID,
        ):
            resp = authed_client.delete(f"/api/grocery/items/{FAKE_ITEM_ID}")
        assert resp.status_code == 204
        assert resp.content == b""

    def test_not_found_returns_404(self, authed_client):
        with patch(
            "api.routes.grocery.delete_grocery_item",
            side_effect=GroceryListNotFoundError("not found", code="GROCERY_ITEM_NOT_FOUND"),
        ):
            resp = authed_client.delete(f"/api/grocery/items/{FAKE_ITEM_ID}")
        assert resp.status_code == 404

    def test_invalid_uuid_returns_422(self, authed_client):
        resp = authed_client.delete("/api/grocery/items/not-a-uuid")
        assert resp.status_code == 422
