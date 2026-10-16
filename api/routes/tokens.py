"""
Tastelog: Capture token management API routes.

Endpoints for creating, listing, and revoking capture tokens.
"""

import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from supabase import Client

from api.core.token_auth import generate_token, hash_token
from api.dependencies import get_current_user_id, get_user_db
from api.models.capture_token import (
    CaptureTokenCreate,
    CaptureTokenCreated,
    CaptureTokenDB,
    CaptureTokenResponse,
)

logger = logging.getLogger("tastelog.api.tokens")

router = APIRouter(prefix="/api/tokens", tags=["tokens"])

# Columns to select for token responses (never include token_hash)
TOKEN_RESPONSE_COLUMNS = (
    "id,user_id,name,scope,created_at,expires_at,revoked_at,last_used_at"
)


@router.post("", response_model=CaptureTokenCreated, status_code=201)
async def create_token(
    body: CaptureTokenCreate,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_user_db),
) -> CaptureTokenCreated:
    """Create (or rotate) a capture token.

    Returns the plaintext token ONCE. Store it securely — it cannot be retrieved again.

    Lifecycle invariants:
    ─────────────────────
    1. SINGLETON: Exactly one row per (user_id, name). Enforced by UNIQUE constraint
       on capture_tokens(user_id, name). The mobile client uses name="Mobile (auto)".
    2. ROTATION: If a row already exists for (user_id, name), the token_hash is
       replaced with a freshly generated value and revoked_at is cleared to NULL.
       This means re-provisioning always recovers a revoked token — no separate
       reactivation endpoint is needed.
    3. RECOVERY: A revoked row is indistinguishable from an active row during
       rotation — both paths produce an active token with a new hash. The client
       can safely call this endpoint on every sign-in without checking server state.
    """
    # Check for existing token with this (user_id, name)
    try:
        existing = (
            db.table("capture_tokens")
            .select(TOKEN_RESPONSE_COLUMNS)
            .eq("user_id", str(user_id))
            .eq("name", body.name)
            .maybe_single()
            .execute()
        )
    except Exception as e:
        logger.exception(f"Failed to check existing token: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail="Failed to create token")

    # Generate new plaintext + hash
    plaintext_token = generate_token()
    new_hash = hash_token(plaintext_token)

    if existing.data:
        # Rotate: update existing row with new hash
        row = existing.data
        try:
            db.table("capture_tokens").update(
                {"token_hash": new_hash, "revoked_at": None}
            ).eq("id", row["id"]).eq("user_id", str(user_id)).execute()
        except Exception as e:
            logger.exception(f"Failed to rotate token: {type(e).__name__}: {e}")
            raise HTTPException(status_code=500, detail="Failed to create token")

        logger.info(f"Rotated existing auto token for user {user_id}")
        return CaptureTokenCreated(
            id=row["id"],
            user_id=row["user_id"],
            name=row["name"],
            scope=row["scope"],
            created_at=row["created_at"],
            expires_at=row.get("expires_at"),
            revoked_at=row.get("revoked_at"),
            last_used_at=row.get("last_used_at"),
            token=plaintext_token,
        )

    # No existing row — insert new
    row_data = {
        "user_id": str(user_id),
        "token_hash": new_hash,
        "name": body.name,
        "scope": "capture",
    }

    if body.expires_at is not None:
        row_data["expires_at"] = body.expires_at.isoformat()

    try:
        db.table("capture_tokens").insert(row_data).execute()

        result = (
            db.table("capture_tokens")
            .select(TOKEN_RESPONSE_COLUMNS)
            .eq("token_hash", new_hash)
            .execute()
        )
    except Exception as e:
        error_str = str(e).lower()
        if "unique" in error_str or "duplicate" in error_str:
            logger.error(
                f"Unique constraint violation on token insert: {type(e).__name__}: {e}"
            )
        else:
            logger.exception(f"Failed to insert token: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail="Failed to create token")

    if not result.data or len(result.data) == 0:
        logger.error("Token insert returned no data")
        raise HTTPException(status_code=500, detail="Failed to create token")

    row = result.data[0]
    return CaptureTokenCreated(
        id=row["id"],
        user_id=row["user_id"],
        name=row["name"],
        scope=row["scope"],
        created_at=row["created_at"],
        expires_at=row.get("expires_at"),
        revoked_at=row.get("revoked_at"),
        last_used_at=row.get("last_used_at"),
        token=plaintext_token,
    )


@router.get("", response_model=list[CaptureTokenResponse])
async def list_tokens(
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_user_db),
) -> list[CaptureTokenResponse]:
    """List all capture tokens for the current user.

    Returns metadata only - token secrets are never returned after creation.
    """
    try:
        result = (
            db.table("capture_tokens")
            .select(TOKEN_RESPONSE_COLUMNS)
            .eq("user_id", str(user_id))
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as e:
        logger.error(f"Failed to list tokens: {type(e).__name__}")
        raise HTTPException(status_code=500, detail="Failed to list tokens")

    if not result.data:
        return []

    return [
        CaptureTokenResponse.model_validate(row)
        for row in result.data
    ]


@router.delete("/{token_id}", status_code=204, response_class=Response)
async def revoke_token(
    token_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_user_db),
) -> Response:
    """Revoke a capture token (soft-delete).

    Sets revoked_at timestamp. Idempotent — revoking an already-revoked token
    returns 204 without error.

    Note: re-provisioning via create_token() with the same (user_id, name)
    rotates the token hash and clears revoked_at. This is intentional and allows
    the mobile auto-token lifecycle to self-heal on sign-in.
    """
    try:
        # Filter by both id AND user_id server-side (no separate ownership check needed)
        result = (
            db.table("capture_tokens")
            .select("id,revoked_at")
            .eq("id", str(token_id))
            .eq("user_id", str(user_id))
            .execute()
        )
    except Exception as e:
        logger.error(f"Failed to fetch token for revocation: {type(e).__name__}")
        raise HTTPException(status_code=500, detail="Failed to revoke token")

    if not result.data or len(result.data) == 0:
        raise HTTPException(status_code=404, detail="Token not found")

    token_row = result.data[0]

    # Check if already revoked - idempotent success
    if token_row.get("revoked_at") is not None:
        return Response(status_code=204)

    # Revoke the token
    try:
        db.table("capture_tokens").update(
            {"revoked_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", str(token_id)).eq("user_id", str(user_id)).execute()
    except Exception as e:
        logger.error(f"Failed to revoke token: {type(e).__name__}")
        raise HTTPException(status_code=500, detail="Failed to revoke token")

    return Response(status_code=204)
