"""Common response models for Tastelog API."""

from typing import Literal

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    """Standard error response."""

    model_config = {"extra": "forbid"}

    detail: str = Field(min_length=1, description="Human-readable error message")
    code: str | None = Field(
        default=None, min_length=1, description="Machine-readable error code"
    )


class HealthResponse(BaseModel):
    """Health check response."""

    model_config = {"extra": "forbid"}

    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    """Schema-readiness response (migration drift guard, 15.2.4-CF-MD1).

    Public contract: stable codes, migration filenames, and safe remediation
    hints only. Diagnostics stay in server logs.
    """

    model_config = {"extra": "forbid"}

    status: Literal["ready", "skipped", "fail"]
    code: str = Field(min_length=1)
    migrations: list[str] | None = None
    hint: str | None = None
