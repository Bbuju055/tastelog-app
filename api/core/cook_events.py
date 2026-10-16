"""
Tastelog: Cook event business logic (Phase 9.B).

Pure functions with explicit dependencies — no global state.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from supabase import Client

from api.core.exceptions import CookEventNotFoundError, RecipeNotFoundError, StorageError
from api.models.base import enforce_utc
from api.models.cook_event import CookEventResponse, RecentCookResponse

logger = logging.getLogger("tastelog.api.cook_events")

# Allow 5 minutes of clock skew for "not in the future" validation
_FUTURE_TOLERANCE = timedelta(minutes=5)

# Columns to SELECT — explicit list avoids extra="forbid" failures
_COOK_EVENT_FIELDS = "id, recipe_id, user_id, cooked_at, rating, notes, scale, created_at"


def _normalize_nullable_string(value: str | None) -> str | None:
    """Trim whitespace; return None for empty/whitespace-only strings."""
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def create_cook_event(
    recipe_id: UUID,
    user_id: UUID,
    *,
    rating: int | None = None,
    notes: str | None = None,
    scale: str | None = None,
    cooked_at: datetime | None = None,
    supabase: Client,
) -> CookEventResponse:
    """Log a cook event for a recipe.

    Validates:
    - Recipe exists and belongs to user (404)
    - cooked_at is not in the future (400, with 5-min tolerance)
    - notes/scale trimmed, null if empty
    """
    # Verify recipe ownership
    try:
        result = (
            supabase.table("recipes")
            .select("id")
            .eq("id", str(recipe_id))
            .eq("user_id", str(user_id))
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

    # Normalize timezone before comparison
    effective_cooked_at = enforce_utc(cooked_at) if cooked_at else datetime.now(timezone.utc)
    now_utc = datetime.now(timezone.utc)
    if effective_cooked_at > now_utc + _FUTURE_TOLERANCE:
        raise ValueError("cooked_at must not be in the future")

    # Normalize text fields
    notes = _normalize_nullable_string(notes)
    scale = _normalize_nullable_string(scale)

    row = {
        "recipe_id": str(recipe_id),
        "user_id": str(user_id),
        "cooked_at": effective_cooked_at.isoformat(),
        "rating": rating,
        "notes": notes,
        "scale": scale,
    }

    try:
        result = (
            supabase.table("cook_events")
            .insert(row)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to create cook event: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    return CookEventResponse.model_validate(result.data[0])


def list_cook_events(
    recipe_id: UUID,
    user_id: UUID,
    *,
    limit: int = 20,
    supabase: Client,
) -> list[CookEventResponse]:
    """Return cook events for a recipe, ordered by cooked_at DESC."""
    try:
        result = (
            supabase.table("cook_events")
            .select(_COOK_EVENT_FIELDS)
            .eq("recipe_id", str(recipe_id))
            .eq("user_id", str(user_id))
            .order("cooked_at", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    return [CookEventResponse.model_validate(row) for row in (result.data or [])]


def list_recent_cooks(
    user_id: UUID,
    *,
    limit: int = 5,
    supabase: Client,
) -> list[RecentCookResponse]:
    """Return recent cook events across all recipes, with recipe titles.

    Two-step query: fetch cook events, then batch-fetch recipe titles.
    Avoids PostgREST FK join syntax which can fail if the schema cache
    hasn't refreshed after migration.
    """
    try:
        result = (
            supabase.table("cook_events")
            .select("id, recipe_id, cooked_at, rating")
            .eq("user_id", str(user_id))
            .order("cooked_at", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    rows = result.data or []
    if not rows:
        return []

    # Batch-fetch recipe titles
    recipe_ids = list({row["recipe_id"] for row in rows})
    try:
        recipes_result = (
            supabase.table("recipes")
            .select("id, title")
            .in_("id", recipe_ids)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error fetching recipe titles: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    title_map: dict[str, str] = {
        r["id"]: r["title"] for r in (recipes_result.data or [])
    }

    return [
        RecentCookResponse.model_validate(
            {
                "id": row["id"],
                "recipe_id": row["recipe_id"],
                "recipe_title": title_map.get(row["recipe_id"], "Untitled"),
                "cooked_at": row["cooked_at"],
                "rating": row.get("rating"),
            }
        )
        for row in rows
    ]


def delete_cook_event(
    cook_event_id: UUID,
    user_id: UUID,
    *,
    supabase: Client,
) -> None:
    """Delete a cook event. RLS ensures ownership. 404 if not found or not owned."""
    try:
        result = (
            supabase.table("cook_events")
            .delete()
            .eq("id", str(cook_event_id))
            .eq("user_id", str(user_id))
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to delete cook event: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not result.data:
        raise CookEventNotFoundError(
            f"Cook event not found: {cook_event_id}",
            code="COOK_EVENT_NOT_FOUND",
        )
