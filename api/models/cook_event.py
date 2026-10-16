"""Cook event models for Tastelog API (Phase 9.B)."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from api.models.base import enforce_utc


class CookEventCreateRequest(BaseModel):
    """Request body for logging a cook event. All fields optional."""

    model_config = {"extra": "forbid"}

    rating: int | None = Field(default=None, ge=1, le=5)
    notes: str | None = Field(default=None)
    scale: str | None = Field(default=None)
    cooked_at: datetime | None = Field(default=None)


class CookEventResponse(BaseModel):
    """Single cook event. No updated_at — append-only table."""

    model_config = {"extra": "forbid"}

    id: UUID
    recipe_id: UUID
    user_id: UUID
    cooked_at: datetime
    rating: int | None = None
    notes: str | None = None
    scale: str | None = None
    created_at: datetime

    @field_validator("cooked_at", "created_at")
    @classmethod
    def _enforce_utc(cls, v: datetime) -> datetime:
        return enforce_utc(v)


class RecentCookResponse(BaseModel):
    """Lightweight cook event for home screen — includes recipe title."""

    model_config = {"extra": "forbid"}

    id: UUID
    recipe_id: UUID
    recipe_title: str
    cooked_at: datetime
    rating: int | None = None

    @field_validator("cooked_at")
    @classmethod
    def _enforce_utc(cls, v: datetime) -> datetime:
        return enforce_utc(v)
