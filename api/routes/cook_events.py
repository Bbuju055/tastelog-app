"""
Tastelog: Cook event API routes (Phase 9.B).

Endpoints for logging, listing, and deleting cook events.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from supabase import Client

from api.core.cook_events import (
    create_cook_event,
    delete_cook_event,
    list_cook_events,
    list_recent_cooks,
)
from api.core.exceptions import CookEventNotFoundError, RecipeNotFoundError, StorageError
from api.dependencies import get_current_user_id, get_db
from api.models.cook_event import (
    CookEventCreateRequest,
    CookEventResponse,
    RecentCookResponse,
)

logger = logging.getLogger("tastelog.api.cook_events")

router = APIRouter(tags=["cook_events"])


@router.post(
    "/api/recipes/{recipe_id}/cook",
    response_model=CookEventResponse,
    status_code=201,
)
async def log_cook_event_endpoint(
    recipe_id: UUID,
    body: CookEventCreateRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> CookEventResponse:
    """Log a cook event for a recipe."""
    try:
        return create_cook_event(
            recipe_id,
            user_id,
            rating=body.rating,
            notes=body.notes,
            scale=body.scale,
            cooked_at=body.cooked_at,
            supabase=db,
        )
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except StorageError as e:
        logger.error("Cook event creation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to log cook event")


@router.get(
    "/api/recipes/{recipe_id}/cooks",
    response_model=list[CookEventResponse],
)
async def list_cook_events_endpoint(
    recipe_id: UUID,
    limit: int = Query(default=20, ge=1, le=100),
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[CookEventResponse]:
    """Return cook history for a recipe, ordered by cooked_at DESC."""
    try:
        return list_cook_events(recipe_id, user_id, limit=limit, supabase=db)
    except StorageError as e:
        logger.error("Cook event list failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load cook history")


@router.get(
    "/api/cooks/recent",
    response_model=list[RecentCookResponse],
)
async def recent_cooks_endpoint(
    limit: int = Query(default=5, ge=1, le=20),
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[RecentCookResponse]:
    """Return recently cooked recipes across all recipes (with recipe title)."""
    try:
        return list_recent_cooks(user_id, limit=limit, supabase=db)
    except StorageError as e:
        logger.error("Recent cooks failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load recent cooks")


@router.delete("/api/cooks/{cook_event_id}", status_code=204)
async def delete_cook_event_endpoint(
    cook_event_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> Response:
    """Delete a cook event. 404 if not found or not owned."""
    try:
        delete_cook_event(cook_event_id, user_id, supabase=db)
        return Response(status_code=204)
    except CookEventNotFoundError:
        raise HTTPException(status_code=404, detail=f"Cook event not found: {cook_event_id}")
    except StorageError as e:
        logger.error("Cook event delete failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete cook event")
