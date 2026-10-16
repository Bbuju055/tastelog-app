"""Grocery list Pydantic models for Tastelog API."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from api.models.base import UTCTimestampModel, enforce_utc_optional


class GroceryItemResponse(BaseModel):
    """Single item in a grocery list."""

    model_config = {"extra": "forbid"}

    id: UUID
    list_id: UUID
    recipe_id: UUID | None = Field(default=None)
    position: int = Field(ge=1)
    quantity: str | None = Field(default=None, min_length=1)
    unit: str | None = Field(default=None, min_length=1)
    name: str = Field(min_length=1)
    checked: bool = Field(default=False)
    recipe_title: str | None = Field(
        default=None, min_length=1, description="Title of source recipe, if any"
    )
    source_recipes: list[dict[str, str]] | None = Field(
        default=None, description="Source recipes for this item [{id, title}, ...]"
    )
    note: str | None = Field(
        default=None,
        min_length=1,
        description="Substitution-provenance label carried from the recipe "
        "ingredient's prep field (e.g. 'in place of fish sauce')",
    )


class _GroceryListBase(UTCTimestampModel):
    """Base model for grocery list responses with completed_at validation."""

    id: UUID
    user_id: UUID
    name: str = Field(min_length=1)
    display_name: str = Field(
        min_length=1,
        description="Resolved display name: user_name if set, otherwise auto-computed name.",
    )
    completed_at: datetime | None = Field(default=None)

    @field_validator("completed_at")
    @classmethod
    def _completed_at_utc(cls, v: datetime | None) -> datetime | None:
        return enforce_utc_optional(v)


class GroceryListResponse(_GroceryListBase):
    """Grocery list summary (without items)."""

    pass


class GroceryListDetailResponse(_GroceryListBase):
    """Full grocery list with items."""

    items: list[GroceryItemResponse] = Field(default_factory=list)


class GroceryRemakeResponse(BaseModel):
    """Response for the remake endpoint — list detail plus merge statistics."""

    model_config = {"extra": "forbid"}

    list: GroceryListDetailResponse = Field(description="The updated grocery list with items")
    items_added: int = Field(ge=0, description="Total items processed (inserted + merged)")
    items_merged: int = Field(ge=0, description="Items merged with existing rows via quantity sum")


class RemakeItemInput(BaseModel):
    """Single override item for scaled grocery creation."""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1)
    quantity: str | None = Field(default=None)
    unit: str | None = Field(default=None)
    note: str | None = Field(
        default=None,
        description="Substitution-provenance label derived client-side from "
        "the ingredient's prep field (convention-matching preps only)",
    )


class RemakeRequest(BaseModel):
    """Request body for creating a grocery list from a recipe."""

    model_config = {"extra": "forbid"}

    recipe_id: UUID = Field(description="ID of recipe to remake")
    items: list[RemakeItemInput] | None = Field(
        default=None,
        description="Override items from client-side scaling. When present, these are inserted instead of fetching from recipe_ingredients.",
    )
    list_id: UUID | None = Field(
        default=None,
        description="Explicit target list. When present, items are added to this list. When absent, backend auto-resolves active list or creates new.",
    )


class CreateGroceryListRequest(BaseModel):
    """Request body for creating a grocery list directly."""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=200, description="List name")


class RenameGroceryListRequest(BaseModel):
    """Request body for renaming a grocery list."""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=200, description="New list name")


class ToggleItemRequest(BaseModel):
    """Request body for toggling item checked status."""

    model_config = {"extra": "forbid"}

    checked: bool = Field(description="New checked status")


class AddManualItemRequest(BaseModel):
    """Request body for adding a manual item to a grocery list."""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=200, description="Item name")
    quantity: str | None = Field(default=None, description="Optional quantity")
    unit: str | None = Field(default=None, description="Optional unit")
    list_id: UUID | None = Field(
        default=None,
        description="Explicit target list. When absent, backend auto-resolves active list or creates new.",
    )
