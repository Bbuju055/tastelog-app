"""Idempotency for the draft capture routes, scoped by user.

Backed by migration 028 (``draft_capture_idempotency`` + three RPCs). Unlike
``api.core.idempotency`` (capture-token scoped, check-then-store), a key is
claimed atomically: ``reserve`` inserts first, so two concurrent requests
with the same key cannot both do the capture.

Protocol for a route (the caller mints the draft id first; the reservation
stores it, so a retry can recover the exact draft of a holder that never
completed, and complete/release only ever act on the caller's own row):
    draft_id = uuid4()
    r = reserve_draft_capture(..., draft_id)
    if r.outcome == "replay":  return r.response          # recorded response
    if r.outcome == "recover": return load draft r.draft_id
    try:
        response = do the capture, creating the draft under draft_id
    except BaseException:
        release_draft_capture(..., draft_id)             # retry may claim the key
        raise
    complete_draft_capture(..., draft_id, response)      # record for replays

All functions are synchronous (Supabase Python client is sync).
"""

import hashlib
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from supabase import Client

from api.core.idempotency import (
    IdempotencyConflictError,
    IdempotencyError,
    IdempotencyServiceError,
)

logger = logging.getLogger("tastelog.draft_idempotency")

_OUTCOME_RESERVED = "reserved"
_OUTCOME_REPLAY = "replay"
_OUTCOME_RECOVER = "recover"
_OUTCOME_IN_PROGRESS = "in_progress"
_OUTCOME_MISMATCH = "mismatch"


@dataclass(frozen=True)
class Reservation:
    """Result of reserve_draft_capture.

    reserved: this request owns the key; do the work under its draft id.
    replay:   ``response`` is the recorded response of a finished capture.
    recover:  the holder wrote draft ``draft_id`` but never completed;
              return that draft instead of capturing again.
    """

    outcome: Literal["reserved", "replay", "recover"]
    response: dict[str, Any] | None = None
    draft_id: UUID | None = None


class IdempotencyInProgressError(IdempotencyError):
    """Same key is held by a request that has not finished yet."""

    pass


class InvalidIdempotencyKeyError(IdempotencyError):
    """Header present but unusable (empty or contains whitespace)."""

    pass


def clean_idempotency_key(raw: str) -> str:
    """Strip and validate a client-supplied key (same rule as the token route)."""
    key = raw.strip()
    if not key or any(c in key for c in (" ", "\n", "\r", "\t")):
        raise InvalidIdempotencyKeyError(
            "Invalid Idempotency-Key: must be non-empty with no whitespace",
            code="IDEMPOTENCY_KEY_INVALID",
        )
    return key


def hash_capture_payload(parts: Iterable[bytes]) -> str:
    """SHA-256 over length-prefixed parts.

    Length prefixes make the identity depend on the part boundaries, so
    (b"ab", b"c") and (b"a", b"bc") differ and an empty trailing part counts.
    Callers pass every uploaded file's bytes in order, then the URL (or an
    empty part when there is none).
    """
    digest = hashlib.sha256()
    for part in parts:
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()


def _rpc(name: str, params: dict[str, Any], *, supabase: Client) -> Any:
    try:
        return supabase.rpc(name, params).execute().data
    except Exception as e:
        logger.error(f"{name} failed: {type(e).__name__}")
        raise IdempotencyServiceError(
            "Idempotency service unavailable",
            code="IDEMPOTENCY_UNAVAILABLE",
        )


def _malformed(what: str) -> IdempotencyServiceError:
    logger.error(f"reserve_draft_capture: {what}")
    return IdempotencyServiceError(
        "Idempotency service unavailable",
        code="IDEMPOTENCY_UNAVAILABLE",
    )


def reserve_draft_capture(
    user_id: UUID,
    idempotency_key: str,
    payload_hash: str,
    draft_id: UUID,
    *,
    supabase: Client,
) -> Reservation:
    """Claim the key for this request under ``draft_id``, or learn what to return.

    Raises:
        IdempotencyInProgressError: another request holds the key (409).
        IdempotencyConflictError: key reused with a different payload (409).
        IdempotencyServiceError: DB error or malformed reply (fail-closed, 503).
    """
    data = _rpc(
        "reserve_draft_capture",
        {
            "p_user_id": str(user_id),
            "p_idempotency_key": idempotency_key,
            "p_payload_hash": payload_hash,
            "p_draft_id": str(draft_id),
        },
        supabase=supabase,
    )
    outcome = data.get("outcome") if isinstance(data, dict) else None

    if outcome == _OUTCOME_RESERVED:
        return Reservation("reserved")
    if outcome == _OUTCOME_REPLAY:
        response = data.get("response")
        if not isinstance(response, dict):
            raise _malformed("replay without a response object")
        logger.info("Draft idempotency hit: returning recorded response")
        return Reservation("replay", response=response)
    if outcome == _OUTCOME_RECOVER:
        try:
            recovered = UUID(str(data.get("draft_id")))
        except ValueError:
            raise _malformed("recover without a draft id")
        logger.info("Draft idempotency recover: holder's draft exists, completion was lost")
        return Reservation("recover", draft_id=recovered)
    if outcome == _OUTCOME_IN_PROGRESS:
        raise IdempotencyInProgressError(
            "A request with this Idempotency-Key is still in progress",
            code="IDEMPOTENCY_IN_PROGRESS",
        )
    if outcome == _OUTCOME_MISMATCH:
        logger.info("Draft idempotency conflict: same key, different payload")
        raise IdempotencyConflictError(
            "Idempotency key already used with different payload",
            code="IDEMPOTENCY_CONFLICT",
        )

    raise _malformed(f"unexpected outcome {outcome!r}")


def complete_draft_capture(
    user_id: UUID,
    idempotency_key: str,
    draft_id: UUID,
    response_json: dict[str, Any],
    *,
    supabase: Client,
) -> bool:
    """Record the response for the reservation this request owns (by draft id).

    Returns True when the pending row was completed, False when no pending
    row with this draft id exists (expired meanwhile, or not ours).

    Raises:
        IdempotencyServiceError: DB error.
    """
    data = _rpc(
        "complete_draft_capture",
        {
            "p_user_id": str(user_id),
            "p_idempotency_key": idempotency_key,
            "p_draft_id": str(draft_id),
            "p_response": response_json,
        },
        supabase=supabase,
    )
    return data is True


def release_draft_capture(
    user_id: UUID,
    idempotency_key: str,
    draft_id: UUID,
    *,
    supabase: Client,
) -> bool:
    """Drop the pending reservation this request owns (by draft id) after a
    failed capture, so the client's retry can claim the key again.

    Returns True when a pending row was removed. Done rows and other
    owners' rows are never removed.

    Raises:
        IdempotencyServiceError: DB error.
    """
    data = _rpc(
        "release_draft_capture",
        {
            "p_user_id": str(user_id),
            "p_idempotency_key": idempotency_key,
            "p_draft_id": str(draft_id),
        },
        supabase=supabase,
    )
    return data is True
