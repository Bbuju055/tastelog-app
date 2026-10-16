"""Idempotency handling for capture endpoint.

Postgres-backed idempotency to prevent duplicate uploads across instances.
All functions are synchronous (Supabase Python client is sync).

Idempotency is scoped by capture token (token_id), not user_id, because:
- Capture endpoint uses capture tokens, not Supabase JWTs
- Shortcuts/share extension don't have Supabase user context
- Per-token scoping aligns with rate limiting scope

Schema required:
    CREATE TABLE capture_idempotency_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_id UUID NOT NULL REFERENCES capture_tokens(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
        UNIQUE(token_id, idempotency_key)
    );
    CREATE INDEX idx_idempotency_token_key ON capture_idempotency_keys(token_id, idempotency_key);
    CREATE INDEX idx_idempotency_expires ON capture_idempotency_keys(expires_at);
"""

import hashlib
import logging
from typing import Any
from uuid import UUID

from supabase import Client

from api.core.exceptions import TastelogError

logger = logging.getLogger("tastelog.idempotency")


class IdempotencyError(TastelogError):
    """Base error for idempotency failures."""

    pass


class IdempotencyConflictError(IdempotencyError):
    """Same idempotency key with different payload."""

    pass


class IdempotencyServiceError(IdempotencyError):
    """Idempotency service unavailable."""

    pass


def hash_image_bytes(image_bytes: bytes) -> str:
    """Hash image bytes using SHA-256.

    This is the canonical payload hash for idempotency.
    Only image bytes are hashed - metadata like source/timestamp
    does not affect idempotency semantics.

    Returns hex digest for comparison.
    """
    return hashlib.sha256(image_bytes).hexdigest()


def check_idempotency(
    token_id: UUID,
    idempotency_key: str,
    payload_hash: str,
    *,
    supabase: Client,
) -> dict[str, Any] | None:
    """Check if this idempotency key has been used before for this token.

    DB enforces UNIQUE(token_id, idempotency_key) - at most one row expected.

    Returns:
        - Previous response JSON if key exists with matching payload
        - None if key doesn't exist (first request)

    Raises:
        IdempotencyConflictError: Key exists but payload differs (409)
        IdempotencyServiceError: DB error (fail-closed, 503)
    """
    try:
        result = (
            supabase.table("capture_idempotency_keys")
            .select("payload_hash,response_json")
            .eq("token_id", str(token_id))
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.error(f"Idempotency check failed: {type(e).__name__}")
        raise IdempotencyServiceError(
            "Idempotency service unavailable",
            code="IDEMPOTENCY_UNAVAILABLE",
        )

    if not result.data or len(result.data) == 0:
        # Key not found - first request
        return None

    row = result.data[0]
    stored_hash = row["payload_hash"]

    # Key exists - check if payload matches
    if stored_hash != payload_hash:
        logger.info("Idempotency conflict: same key, different payload")
        raise IdempotencyConflictError(
            "Idempotency key already used with different payload",
            code="IDEMPOTENCY_CONFLICT",
        )

    # Same key, same payload - return cached response
    logger.info("Idempotency hit: returning cached response")
    return row["response_json"]


def store_idempotency(
    token_id: UUID,
    idempotency_key: str,
    payload_hash: str,
    response_json: dict[str, Any],
    *,
    supabase: Client,
) -> None:
    """Store idempotency key with response for future lookups.

    The expires_at column defaults to 24 hours from now in the DB schema.
    DB enforces UNIQUE(token_id, idempotency_key).

    On unique constraint violation (concurrent insert with same key),
    we silently succeed - the first insert wins and subsequent requests
    will use check_idempotency to get the cached response.

    Raises:
        IdempotencyServiceError: DB error other than unique violation (fail-closed).
    """
    try:
        supabase.table("capture_idempotency_keys").insert({
            "token_id": str(token_id),
            "idempotency_key": idempotency_key,
            "payload_hash": payload_hash,
            "response_json": response_json,
        }).execute()
    except Exception as e:
        error_str = str(e).lower()
        # Unique constraint violation on (token_id, idempotency_key) is expected
        # under concurrent requests - the first insert wins, later ones are ok to ignore
        if "unique" in error_str or "duplicate" in error_str:
            logger.info("Idempotency store: concurrent insert (unique violation), ignoring")
            return
        logger.error(f"Failed to store idempotency: {type(e).__name__}")
        raise IdempotencyServiceError(
            "Idempotency service unavailable",
            code="IDEMPOTENCY_UNAVAILABLE",
        )
