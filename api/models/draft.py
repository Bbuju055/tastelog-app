"""Draft-related Pydantic models for Tastelog API."""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from api.models.base import UTCTimestampModel, enforce_utc


class IngredientData(BaseModel):
    """Ingredient data stored in draft JSONB (no ID - assigned during confirm)."""

    model_config = {"extra": "forbid"}

    quantity: str | None = Field(default=None, min_length=1)
    unit: str | None = Field(default=None, min_length=1)
    name: str = Field(min_length=1)
    prep: str | None = Field(default=None, min_length=1)
    raw_text: str | None = Field(default=None, min_length=1)


class StepData(BaseModel):
    """Step data stored in draft JSONB (no ID - assigned during confirm)."""

    model_config = {"extra": "forbid"}

    position: int = Field(ge=1)
    instruction: str = Field(min_length=1)


class DraftResponse(UTCTimestampModel):
    """Full draft for review."""

    id: UUID
    user_id: UUID
    image_storage_keys: list[str] = Field(default_factory=list)
    source_url: str | None = Field(default=None)
    title: str = Field(min_length=1)
    servings: str | None = Field(default=None, min_length=1)
    prep_time: str | None = Field(default=None, min_length=1)
    cook_time: str | None = Field(default=None, min_length=1)
    confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)
    ingredients: list[IngredientData] = Field(default_factory=list)
    steps: list[StepData] = Field(default_factory=list)
    raw_model_json: dict[str, Any] | None = None
    model_version: str = Field(min_length=1)
    parser_version: str = Field(min_length=1)
    expires_at: datetime

    @field_validator("expires_at")
    @classmethod
    def _enforce_utc_expires(cls, v: datetime) -> datetime:
        return enforce_utc(v)


class DraftConfirmRequest(BaseModel):
    """Optional overrides when confirming a draft."""

    model_config = {"extra": "forbid"}

    title: str | None = Field(default=None, min_length=1)
    servings: str | None = Field(default=None, min_length=1)
    prep_time: str | None = Field(default=None, min_length=1)
    cook_time: str | None = Field(default=None, min_length=1)
    ingredients: list[IngredientData] | None = None
    steps: list[StepData] | None = None
