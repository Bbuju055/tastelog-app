"""
Tastelog: Grocery list operations.

Pure functions with explicit dependencies - no global state.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from supabase import Client

from api.core.exceptions import GroceryListForbiddenError, GroceryListNotFoundError, RecipeNotFoundError, StorageError
from api.core.quantity import display_quantity, parse_quantity
from api.models.grocery import RemakeItemInput


# ---------------------------------------------------------------------------
# Merge key
# ---------------------------------------------------------------------------


_NOTE_PREFIX = "in place of"


def _normalize_note(note: str | None) -> str:
    """Normalize a provenance note for merge comparison ONLY.

    Trim, collapse internal whitespace, lowercase. None normalizes to the
    empty string, so unlabeled rows merge exactly as before and a labeled
    row never merges into an unlabeled one. The stored and rendered value
    is always the trimmed original, never this normalized form.
    """
    if not note:
        return ""
    return " ".join(note.split()).lower()


def _note_from_prep(prep: str | None) -> str | None:
    """Derive a grocery provenance note from an ingredient prep field (OD-1).

    Carries prep into grocery_items.note ONLY when, after trimming and
    removal of AT MOST one fully-surrounding parenthesis pair, it begins
    case-insensitively with the exact phrase "in place of " (trailing space
    included) AND the remaining target text is non-empty after trimming
    (the Riff substitution-label convention). Malformed labels ("in place
    ofX", bare/empty-target "in place of") and ordinary preparation text
    (diced, sliced, packed, minced, divided, ...) yield None. Returns the
    trimmed, paren-stripped label — original casing preserved.

    Mirrored byte-for-byte in decision behavior by `noteFromPrep`
    (tastelog-mobile/lib/ingredients/groceryOverride.ts); the shared
    contract is pinned by the OD-1 parity tables in tests/test_grocery.py
    and __tests__/lib/ingredients/groceryOverride.test.ts.
    """
    if not prep:
        return None
    text = prep.strip()
    if len(text) >= 2 and text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    if not text.lower().startswith(_NOTE_PREFIX + " "):
        return None
    if not text[len(_NOTE_PREFIX) + 1 :].strip():
        return None
    return text


def _merge_key(name: str, unit: str | None, note: str | None = None) -> str:
    """
    Compute the merge key for a grocery item.

    Key: lowercase(trim(name)) + "::" + lowercase(trim(unit ?? "")), plus a
    "::" + normalized(note) suffix ONLY when a provenance note is present.
    Unlabeled rows therefore keep the exact pre-note key and merge exactly
    as before; rows with equal normalized notes may merge when name and
    unit also match; a labeled replacement row never merges into an
    unlabeled retained row.
    No fuzzy matching, no synonyms, no plural logic, no cross-unit logic.
    """
    n = name.strip().lower()
    u = (unit or "").strip().lower()
    note_norm = _normalize_note(note)
    if note_norm:
        return f"{n}::{u}::{note_norm}"
    return f"{n}::{u}"


# ---------------------------------------------------------------------------
# Attribution helpers
# ---------------------------------------------------------------------------


def _make_source(recipe_id: str, recipe_title: str) -> dict[str, str]:
    """Build a single source_recipes entry."""
    return {"id": recipe_id, "title": recipe_title}


def _append_source(
    existing_sources: list[dict[str, str]] | None,
    new_source: dict[str, str],
) -> list[dict[str, str]]:
    """
    Append a recipe source if its id is not already present.
    Preserves insertion order. Deduplicates by id only.
    """
    sources = list(existing_sources) if existing_sources else []
    if not any(s["id"] == new_source["id"] for s in sources):
        sources.append(new_source)
    return sources


# ---------------------------------------------------------------------------
# List naming
# ---------------------------------------------------------------------------


def _compute_list_name(source_recipes: list[dict[str, str]]) -> str:
    """
    Compute a bounded list name from all source recipes.

    Rules:
      1 recipe  → "Carbonara"
      2 recipes → "Carbonara + Risotto"
      3+ recipes → "Carbonara + Risotto + 1 more"

    Max 2 explicit names. Preserves first-added order. Deterministic.
    """
    if not source_recipes:
        return "Grocery List"

    titles = [s["title"] for s in source_recipes]

    if len(titles) == 1:
        return titles[0]
    if len(titles) == 2:
        return f"{titles[0]} + {titles[1]}"

    extra = len(titles) - 2
    return f"{titles[0]} + {titles[1]} + {extra} more"


def _recompute_list_name(
    list_id: str,
    *,
    supabase: Client,
    user_name: str | None = None,
) -> None:
    """
    Collect all unique source recipes across items in the list,
    compute the bounded name, and update the list.

    Skips recompute when user_name is set — user-named lists keep their
    name regardless of recipe additions.
    """
    if user_name:
        return
    try:
        items_result = (
            supabase.table("grocery_items")
            .select("source_recipes")
            .eq("list_id", list_id)
            .order("position")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to fetch items for naming: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    # Collect unique sources preserving first-seen order (by position)
    seen_ids: set[str] = set()
    all_sources: list[dict[str, str]] = []
    for item in items_result.data or []:
        sources = item.get("source_recipes")
        if not isinstance(sources, list):
            continue
        for s in sources:
            if isinstance(s, dict) and s.get("id") and s["id"] not in seen_ids:
                seen_ids.add(s["id"])
                all_sources.append(s)

    name = _compute_list_name(all_sources)

    try:
        supabase.table("grocery_lists").update({"name": name}).eq("id", list_id).execute()
    except Exception as e:
        raise StorageError(
            f"Failed to update list name: {type(e).__name__}: {str(e)[:100]}",
            code="DB_UPDATE_FAILED",
        )


# ---------------------------------------------------------------------------
# Active list resolver
# ---------------------------------------------------------------------------


def get_or_create_active_list(
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> dict[str, object]:
    """
    Find the most recently updated incomplete grocery list for the user,
    or create a new one.

    Active list: completed_at IS NULL, ordered by updated_at DESC.
    Naming is not this function's concern — callers recompute the list
    name after items are added.
    """
    try:
        result = (
            supabase.table("grocery_lists")
            .select("*")
            .eq("user_id", str(user_id))
            .is_("completed_at", "null")
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to query active grocery list: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if result.data:
        logger.info(f"Reusing active grocery list: {result.data[0]['id']}")
        return result.data[0]

    return create_grocery_list(
        user_id=user_id,
        supabase=supabase,
        logger=logger,
    )


def create_grocery_list(
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    name: str | None = None,
    user_name: str | None = None,
) -> dict[str, object]:
    """Create a new empty grocery list.

    When user_name is provided, the list is user-named and auto-naming
    will be skipped on future recipe additions.  The name column is also
    set to user_name so display_name resolves correctly even before any
    recipes are added.
    """
    if user_name:
        name = user_name
    elif not name:
        name = "Grocery List"

    row: dict[str, object] = {
        "user_id": str(user_id),
        "name": name,
    }
    if user_name:
        row["user_name"] = user_name

    try:
        result = (
            supabase.table("grocery_lists")
            .insert(row)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to create grocery list: {type(e).__name__}: {str(e)[:100]}",
            code="DB_INSERT_FAILED",
        )

    if not result.data:
        raise StorageError("Grocery list insert returned no data", code="DB_INSERT_FAILED")

    logger.info(f"Created grocery list: {result.data[0]['id']}")
    return result.data[0]


# ---------------------------------------------------------------------------
# Merge engine (shared by both insert paths)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class MergeResult:
    """Result of merging items into a grocery list."""

    inserted: int = 0
    merged: int = 0

    @property
    def total(self) -> int:
        return self.inserted + self.merged


def _merge_items_into_list(
    list_id: str,
    recipe_id: str | None,
    recipe_title: str | None,
    incoming: list[dict[str, str | None]],
    *,
    supabase: Client,
) -> MergeResult:
    """
    Merge incoming items into an existing grocery list.

    For each incoming item:
      1. Compute merge key (name + unit + normalized provenance note)
      2. If an existing item has the same key AND both quantities parse → sum
      3. Otherwise → insert as new row

    incoming items have shape:
      {"name": str, "quantity": str|None, "unit": str|None, "note": str|None}
    ("note" is optional; absent behaves as null. Empty/whitespace notes are
    normalized to null at this boundary, mirroring the 4.1.D hardening.)

    When recipe_id is None (manual items), no source_recipes attribution is
    written and existing attribution on merged rows is left untouched.

    Returns MergeResult with inserted and merged counts.
    """
    if not incoming:
        return MergeResult()

    if recipe_id is None and recipe_title is None:
        source = None
    else:
        source = _make_source(recipe_id, recipe_title)

    # Fetch existing items for merge lookup
    try:
        existing_result = (
            supabase.table("grocery_items")
            .select("id, name, unit, quantity, position, source_recipes, note")
            .eq("list_id", list_id)
            .order("position")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to fetch existing items for merge: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    # Build merge index: key → existing item row.
    # Only the first occurrence per key is indexed (stable merge target).
    # Newly inserted items are NOT added to this index — merges only
    # target rows that existed before this batch started.
    existing_by_key: dict[str, dict[str, object]] = {}
    max_position = 0
    for row in existing_result.data or []:
        key = _merge_key(row["name"], row.get("unit"), row.get("note"))
        if key not in existing_by_key:
            existing_by_key[key] = row
        pos = row.get("position", 0)
        if isinstance(pos, int) and pos > max_position:
            max_position = pos

    next_position = max_position + 1
    to_insert: list[dict[str, object]] = []
    result = MergeResult()

    for item in incoming:
        name = item["name"]
        if not name or not name.strip():
            continue

        quantity = item.get("quantity")
        unit = item.get("unit")
        raw_note = item.get("note")
        note = (
            raw_note.strip()
            if isinstance(raw_note, str) and raw_note.strip()
            else None
        )
        key = _merge_key(name, unit, note)
        existing = existing_by_key.get(key)

        if existing is not None:
            # Attempt quantity merge
            parsed_existing = parse_quantity(existing.get("quantity"))
            parsed_incoming = parse_quantity(quantity)

            if parsed_existing is not None and parsed_incoming is not None:
                # Both parseable → sum and update
                summed = parsed_existing + parsed_incoming

                update_fields: dict[str, object] = {
                    "quantity": display_quantity(summed),
                }

                if source is not None:
                    new_sources = _append_source(existing.get("source_recipes"), source)
                    update_fields["source_recipes"] = new_sources

                try:
                    supabase.table("grocery_items").update(
                        update_fields
                    ).eq("id", existing["id"]).execute()
                except Exception as e:
                    raise StorageError(
                        f"Failed to update merged item: {type(e).__name__}: {str(e)[:100]}",
                        code="DB_UPDATE_FAILED",
                    )

                # Update local cache so subsequent merges against this key
                # use the summed quantity
                existing["quantity"] = display_quantity(summed)
                if source is not None:
                    existing["source_recipes"] = new_sources

                result.merged += 1
                continue

        # No merge — insert as new row
        new_sources = _append_source(None, source) if source is not None else None
        to_insert.append({
            "list_id": list_id,
            "recipe_id": recipe_id,
            "quantity": quantity,
            "unit": unit,
            "name": name,
            "checked": False,
            "position": next_position,
            "source_recipes": new_sources,
            "note": note,
        })
        next_position += 1
        result.inserted += 1

    if to_insert:
        try:
            supabase.table("grocery_items").insert(to_insert).execute()
        except Exception as e:
            raise StorageError(
                f"Failed to insert grocery items: {type(e).__name__}: {str(e)[:100]}",
                code="DB_INSERT_FAILED",
            )

    return result


def _add_recipe_to_list(
    list_id: str,
    recipe_id: str,
    recipe_title: str,
    *,
    supabase: Client,
) -> MergeResult:
    """
    Add all ingredients from a recipe to a grocery list, merging where possible.

    Returns MergeResult with inserted and merged counts.
    """
    try:
        ingredients = (
            supabase.table("recipe_ingredients")
            .select("*")
            .eq("recipe_id", recipe_id)
            .order("position")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to fetch ingredients: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not ingredients.data:
        return MergeResult()

    incoming = [
        {
            "name": ing["name"],
            "quantity": ing.get("quantity"),
            "unit": ing.get("unit"),
            "note": _note_from_prep(ing.get("prep")),
        }
        for ing in ingredients.data
    ]

    return _merge_items_into_list(
        list_id, recipe_id, recipe_title, incoming, supabase=supabase,
    )


def _add_override_items(
    list_id: str,
    recipe_id: str,
    recipe_title: str,
    items: list[RemakeItemInput],
    *,
    supabase: Client,
) -> MergeResult:
    """
    Add client-provided override items to a grocery list, merging where possible.

    Used when the mobile client sends pre-scaled ingredients.
    """
    valid_items = [item for item in items if item.name and item.name.strip()]

    if not valid_items:
        return MergeResult()

    incoming = [
        {
            "name": item.name,
            "quantity": item.quantity,
            "unit": item.unit,
            "note": item.note,
        }
        for item in valid_items
    ]

    return _merge_items_into_list(
        list_id, recipe_id, recipe_title, incoming, supabase=supabase,
    )


def _fetch_grocery_list_for_user(
    list_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict[str, object]:
    """Fetch a grocery list row, validating existence and ownership.

    Raises GroceryListNotFoundError if the list does not exist or is
    not owned by user_id.
    """
    try:
        result = (
            supabase.table("grocery_lists")
            .select("*")
            .eq("id", str(list_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery list not found: {list_id}",
                code="GROCERY_LIST_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not result.data:
        raise GroceryListNotFoundError(
            f"Grocery list not found: {list_id}",
            code="GROCERY_LIST_NOT_FOUND",
        )

    if result.data.get("user_id") != str(user_id):
        raise GroceryListForbiddenError(
            f"Grocery list not owned by user: {list_id}",
            code="GROCERY_LIST_NOT_OWNED",
        )

    return result.data


def add_manual_item(
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    name: str,
    quantity: str | None = None,
    unit: str | None = None,
    target_list_id: UUID | None = None,
) -> dict[str, object]:
    """
    Add a single manual item to a grocery list.

    When target_list_id is provided, the item is added to that specific list
    (validated for existence and ownership). When absent, the most recently
    updated incomplete list is used (or a new one is created).

    No recipe attribution is written (recipe_id=None, source_recipes=None).

    Returns dict with 'list', 'items_added', and 'items_merged'.
    """
    # Resolve target list
    if target_list_id is not None:
        grocery_list = _fetch_grocery_list_for_user(
            target_list_id,
            user_id=user_id,
            supabase=supabase,
        )
    else:
        grocery_list = get_or_create_active_list(
            user_id=user_id,
            supabase=supabase,
            logger=logger,
        )

    list_id = grocery_list["id"]

    incoming = [{"name": name, "quantity": quantity, "unit": unit}]

    merge = _merge_items_into_list(
        list_id, None, None, incoming, supabase=supabase,
    )

    logger.info(
        f"Manual add: {merge.inserted} inserted, {merge.merged} merged "
        f"into list {list_id}"
    )

    # Recompute list name (no-op for manual items — no new source recipes)
    _recompute_list_name(
        list_id,
        supabase=supabase,
        user_name=grocery_list.get("user_name"),
    )

    return {
        "list": grocery_list,
        "items_added": merge.total,
        "items_merged": merge.merged,
    }


def remake_recipe(
    recipe_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    override_items: list[RemakeItemInput] | None = None,
    target_list_id: UUID | None = None,
) -> dict[str, object]:
    """
    Add a recipe's ingredients to a grocery list.

    When target_list_id is provided, items are added to that specific list
    (validated for existence and ownership). When absent, the most recently
    updated incomplete list is used (or a new one is created).

    When override_items is provided, those are used instead of fetching
    from recipe_ingredients (supports client-side scaling).

    Returns dict with 'list', 'items_added', and 'items_merged'.
    """
    # Get recipe title
    try:
        recipe_result = (
            supabase.table("recipes")
            .select("title")
            .eq("id", str(recipe_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise RecipeNotFoundError(
                f"Recipe not found: {recipe_id}",
                code="RECIPE_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not recipe_result.data:
        raise RecipeNotFoundError(
            f"Recipe not found: {recipe_id}",
            code="RECIPE_NOT_FOUND",
        )

    recipe_title = recipe_result.data["title"]

    # Resolve target list
    if target_list_id is not None:
        grocery_list = _fetch_grocery_list_for_user(
            target_list_id,
            user_id=user_id,
            supabase=supabase,
        )
    else:
        grocery_list = get_or_create_active_list(
            user_id=user_id,
            supabase=supabase,
            logger=logger,
        )

    list_id = grocery_list["id"]

    # Add items (merge or insert)
    if override_items:
        merge = _add_override_items(
            list_id, str(recipe_id), recipe_title, override_items, supabase=supabase,
        )
        logger.info(f"Remake (scaled): {merge.inserted} inserted, {merge.merged} merged into list {list_id} from recipe {recipe_id}")
    else:
        merge = _add_recipe_to_list(
            list_id, str(recipe_id), recipe_title, supabase=supabase,
        )
        logger.info(f"Remake: {merge.inserted} inserted, {merge.merged} merged into list {list_id} from recipe {recipe_id}")

    # Recompute list name from all source recipes
    _recompute_list_name(
        list_id,
        supabase=supabase,
        user_name=grocery_list.get("user_name"),
    )

    return {
        "list": grocery_list,
        "items_added": merge.total,
        "items_merged": merge.merged,
    }


def get_grocery_list(
    list_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict[str, object]:
    """Get a grocery list with all its items. Verifies ownership."""
    try:
        grocery_list_result = (
            supabase.table("grocery_lists")
            .select("*")
            .eq("id", str(list_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery list not found or not owned by user: {list_id}",
                code="GROCERY_LIST_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not grocery_list_result.data:
        raise GroceryListNotFoundError(
            f"Grocery list not found or not owned by user: {list_id}",
            code="GROCERY_LIST_NOT_FOUND",
        )

    try:
        items_result = (
            supabase.table("grocery_items")
            .select("*, recipes(title)")
            .eq("list_id", str(list_id))
            .order("position")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error fetching items: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    return {
        "list": grocery_list_result.data,
        "items": items_result.data or [],
    }


def list_grocery_lists(
    *,
    user_id: UUID,
    supabase: Client,
    limit: int = 20,
) -> list[dict[str, object]]:
    """Get recent grocery lists for a user, most recently modified first."""
    try:
        result = (
            supabase.table("grocery_lists")
            .select("*")
            .eq("user_id", str(user_id))
            .order("updated_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as e:
        raise StorageError(
            f"Database error listing grocery lists: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )


def toggle_grocery_item(
    item_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    checked: bool,
) -> dict[str, object]:
    """Toggle the checked state of a grocery item. Verifies ownership via list."""
    # Verify ownership by joining through grocery_lists
    try:
        item_result = (
            supabase.table("grocery_items")
            .select("*, grocery_lists!inner(user_id)")
            .eq("id", str(item_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery item not found: {item_id}",
                code="GROCERY_ITEM_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not item_result.data:
        raise GroceryListNotFoundError(
            f"Grocery item not found: {item_id}",
            code="GROCERY_ITEM_NOT_FOUND",
        )

    # Verify ownership
    list_user_id = item_result.data.get("grocery_lists", {}).get("user_id")
    if list_user_id != str(user_id):
        raise GroceryListNotFoundError(
            f"Grocery item not found or not owned by user: {item_id}",
            code="GROCERY_ITEM_NOT_FOUND",
        )

    # Update the item
    try:
        update_result = (
            supabase.table("grocery_items")
            .update({"checked": checked})
            .eq("id", str(item_id))
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to update item: {type(e).__name__}: {str(e)[:100]}",
            code="DB_UPDATE_FAILED",
        )

    if not update_result.data:
        raise StorageError("Item update returned no data", code="DB_UPDATE_FAILED")

    logger.info(f"Toggled grocery item {item_id} to checked={checked}")
    return update_result.data[0]


def delete_grocery_item(
    item_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> str:
    """Delete a single grocery item. Verifies ownership via list.

    Returns the list_id so the caller can invalidate caches.
    """
    # Verify ownership by joining through grocery_lists
    try:
        item_result = (
            supabase.table("grocery_items")
            .select("*, grocery_lists!inner(user_id)")
            .eq("id", str(item_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery item not found: {item_id}",
                code="GROCERY_ITEM_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not item_result.data:
        raise GroceryListNotFoundError(
            f"Grocery item not found: {item_id}",
            code="GROCERY_ITEM_NOT_FOUND",
        )

    # Verify ownership — inner join guarantees grocery_lists exists
    list_user_id = item_result.data["grocery_lists"]["user_id"]
    if list_user_id != str(user_id):
        raise GroceryListNotFoundError(
            f"Grocery item not found or not owned by user: {item_id}",
            code="GROCERY_ITEM_NOT_FOUND",
        )

    list_id = item_result.data["list_id"]

    # Delete the item
    try:
        supabase.table("grocery_items").delete().eq("id", str(item_id)).execute()
    except Exception as e:
        raise StorageError(
            f"Failed to delete grocery item: {type(e).__name__}: {str(e)[:100]}",
            code="DB_DELETE_FAILED",
        )

    logger.info(f"Deleted grocery item {item_id} from list {list_id} (user={user_id})")
    return str(list_id)


def rename_grocery_list(
    list_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    new_name: str,
) -> dict[str, object]:
    """Rename a grocery list. Sets user_name, promoting auto-named lists to user-named.

    Verifies ownership. Returns the full updated row.
    """
    # Verify ownership
    try:
        list_result = (
            supabase.table("grocery_lists")
            .select("id")
            .eq("id", str(list_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery list not found or not owned by user: {list_id}",
                code="GROCERY_LIST_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not list_result.data:
        raise GroceryListNotFoundError(
            f"Grocery list not found or not owned by user: {list_id}",
            code="GROCERY_LIST_NOT_FOUND",
        )

    new_name = new_name.strip()
    if not new_name:
        raise ValueError("List name cannot be empty")

    # Set user_name (locks out auto-naming) and update name for display consistency
    try:
        update_result = (
            supabase.table("grocery_lists")
            .update({"user_name": new_name, "name": new_name})
            .eq("id", str(list_id))
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to rename grocery list: {type(e).__name__}: {str(e)[:100]}",
            code="DB_UPDATE_FAILED",
        )

    if not update_result.data:
        raise StorageError("Grocery list rename returned no data", code="DB_UPDATE_FAILED")

    logger.info(f"Renamed grocery list {list_id} to '{new_name}'")
    return update_result.data[0]


def delete_grocery_list(
    list_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> bool:
    """Delete a grocery list and all its items. Verifies ownership."""
    # Verify ownership
    try:
        list_result = (
            supabase.table("grocery_lists")
            .select("id")
            .eq("id", str(list_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise GroceryListNotFoundError(
                f"Grocery list not found or not owned by user: {list_id}",
                code="GROCERY_LIST_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not list_result.data:
        raise GroceryListNotFoundError(
            f"Grocery list not found or not owned by user: {list_id}",
            code="GROCERY_LIST_NOT_FOUND",
        )

    # Delete items first, then list
    try:
        supabase.table("grocery_items").delete().eq("list_id", str(list_id)).execute()
        supabase.table("grocery_lists").delete().eq("id", str(list_id)).execute()
    except Exception as e:
        raise StorageError(
            f"Failed to delete grocery list: {type(e).__name__}: {str(e)[:100]}",
            code="DB_DELETE_FAILED",
        )

    logger.info(f"Deleted grocery list: {list_id}")
    return True
