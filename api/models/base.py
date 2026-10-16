"""Shared base models for Tastelog API."""

from datetime import datetime, timezone

from pydantic import BaseModel, field_validator


def enforce_utc(v: datetime) -> datetime:
    """Validate that datetime is UTC (offset == 0), convert naive to UTC.
    
    PostgreSQL timestamp columns return naive datetimes. We assume they are UTC
    and convert them to timezone-aware datetimes.
    """
    if v.tzinfo is None:
        # Assume naive datetimes from PostgreSQL are UTC
        return v.replace(tzinfo=timezone.utc)
    offset = v.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise ValueError("timestamp must be UTC")
    return v


def enforce_utc_optional(v: datetime | None) -> datetime | None:
    """Validate that datetime is UTC if present."""
    if v is None:
        return v
    return enforce_utc(v)


class UTCTimestampModel(BaseModel):
    """Base model that enforces UTC timestamps on created_at/updated_at."""

    model_config = {"extra": "forbid"}

    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def _enforce_utc(cls, v: datetime) -> datetime:
        return enforce_utc(v)
