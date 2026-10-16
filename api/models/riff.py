"""Riff mode models for Tastelog API (Phase 13.1 + 13.2)."""

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class RiffMessageRequest(BaseModel):
    """Request body for one riff conversational turn.

    13.1 scope: send one user message. Server persists it, calls Claude,
    persists the assistant reply, returns the reply text.
    """

    model_config = {"extra": "forbid"}

    session_id: UUID | None = None
    message: str = Field(min_length=1, max_length=2000)
    # Phase 13.7. Optional entry-point label for telemetry on the
    # session-create path. Server defaults to "recipe_detail" when
    # omitted. No enum / no allow-list — keeps cross-screen tickets
    # unblocked. Whitespace-only values are coerced to None at the
    # boundary by the validator below.
    entry_point: str | None = Field(default=None, max_length=64)

    @field_validator("message", mode="after")
    @classmethod
    def _require_non_whitespace(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("message must not be empty or whitespace-only")
        return stripped

    @field_validator("entry_point", mode="after")
    @classmethod
    def _trim_entry_point_or_null(cls, v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        return stripped if stripped else None


class RiffTurnResponse(BaseModel):
    """Single assistant reply.

    13.2 additive change: `assistant_message_id` and `generated_recipe` are
    added alongside the unchanged 13.1 fields, preserving backward
    compatibility for existing clients that read only `session_id` and
    `assistant_message`.
    """

    model_config = {"extra": "forbid"}

    session_id: UUID
    assistant_message: str
    assistant_message_id: UUID
    generated_recipe: dict[str, Any] | None = None


class RiffSaveRequest(BaseModel):
    """Request body for saving a riff-generated recipe to the cookbook (13.2).

    Persists the validated recipe extracted from a specific assistant
    message, with lineage fields wired through to the new `recipes` row
    (parent_recipe_id, riff_session_id, riff_label).
    """

    model_config = {"extra": "forbid"}

    session_id: UUID
    message_id: UUID
    riff_label: str | None = Field(default=None, max_length=80)

    @field_validator("riff_label", mode="after")
    @classmethod
    def _trim_or_null(cls, v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        return stripped if stripped else None


class RiffSaveResponse(BaseModel):
    """Returned from POST /api/recipes/{recipe_id}/riff/save."""

    model_config = {"extra": "forbid"}

    recipe_id: UUID
