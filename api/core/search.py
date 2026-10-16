"""
Tastelog: Recipe search operations.

Pure functions with explicit dependencies - no global state.
"""

from __future__ import annotations

import logging
from uuid import UUID

from supabase import Client

from api.core.exceptions import StorageError
from api.core.recipes import get_tags_for_recipes


def search_recipes_fts(
    query: str,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    limit: int = 10,
) -> list[dict[str, object]]:
    """
    Search recipes using PostgreSQL full-text search.

    Uses the search_recipes_fts RPC function which searches
    title (weight A) and ingredients (weight B).

    Returns empty list if RPC function not available.
    """
    try:
        result = supabase.rpc(
            "search_recipes_fts",
            {
                "search_query": query,
                "user_id_filter": str(user_id),
                "result_limit": limit,
            },
        ).execute()
        return _attach_tags(result.data or [], supabase=supabase)
    except Exception as e:
        # RPC function may not exist yet - log and return empty
        logger.warning(f"FTS search failed (function may not exist): {e}")
        return []


def search_recipes_simple(
    query: str,
    *,
    user_id: UUID,
    supabase: Client,
    limit: int = 10,
) -> list[dict[str, object]]:
    """
    Fallback: Simple ILIKE search on title.

    Less sophisticated but works for partial matches when FTS unavailable.
    """
    try:
        result = (
            supabase.table("recipes")
            .select("id, title, source_url, servings, prep_time, cook_time, confidence_score, favorite, created_at, updated_at, parent_recipe_id, riff_session_id, riff_label")
            .eq("user_id", str(user_id))
            .ilike("title", f"%{query}%")
            .limit(limit)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error during search: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )
    return _attach_tags(result.data or [], supabase=supabase)


def search_recipes(
    query: str,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
    limit: int = 10,
) -> list[dict[str, object]]:
    """
    Smart search: try full-text first, fall back to ILIKE if no results.

    This is the primary search interface for the API.
    """
    # Try FTS first
    results = search_recipes_fts(
        query,
        user_id=user_id,
        supabase=supabase,
        logger=logger,
        limit=limit,
    )

    # Fall back to simple search if FTS returns nothing
    if not results:
        results = search_recipes_simple(
            query,
            user_id=user_id,
            supabase=supabase,
            limit=limit,
        )

    return results


def _attach_tags(
    recipes: list[dict[str, object]],
    *,
    supabase: Client,
) -> list[dict[str, object]]:
    """Batch-fetch tags and attach to each recipe dict."""
    if not recipes:
        return recipes
    recipe_ids = [str(r["id"]) for r in recipes]
    tags_by_id = get_tags_for_recipes(recipe_ids, supabase=supabase)
    for recipe in recipes:
        recipe["tags"] = tags_by_id.get(str(recipe["id"]), [])
    return recipes


def list_recipes(
    *,
    user_id: UUID,
    supabase: Client,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, object]]:
    """
    List all recipes for a user, ordered by creation date (newest first).
    """
    try:
        result = (
            supabase.table("recipes")
            .select("id, title, source_url, servings, prep_time, cook_time, confidence_score, favorite, created_at, updated_at, parent_recipe_id, riff_session_id, riff_label")
            .eq("user_id", str(user_id))
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error listing recipes: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )
    return _attach_tags(result.data or [], supabase=supabase)
