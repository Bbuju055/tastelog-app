"""Capture response model for Tastelog API.

Locked response shape for the capture endpoint.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CaptureResponse(BaseModel):
    """Locked response shape for POST /api/recipes/capture.

    This contract is stable across all clients (web, mobile, shortcuts, extension).
    """

    model_config = {"extra": "forbid"}

    capture_id: UUID = Field(description="Unique ID for this capture request")
    recipe_id: UUID | None = Field(
        description="Recipe ID if parsing completed, null if still processing"
    )
    status: Literal["queued", "processing", "complete", "failed"] = Field(
        description="Current processing status"
    )
    view_url: str = Field(
        min_length=1,
        description="URL to view the recipe or review the draft"
    )
