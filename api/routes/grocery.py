"""
Tastelog: Grocery list API routes.

Endpoints for grocery list management and recipe remakes.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from supabase import Client

from api.core.exceptions import GroceryListForbiddenError, GroceryListNotFoundError, RecipeNotFoundError, StorageError
from api.core.grocery import (
    add_manual_item,
    create_grocery_list,
    delete_grocery_item,
    delete_grocery_list,
    get_grocery_list,
    list_grocery_lists,
    remake_recipe,
    rename_grocery_list,
    toggle_grocery_item,
)
from api.dependencies import get_current_user_id, get_db
from api.models.grocery import (
    AddManualItemRequest,
    CreateGroceryListRequest,
    GroceryItemResponse,
    GroceryListDetailResponse,
    GroceryListResponse,
    GroceryRemakeResponse,
    RemakeRequest,
    RenameGroceryListRequest,
    ToggleItemRequest,
)

logger = logging.getLogger("tastelog.api.grocery")

router = APIRouter(prefix="/api/grocery", tags=["grocery"])


def _resolve_display_name(row: dict[str, object]) -> str:
    """Compute display_name from a grocery_lists DB row.

    user_name wins when set and non-empty; otherwise falls back to
    the auto-computed name column.
    """
    user_name = row.get("user_name")
    if user_name and isinstance(user_name, str):
        return user_name
    return str(row["name"])


def _transform_list_summary(row: dict[str, object]) -> dict[str, object]:
    """Transform a raw grocery_lists DB row to GroceryListResponse shape.

    Computes display_name and strips user_name (implementation detail,
    not part of the API contract).
    """
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "name": row["name"],
        "display_name": _resolve_display_name(row),
        "completed_at": row.get("completed_at"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _transform_item(item: dict[str, object]) -> dict[str, object]:
    """
    Transform Supabase item row to response model format.

    Core returns grocery item rows joined with recipes(title) under "recipes".
    The API response flattens that join to "recipe_title".
    """
    recipe_title: str | None = None
    recipes = item.get("recipes")
    if isinstance(recipes, dict):
        title = recipes.get("title")
        if isinstance(title, str):
            recipe_title = title

    return {
        "id": item["id"],
        "list_id": item["list_id"],
        "recipe_id": item.get("recipe_id"),
        "position": item["position"],
        "quantity": item.get("quantity"),
        "unit": item.get("unit"),
        "name": item["name"],
        "checked": item.get("checked", False),
        "recipe_title": recipe_title,
        "source_recipes": item.get("source_recipes"),
        "note": item.get("note"),
    }


def _transform_list_detail(data: dict[str, object]) -> dict[str, object]:
    """
    Transform core response to GroceryListDetailResponse shape.

    Core shape:
      {"list": {...}, "items": [...]}
    """
    lst = data["list"]
    if not isinstance(lst, dict):
        raise ValueError("Invalid grocery list payload (list)")

    items = data.get("items", [])
    if not isinstance(items, list):
        items = []

    return {
        "id": lst["id"],
        "user_id": lst["user_id"],
        "name": lst["name"],
        "display_name": _resolve_display_name(lst),
        "completed_at": lst.get("completed_at"),
        "created_at": lst["created_at"],
        "updated_at": lst["updated_at"],
        "items": [_transform_item(i) for i in items if isinstance(i, dict)],
    }


@router.get("/lists", response_model=list[GroceryListResponse])
async def list_grocery_lists_endpoint(
    limit: int = Query(default=20, ge=1, le=100, description="Max results"),
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[GroceryListResponse]:
    """List grocery lists for the current user."""
    try:
        lists = list_grocery_lists(user_id=user_id, supabase=db, limit=limit)
        return [GroceryListResponse.model_validate(_transform_list_summary(lst)) for lst in lists]
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/lists", response_model=GroceryListResponse, status_code=201)
async def create_grocery_list_endpoint(
    body: CreateGroceryListRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryListResponse:
    """Create an empty grocery list with a user-provided name."""
    try:
        row = create_grocery_list(
            user_id=user_id,
            supabase=db,
            logger=logger,
            user_name=body.name,
        )
        return GroceryListResponse.model_validate(_transform_list_summary(row))
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/lists/{list_id}", response_model=GroceryListResponse)
async def rename_grocery_list_endpoint(
    list_id: UUID,
    body: RenameGroceryListRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryListResponse:
    """Rename a grocery list. Sets user_name, locking out auto-naming."""
    try:
        row = rename_grocery_list(
            list_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
            new_name=body.name,
        )
        return GroceryListResponse.model_validate(_transform_list_summary(row))
    except GroceryListNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grocery list not found: {list_id}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/remake", response_model=GroceryRemakeResponse, status_code=201)
async def remake_recipe_endpoint(
    body: RemakeRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryRemakeResponse:
    """Create a grocery list from a recipe's ingredients."""
    try:
        result = remake_recipe(
            body.recipe_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
            override_items=body.items,
            target_list_id=body.list_id,
        )

        list_data = get_grocery_list(
            UUID(str(result["list"]["id"])),
            user_id=user_id,
            supabase=db,
        )

        return GroceryRemakeResponse.model_validate({
            "list": _transform_list_detail(list_data),
            "items_added": result["items_added"],
            "items_merged": result["items_merged"],
        })
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {body.recipe_id}")
    except GroceryListNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except GroceryListForbiddenError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception:
        logger.exception("Unhandled grocery remake error")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/lists/{list_id}", response_model=GroceryListDetailResponse)
