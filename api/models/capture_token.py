"""Capture token Pydantic models for Tastelog API."""

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from api.models.base import enforce_utc, enforce_utc_optional


class CaptureTokenBase(BaseModel):
    """Base fields for capture tokens."""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("name cannot be empty or whitespace")
        return normalized


class CaptureTokenCreate(CaptureTokenBase):
    """Request body for creating a capture token."""

    expires_at: datetime | None = Field(
        default=None,
        description="Optional expiration time (UTC). Token never expires if omitted.",
    )

    @field_validator("expires_at")
    @classmethod
    def _validate_expires_at(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        v = enforce_utc_optional(v)
        if v is not None and v <= datetime.now(timezone.utc):
            raise ValueError("expires_at must be in the future")
        return v


class CaptureTokenResponse(CaptureTokenBase):
    """Capture token metadata (no secret)."""

    id: UUID
    user_id: UUID
    scope: Literal["capture"] = "capture"
    created_at: datetime
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None

    @field_validator("created_at")
    @classmethod
    def _enforce_utc_created(cls, v: datetime) -> datetime:
        return enforce_utc(v)

    @field_validator("expires_at", "revoked_at", "last_used_at")
    @classmethod
    def _enforce_utc_optional_fields(cls, v: datetime | None) -> datetime | None:
        return enforce_utc_optional(v)


class CaptureTokenCreated(CaptureTokenResponse):
    """Response when creating a token - includes the secret (shown once)."""

    token: str = Field(
        min_length=20,
        max_length=200,
        description="The capture token. Store securely - this is shown only once.",
    )


class CaptureTokenDB(BaseModel):
    """Internal representation of a capture token row from database.

    Includes token_hash for verification. Never expose in API responses.
    """

    model_config = {"extra": "forbid"}

    id: UUID
    user_id: UUID
    token_hash: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=100)
    scope: Literal["capture"] = "capture"
    created_at: datetime
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None

    @field_validator("created_at")
    @classmethod
    def _enforce_utc_created(cls, v: datetime) -> datetime:
        return enforce_utc(v)

    @field_validator("expires_at", "revoked_at", "last_used_at")
    @classmethod
    def _enforce_utc_optional_fields(cls, v: datetime | None) -> datetime | None:
        return enforce_utc_optional(v)

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "CaptureTokenDB":
        """Create from database row with full validation."""
        return cls.model_validate(row)

    def to_response(self) -> CaptureTokenResponse:
        """Convert to API response (strips token_hash, re-validates)."""
        return CaptureTokenResponse.model_validate(
            self.model_dump(exclude={"token_hash"})
        )
