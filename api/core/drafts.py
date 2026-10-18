"""
Tastelog: Draft recipe database operations.

Pure DB operations - no storage I/O, no parsing.
Upload/parse handled at route layer.

Note: create/get/delete use service client with manual ownership checks
(matching recipes.py pattern). confirm_draft requires user-scoped client
for RPC auth.uid() to work.

NOTE: We intentionally use the service-role Supabase client for draft CRUD.
Ownership is enforced by API filters (user_id). RLS is not relied on here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from supabase import Client

from api.core.exceptions import DraftNotFoundError, DraftExpiredError, StorageError


def list_drafts(
    *,
    user_id: UUID,
    supabase: Client,
) -> list[dict]:
    """
    List pending (non-expired) drafts for a user, newest first.

    Uses service client with user_id filter for ownership enforcement.
    """
    try:
        result = (
            supabase.table("recipe_drafts")
            .select("*")
            .eq("user_id", str(user_id))
            .gt("expires_at", datetime.now(timezone.utc).isoformat())
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to list drafts: {type(e).__name__}: {str(e)[:100]}",
            code="DB_QUERY_FAILED",
        )

    return result.data or []


def create_draft(
    *,
    user_id: UUID,
    image_storage_keys: list[str],
    title: str,
    model_version: str,
    parser_version: str,
    servings: str | None = None,
    prep_time: str | None = None,
    cook_time: str | None = None,
    confidence_score: float | None = None,
    ingredients: list | None = None,
    steps: list | None = None,
    raw_model_json: dict | None = None,
    source_url: str | None = None,
    draft_id: UUID | None = None,
    supabase: Client,
    logger: logging.Logger,
) -> dict:
    """
    Insert a draft record into recipe_drafts table.

    Uses service client with user_id for ownership.
    Caller is responsible for upload and parsing.
    ``draft_id`` lets the idempotent capture path create the draft under the
    id it reserved (api/core/draft_idempotency.py); otherwise the DB assigns one.
    """
    draft_data = {
        "user_id": str(user_id),
        "image_storage_keys": image_storage_keys,
        "source_url": source_url,
        "title": title,
        "servings": servings,
        "prep_time": prep_time,
        "cook_time": cook_time,
        "confidence_score": confidence_score,
        "ingredients": ingredients or [],
        "steps": steps or [],
        "raw_model_json": raw_model_json,
        "model_version": model_version,
        "parser_version": parser_version,
    }
    if draft_id is not None:
        draft_data["id"] = str(draft_id)

    try:
        result = supabase.table("recipe_drafts").insert(draft_data).execute()
    except Exception as e:
        # ``from e`` keeps the cause: a PostgREST APIError means the database
        # answered and rejected the row; anything else (timeout, connection
        # loss) leaves it unknown whether the insert committed.
        raise StorageError(
            f"Failed to insert draft: {type(e).__name__}: {str(e)[:100]}",
            code="DB_INSERT_FAILED",
        ) from e

    if not result.data:
        raise StorageError("Draft insert returned no data", code="DB_INSERT_FAILED")

    draft = result.data[0]
    logger.info(f"Created draft: {draft['id']}")
    return draft


def get_draft(
    draft_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict:
    """
    Fetch draft, verify ownership.

    Uses service client with user_id filter for ownership enforcement.
    Returns draft as dict.
    """
    try:
        result = (
            supabase.table("recipe_drafts")
            .select("*")
            .eq("id", str(draft_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        # .single() throws PGRST116 when 0 rows found
        msg = str(e).lower()
        if "pgrst116" in msg or "cannot coerce" in msg or "0 rows" in msg:
            raise DraftNotFoundError(
                f"Draft not found: {draft_id}",
                code="DRAFT_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not result.data:
        raise DraftNotFoundError(
            f"Draft not found: {draft_id}",
            code="DRAFT_NOT_FOUND",
        )

    return result.data


def get_active_draft(
    draft_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict:
    """
    Fetch draft, verify ownership, AND verify the draft is not expired.

    Mirrors get_draft's service-role + manual user_id filter ownership
    posture, then adds expiry enforcement per the locked Phase 13.9 contract
    §3.4: every per-turn boundary for draft-anchored Riff must reject
    expired drafts before Claude dispatch.

    Boundary semantics: a draft satisfying expires_at <= NOW() (UTC) is
    treated as expired (contract requires active drafts to satisfy
    expires_at > NOW()).

    Raises:
        DraftNotFoundError — draft missing or owned by another user.
        DraftExpiredError  — draft row exists but expires_at <= NOW() (UTC).
    """
    draft = get_draft(draft_id, user_id=user_id, supabase=supabase)

    raw = draft.get("expires_at")
    if isinstance(raw, str):
        # PostgREST renders TIMESTAMPTZ as ISO 8601 with +00:00 offset.
        # Defensively accept Z-suffixed strings in case the driver layer
        # normalizes — fromisoformat handles both forms after the swap.
        expires_at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    else:
        expires_at = raw

    if expires_at <= datetime.now(timezone.utc):
        raise DraftExpiredError(
            f"Draft expired: {draft_id}",
            code="DRAFT_EXPIRED",
        )

    return draft


def delete_draft(
    draft_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> list[str] | None:
    """
    Delete draft record. Returns image_storage_keys for caller to handle cleanup.

    Uses service client with user_id filter for ownership enforcement.
    Does NOT delete storage objects - caller is responsible.
    """
    # Fetch to get storage keys and verify ownership
    try:
        result = (
            supabase.table("recipe_drafts")
            .select("id, user_id, image_storage_keys")
            .eq("id", str(draft_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not result.data:
        raise DraftNotFoundError(
            f"Draft not found: {draft_id}",
            code="DRAFT_NOT_FOUND",
        )

    draft = result.data
    storage_keys = draft.get("image_storage_keys")

    # Delete draft record (filter by both id and user_id for safety)
    try:
        result = (
            supabase.table("recipe_drafts")
            .delete()
            .eq("id", str(draft_id))
            .eq("user_id", str(user_id))
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Failed to delete draft: {type(e).__name__}: {str(e)[:100]}",
            code="DB_DELETE_FAILED",
        )

    # Verify deletion occurred (defense against race conditions)
    if not result.data:
        raise DraftNotFoundError(
            f"Draft not found during delete: {draft_id}",
            code="DRAFT_NOT_FOUND",
        )

    logger.info(f"Deleted draft: {draft_id}")
    return storage_keys


def confirm_draft(
    draft_id: UUID,
    *,
    user_supabase: Client,
    logger: logging.Logger,
    title: str | None = None,
    servings: str | None = None,
    prep_time: str | None = None,
    cook_time: str | None = None,
    ingredients: list | None = None,
    steps: list | None = None,
) -> dict:
    """
    Commit draft to recipes table via RPC.

    IMPORTANT: Requires user-scoped Supabase client (with user's JWT)
    for auth.uid() to work inside the RPC.

    Accepts optional overrides for user edits made during review.
    Returns the RPC result containing recipe_id and metadata.
    """
    rpc_params: dict[str, Any] = {
        "p_draft_id": str(draft_id),
    }

    # Only include overrides if provided (native Python objects)
    if title is not None:
        rpc_params["p_title"] = title
    if servings is not None:
        rpc_params["p_servings"] = servings
    if prep_time is not None:
        rpc_params["p_prep_time"] = prep_time
    if cook_time is not None:
        rpc_params["p_cook_time"] = cook_time
    if ingredients is not None:
        rpc_params["p_ingredients"] = ingredients
    if steps is not None:
        rpc_params["p_steps"] = steps

    try:
        result = user_supabase.rpc("confirm_recipe_draft", rpc_params).execute()
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "not owned" in msg:
            raise DraftNotFoundError(
                f"Draft not found or not owned by user: {draft_id}",
                code="DRAFT_NOT_FOUND",
            )
        if "expired" in msg:
            raise DraftExpiredError(
                f"Draft has expired: {draft_id}",
                code="DRAFT_EXPIRED",
            )
        raise StorageError(
            f"Failed to confirm draft: {type(e).__name__}: {str(e)[:100]}",
            code="RPC_FAILED",
        )

    if not result.data:
        raise StorageError("Confirm RPC returned no data", code="RPC_FAILED")

    logger.info(f"Confirmed draft: {draft_id}")
    return result.data


def save_draft_riff(
    draft_id: UUID,
    session_id: UUID,
    message_id: UUID,
    riff_label: str | None,
    *,
    user_supabase: Client,
    logger: logging.Logger,
) -> dict:
    """
    Atomically save a draft-anchored Riff to the cookbook (Phase 13.9 Slice F).

    Thin wrapper around the save_draft_riff_recipe(...) Postgres RPC
    (migration 023). All write logic — insert recipe + ingredients + steps,
    UPDATE riff_sessions anchor migration, DELETE recipe_drafts — happens
    inside a single Postgres transaction per contract §3.1.

    IMPORTANT: requires the user-scoped Supabase client so the RPC's
    auth.uid() resolves correctly (SECURITY DEFINER inside the RPC still
    derives the caller from the JWT context).

    Returns a dict with locked shape:
        {"status": "created" | "already_migrated", "recipe_id": <uuid str>}

    The route layer is responsible for translating:
      - status="created"           → HTTP 200 with RiffSaveResponse(recipe_id)
      - status="already_migrated"  → HTTP 409 with detail {code, recipe_id}

    Raises:
        DraftNotFoundError  — draft / session / message missing, cross-user,
                              or anchor mismatch (P0002 from RPC)
        DraftExpiredError   — draft expires_at <= NOW() at RPC time
                              (P0001 from RPC; per-turn expiry per §3.4)
        StorageError        — generated_recipe absent (22023), RPC shape
                              malformed, or unknown RPC failure

    Save is NOT a billable Riff turn: this wrapper does NOT invoke
    enforce_riff_daily_cap or record_riff_turn (matches recipe save).
    Recipe insert + ingredient/step inserts happen in SQL inside the RPC,
    not in Python — Python-side compensation logic is unnecessary because
    the entire flow is a single Postgres transaction with all-or-nothing
    rollback semantics.
    """
    rpc_params: dict[str, Any] = {
        "p_draft_id": str(draft_id),
        "p_session_id": str(session_id),
        "p_message_id": str(message_id),
        "p_riff_label": riff_label,  # None → JSON null → SQL NULL
    }

    try:
        result = user_supabase.rpc(
            "save_draft_riff_recipe", rpc_params
        ).execute()
    except Exception as e:
        # Map RPC errcodes / message substrings to typed errors. Matches
        # confirm_draft's error-translation style. The RPC raises with
        # ERRCODE P0001 (expired), P0002 (not found / anchor mismatch),
        # P0003 (not authenticated — defensive), or 22023 (generated_recipe
        # absent). supabase-py surfaces the SQLSTATE + message in the
        # exception text.
        msg = str(e).lower()
        if "expired" in msg or "p0001" in msg:
            raise DraftExpiredError(
                f"Draft expired: {draft_id}",
                code="DRAFT_EXPIRED",
            )
        if "no generated recipe" in msg or "22023" in msg:
            raise StorageError(
                "No generated recipe available for this message",
                code="GENERATED_RECIPE_MISSING",
            )
        if (
            "not found" in msg
            or "not anchored" in msg
            or "p0002" in msg
        ):
            raise DraftNotFoundError(
                f"Draft / session / message not found: draft={draft_id} "
                f"session={session_id} message={message_id}",
                code="DRAFT_NOT_FOUND",
            )
        # Unknown failure (auth, network, PostgREST plumbing, etc.)
        raise StorageError(
            f"Save RPC failed: {type(e).__name__}: {str(e)[:100]}",
            code="RPC_FAILED",
        )

    # Defensive shape validation: RPC returns JSONB
    # {"status": "...", "recipe_id": "..."}. supabase-py historically
    # returns scalar-RPC data as the unwrapped value, but be defensive
    # against future driver changes that wrap in a single-element list.
    payload = result.data
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        logger.error(
            f"Save RPC returned non-dict payload: "
            f"type={type(payload).__name__}"
        )
        raise StorageError(
            "Save RPC returned malformed payload",
            code="RPC_MALFORMED",
        )

    status = payload.get("status")
    recipe_id = payload.get("recipe_id")
    if status not in ("created", "already_migrated"):
        logger.error(f"Save RPC returned unknown status: {status!r}")
        raise StorageError(
            f"Save RPC returned unknown status: {status!r}",
            code="RPC_MALFORMED",
        )
    if not recipe_id:
        logger.error(
            f"Save RPC returned no recipe_id (status={status!r})"
        )
        raise StorageError(
            "Save RPC returned no recipe_id",
            code="RPC_MALFORMED",
        )

    logger.info(
        f"Save draft riff: draft={draft_id} session={session_id} "
        f"status={status} recipe={recipe_id}"
    )
    return {"status": status, "recipe_id": str(recipe_id)}