async def get_grocery_list_endpoint(
    list_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryListDetailResponse:
    """Get a grocery list with its items."""
    try:
        list_data = get_grocery_list(list_id, user_id=user_id, supabase=db)
        return GroceryListDetailResponse.model_validate(_transform_list_detail(list_data))
    except GroceryListNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grocery list not found: {list_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/items/{item_id}", response_model=GroceryItemResponse)
async def toggle_item_endpoint(
    item_id: UUID,
    body: ToggleItemRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryItemResponse:
    """Toggle the checked status of a grocery item."""
    try:
        item = toggle_grocery_item(
            item_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
            checked=body.checked,
        )
        return GroceryItemResponse.model_validate(_transform_item(item))
    except GroceryListNotFoundError:
        # Core uses GroceryListNotFoundError for missing item too (fine for Phase 1).
        raise HTTPException(status_code=404, detail=f"Grocery item not found: {item_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/items/{item_id}", status_code=204)
async def delete_grocery_item_endpoint(
    item_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> Response:
    """Delete a single grocery item."""
    try:
        delete_grocery_item(
            item_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
        )
        return Response(status_code=204)
    except GroceryListNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grocery item not found: {item_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/items", response_model=GroceryRemakeResponse, status_code=201)
async def add_manual_item_endpoint(
    body: AddManualItemRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> GroceryRemakeResponse:
    """Add a manual item to a grocery list."""
    try:
        result = add_manual_item(
            user_id=user_id,
            supabase=db,
            logger=logger,
            name=body.name,
            quantity=body.quantity,
            unit=body.unit,
            target_list_id=body.list_id,
        )

        list_data = get_grocery_list(
            UUID(str(result["list"]["id"])),
            user_id=user_id,
            supabase=db,
        )

        return GroceryRemakeResponse.model_validate({
            "list": _transform_list_detail(list_data),
            "items_added": result["items_added"],
            "items_merged": result["items_merged"],
        })
    except GroceryListNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except GroceryListForbiddenError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception:
        logger.exception("Unhandled manual item add error")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/lists/{list_id}", status_code=204)
async def delete_grocery_list_endpoint(
    list_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> None:
    """Delete a grocery list and all its items."""
    try:
        delete_grocery_list(
            list_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
        )
    except GroceryListNotFoundError:
        raise HTTPException(status_code=404, detail=f"Grocery list not found: {list_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))
