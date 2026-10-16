"""Capture token authentication and rate limiting.

Handles token verification, SHA-256 hashing, and Postgres-backed rate limiting.
All functions are synchronous (Supabase Python client is sync).
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from supabase import Client

from api.core.exceptions import TastelogError
from api.models.capture_token import CaptureTokenDB

logger = logging.getLogger("tastelog.token_auth")

# Token format: tl_cap_ + 32 bytes URL-safe base64 (~43 chars)
TOKEN_PREFIX = "tl_cap_"
TOKEN_BYTES = 32
TOKEN_MIN_LENGTH = 20
TOKEN_MAX_LENGTH = 200

# Rate limiting: requests per window
RATE_LIMIT_MAX_REQUESTS = 60
RATE_LIMIT_WINDOW_MINUTES = 60


class TokenAuthError(TastelogError):
    """Base error for token authentication failures."""

    pass


class InvalidTokenError(TokenAuthError):
    """Token is invalid, revoked, or expired."""

    pass


class RateLimitExceededError(TokenAuthError):
    """Token has exceeded rate limit."""

    pass


class RateLimitUnavailableError(TokenAuthError):
    """Rate limit check failed due to infrastructure error."""

    pass


def generate_token() -> str:
    """Generate a new capture token.

    Format: tl_cap_ + 32 bytes of cryptographically secure random data (URL-safe base64).
    Returns the plaintext token (store only the hash).
    """
    random_bytes = secrets.token_urlsafe(TOKEN_BYTES)
    return f"{TOKEN_PREFIX}{random_bytes}"


def hash_token(token: str) -> str:
    """Hash a token using SHA-256.

    Returns hex digest for storage.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def parse_bearer_token(authorization: str | None) -> str | None:
    """Extract and validate capture token from Authorization header.

    Returns None if header is missing, malformed, or token is invalid format.
    Validates:
    - Bearer prefix
    - Token prefix (tl_cap_)
    - Length bounds (20-200 chars)
    - No embedded whitespace
    """
    if not authorization:
        return None

    if not authorization.startswith("Bearer "):
        return None

    token = authorization[7:].strip()

    if not token:
        return None

    # Reject embedded whitespace (prevents header folding tricks)
    if " " in token or "\n" in token or "\t" in token:
        logger.debug("Token rejected: contains embedded whitespace")
        return None

    if not token.startswith(TOKEN_PREFIX):
        return None

    if len(token) < TOKEN_MIN_LENGTH or len(token) > TOKEN_MAX_LENGTH:
        logger.debug("Token rejected: invalid length")
        return None

    return token


def verify_capture_token(
    token: str,
    *,
    supabase: Client,
) -> CaptureTokenDB:
    """Verify a capture token and return the token record.

    Checks:
    - Token hash exists in database
    - Token is not revoked
    - Token is not expired
    - Scope is 'capture'

    Raises:
        InvalidTokenError: Token is invalid, revoked, or expired.

    Returns:
        CaptureTokenDB: The validated token record.
    """
    token_hash = hash_token(token)

    try:
        result = (
            supabase.table("capture_tokens")
            .select("*")
            .eq("token_hash", token_hash)
            .is_("revoked_at", "null")
            .execute()
        )
    except Exception as e:
        logger.error(f"Token verification DB error: {type(e).__name__}")
        raise InvalidTokenError("Token verification failed", code="TOKEN_DB_ERROR")

    # Handle empty result explicitly (no .single())
    if not result.data or len(result.data) == 0:
        logger.info("Token verification failed: not found or revoked")
        raise InvalidTokenError("Invalid token", code="TOKEN_INVALID")

    # Take first match (hash is unique, so should only be one)
    token_record = CaptureTokenDB.from_db_row(result.data[0])

    # Check expiration
    if token_record.expires_at is not None:
        now = datetime.now(timezone.utc)
        if token_record.expires_at <= now:
            logger.info("Token verification failed: expired")
            raise InvalidTokenError("Token expired", code="TOKEN_EXPIRED")

    # Check scope
    if token_record.scope != "capture":
        logger.info("Token verification failed: invalid scope")
        raise InvalidTokenError("Invalid token scope", code="TOKEN_INVALID_SCOPE")

    return token_record


def check_and_record_rate_limit(
    token_hash: str,
    *,
    supabase: Client,
    max_requests: int = RATE_LIMIT_MAX_REQUESTS,
    window_minutes: int = RATE_LIMIT_WINDOW_MINUTES,
) -> None:
    """Check rate limit and record request. FAIL-CLOSED on errors.

    Uses Postgres for persistent, multi-instance consistent rate limiting.
    Sliding window: count requests in last N minutes from capture_rate_limits table.

    Semantics: if count >= max_requests already recorded in window, block.
    Otherwise, record this request and proceed.

    NOTE: This is not fully atomic. Under high concurrency, there's a small window
    where two requests could both pass the check before either records. This is
    acceptable for MVP given generous limits (60/hour). For stricter enforcement,
    replace with a single atomic RPC function.

    Schema required:
        CREATE TABLE capture_rate_limits (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            token_hash TEXT NOT NULL,
            request_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_rate_limits_token_time ON capture_rate_limits(token_hash, request_at DESC);

    Raises:
        RateLimitExceededError: Token has exceeded rate limit.
        RateLimitUnavailableError: DB error (fail-closed, maps to 503).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)

    try:
        # Bounded select: fetch at most max_requests rows
        # If we get max_requests rows, limit is reached
        result = (
            supabase.table("capture_rate_limits")
            .select("id")
            .eq("token_hash", token_hash)
            .gte("request_at", cutoff.isoformat())
            .limit(max_requests)
            .execute()
        )

        count = len(result.data) if result.data else 0

        if count >= max_requests:
            logger.info(f"Rate limit exceeded: {count}>={max_requests} in {window_minutes}m")
            raise RateLimitExceededError(
                f"Rate limit exceeded. Maximum {max_requests} requests per {window_minutes} minutes.",
                code="RATE_LIMIT_EXCEEDED",
            )

        # Record this request
        supabase.table("capture_rate_limits").insert(
            {"token_hash": token_hash}
        ).execute()

    except RateLimitExceededError:
        raise
    except Exception as e:
        # FAIL-CLOSED: DB failure blocks the request (maps to 503 in route)
        logger.error(f"Rate limit check/record failed: {type(e).__name__}")
        raise RateLimitUnavailableError(
            "Rate limit service unavailable. Please retry.",
            code="RATE_LIMIT_UNAVAILABLE",
        )


def update_last_used(
    token_id: UUID,
    *,
    supabase: Client,
) -> None:
    """Update last_used_at timestamp for a token.

    BEST-EFFORT: failures are logged but do not block the request.
    This is acceptable because last_used_at is informational, not security-critical.
    """
    try:
        supabase.table("capture_tokens").update(
            {"last_used_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", str(token_id)).execute()
    except Exception as e:
        logger.error(f"Failed to update last_used_at: {type(e).__name__}")
