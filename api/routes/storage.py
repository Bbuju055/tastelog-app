"""
Tastelog: Storage API routes.

Proxy endpoint for serving recipe images via signed URLs.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from supabase import Client

from api.dependencies import get_current_user_id, get_db

logger = logging.getLogger("tastelog.api.storage")

router = APIRouter(prefix="/api/storage", tags=["storage"])

BUCKET_RECIPE_IMAGES = "recipe-images"
SIGNED_URL_TTL_SECONDS = 3600


def _normalize_storage_path(path: str) -> str:
    """Validate and normalize storage path.

    Rejects traversal attempts, empty segments, and encoded markers.
    """
    if not path or path != path.strip():
        raise HTTPException(status_code=400, detail="Invalid path")
    if "\\" in path:
        raise HTTPException(status_code=400, detail="Invalid path")
    if path.startswith(("/", "./")):
        raise HTTPException(status_code=400, detail="Invalid path")

    parts = path.split("/")
    # reject empty segments, '.', '..'
    if any(p in ("", ".", "..") for p in parts):
        raise HTTPException(status_code=400, detail="Invalid path")

    # reject double-encoded traversal markers to be safe (%2e, %2f, etc.)
    lowered = path.lower()
    if "%2e" in lowered or "%2f" in lowered or "%5c" in lowered:
        raise HTTPException(status_code=400, detail="Invalid path")

    return path


def _extract_signed_url(resp: object) -> str | None:
    """
    Supabase python client has had multiple shapes across versions.
    Accept:
      - {"signedURL": "..."} / {"signed_url": "..."}
      - {"data": {"signedUrl": "..."}} / {"data": {"signedURL": "..."}}
      - {"data": {"signed_url": "..."}} etc.
    """
    if not isinstance(resp, dict):
        return None

    # Common direct keys
    direct = resp.get("signedURL") or resp.get("signed_url") or resp.get("signedUrl")
    if isinstance(direct, str) and direct:
        return direct

    data = resp.get("data")
    if isinstance(data, dict):
        nested = (
            data.get("signedURL")
            or data.get("signed_url")
            or data.get("signedUrl")
            or data.get("signedUrl".lower())  # defensive
        )
        if isinstance(nested, str) and nested:
            return nested

    return None


@router.get("/image/{path:path}")
async def get_image(
    path: str,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> RedirectResponse:
    """
    Proxy to Supabase Storage with signed URL.

    Security: only allows paths under user's own folder.
    Pattern: {user_id}/filename.jpg
    """
    path = _normalize_storage_path(path)

    user_prefix = f"{user_id}/"
    if not path.startswith(user_prefix):
        # 404 to avoid leaking existence patterns for cross-user paths.
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        resp = db.storage.from_(BUCKET_RECIPE_IMAGES).create_signed_url(
            path, expires_in=SIGNED_URL_TTL_SECONDS
        )
        signed_url = _extract_signed_url(resp)
        if not signed_url:
            # Unknown response shape = upstream issue, not "missing".
            logger.error(
                "Unexpected signed URL response shape",
                extra={"resp_type": type(resp).__name__},
            )
            raise HTTPException(status_code=502, detail="Storage unavailable")

        return RedirectResponse(url=signed_url, status_code=302)

    except HTTPException:
        raise
    except Exception as e:
        # Infra failure (storage API, auth, network): don't pretend it's missing.
        logger.exception("Failed to create signed URL", extra={"path": path})
        raise HTTPException(status_code=502, detail="Storage unavailable") from e
