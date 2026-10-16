"""
Tastelog: Recipe Riff mode routes (Phase 13.1).

Single endpoint: POST /api/recipes/{recipe_id}/riff.
One user turn in, one assistant reply out. No structured recipe extraction
in 13.1 — see api/core/riff.py for scope notes.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from supabase import Client

from api.core.anthropic_client import get_anthropic_client
from api.core.config import get_settings
from api.core.drafts import get_active_draft, save_draft_riff
from api.core.exceptions import (
    DraftExpiredError,
    DraftNotFoundError,
    RecipeNotFoundError,
    StorageError,
)
from api.core.parser import ParsedRecipe, get_default_config
from api.core.recipes import get_recipe
from api.core.step_mapping import apply_step_mapping, map_ingredients_to_steps
from api.core.riff import (
    RiffError,
    _draft_to_riff_recipe_dict,
    _encode_sse_event,
    extract_recipe_block,
    get_default_riff_config,
    run_riff_turn,
    run_riff_turn_stream,
)
from api.core.riff_usage import (
    RiffUsageLimitExceeded,
    RiffUsageTrackingError,
    enforce_riff_daily_cap,
    record_riff_turn,
)
from api.dependencies import get_current_user_id, get_db, get_user_db
from api.models.riff import (
    RiffMessageRequest,
    RiffSaveRequest,
    RiffSaveResponse,
    RiffTurnResponse,
)

logger = logging.getLogger("tastelog.api.riff")

router = APIRouter(tags=["riff"])


@router.post(
    "/api/recipes/{recipe_id}/riff",
    response_model=RiffTurnResponse,
)
async def riff_turn_endpoint(
    recipe_id: UUID,
    body: RiffMessageRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RiffTurnResponse:
    """Send one user turn to the riff assistant; receive one assistant reply.

    Errors:
        404  recipe not found / not owned, or session not found / not owned
             / belongs to a different recipe
        422  empty or oversized message (handled by Pydantic)
        500  storage failure (session create / message insert / history load)
        502  Anthropic / Claude call failure
    """
    # 1. Validate recipe ownership + load full detail for the system prompt.
    #    Reuse the canonical loader — no duplicate fetch logic.
    try:
        recipe = get_recipe(recipe_id, user_id=user_id, supabase=db)
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        logger.error("Riff recipe load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load recipe")

    # 2. Validate existing session ownership if one was provided. All
    #    riff_* reads/writes go through user_db so RLS enforces ownership
    #    (cross-user SELECT → 0 rows → 404). Cross-recipe reuse is treated
    #    as not-found because the system prompt is anchored to recipe_id.
    #    Existing sessions: validate only — do NOT mutate entry_point.
    if body.session_id is not None:
        try:
            lookup = (
                user_db.table("riff_sessions")
                .select("id, source_recipe_id")
                .eq("id", str(body.session_id))
                .execute()
            )
        except Exception as e:
            logger.error("Riff session lookup failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to load riff session")
        if not lookup.data:
            raise HTTPException(
                status_code=404, detail=f"Riff session not found: {body.session_id}"
            )
        row = lookup.data[0]
        if row.get("source_recipe_id") != str(recipe_id):
            raise HTTPException(
                status_code=404, detail=f"Riff session not found: {body.session_id}"
            )

    # 3. Enforce per-user daily Riff cap (Phase 13.7 §5.2). Runs after
    #    validation so 404 / 409 surface ahead of 429.
    try:
        enforce_riff_daily_cap(user_id, supabase=db)
    except RiffUsageLimitExceeded as e:
        logger.info("Riff cap reached for user %s: %s", user_id, e)
        raise HTTPException(
            status_code=429,
            detail="Daily Riff limit reached. Try again tomorrow.",
        )

    # 4. Create new session if one wasn't provided. entry_point default
    #    resolved here — server-side default avoids a mobile change for
    #    the dedicated recipe-detail surface (§5.3). New sessions only;
    #    existing sessions never mutate entry_point.
    if body.session_id is None:
        try:
            insert_result = (
                user_db.table("riff_sessions")
                .insert(
                    {
                        "user_id": str(user_id),
                        "source_recipe_id": str(recipe_id),
                        "entry_point": body.entry_point or "recipe_detail",
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error("Riff session create failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to create riff session")
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to create riff session")
        session_id = UUID(insert_result.data[0]["id"])
    else:
        session_id = body.session_id

    # 5. Reserve one Riff turn at the dispatch boundary. Required write
    #    — failure raises RiffUsageTrackingError, translated to HTTP 500
    #    here, which prevents Claude dispatch (no untracked dispatches
    #    once the cap is live). Runs BEFORE the user-message insert so a
    #    tracking failure cannot leave an orphan user row.
    try:
        record_riff_turn(user_id, supabase=db)
    except RiffUsageTrackingError as e:
        logger.error("Riff usage tracking failed: %s", e)
        raise HTTPException(
            status_code=500, detail="Failed to record Riff usage"
        )

    # 6. Persist the user message. RLS validates session ownership via the
    #    EXISTS subquery in riff_messages_insert policy.
    try:
        user_db.table("riff_messages").insert(
            {
                "session_id": str(session_id),
                "role": "user",
                "content": body.message,
            }
        ).execute()
    except Exception as e:
        logger.error("Riff user message insert failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save riff message")

    # 7. Load the full conversation chronologically. The just-inserted user
    #    turn is at the tail; run_riff_turn bounds to MAX_TURNS internally.
    try:
        history_result = (
            user_db.table("riff_messages")
            .select("role, content, created_at")
            .eq("session_id", str(session_id))
            .order("created_at", desc=False)
            .execute()
        )
    except Exception as e:
        logger.error("Riff history load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load riff history")
    history = history_result.data or []

    # 8. Call Claude — direct SDK, no wrapper. Same instantiation pattern as
    #    routes/recipes.py and routes/drafts.py.
    settings = get_settings()
    anthropic_client = get_anthropic_client()
    config = get_default_riff_config()

    try:
        assistant_text = run_riff_turn(
            config=config,
            client=anthropic_client,
            recipe=recipe,
            history=history,
            logger=logger,
        )
    except RiffError as e:
        logger.warning("Riff Claude call failed: %s: %s", e.code, e)
        raise HTTPException(status_code=502, detail=str(e))

    # 9. Extract optional structured recipe block from the assistant text.
    #    Pure function — no DB, no network. Returns a validated
    #    ParsedRecipe.model_dump() dict, or None on miss / invalid block.
    generated_recipe = extract_recipe_block(assistant_text)

    # 10. Persist the assistant reply with generated_recipe populated in
    #     the same INSERT. No follow-up UPDATE — preserves the append-only
    #     RLS contract on riff_messages (no UPDATE policy exists).
    try:
        assistant_insert = (
            user_db.table("riff_messages")
            .insert(
                {
                    "session_id": str(session_id),
                    "role": "assistant",
                    "content": assistant_text,
                    "generated_recipe": (
                        generated_recipe if generated_recipe is not None else None
                    ),
                }
            )
            .execute()
        )
    except Exception as e:
        logger.error("Riff assistant message insert failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save riff response")

    if not assistant_insert.data:
        raise HTTPException(status_code=500, detail="Failed to save riff response")
    assistant_message_id = UUID(assistant_insert.data[0]["id"])

    return RiffTurnResponse(
        session_id=session_id,
        assistant_message=assistant_text,
        assistant_message_id=assistant_message_id,
        generated_recipe=generated_recipe,
    )


# ---------------------------------------------------------------------------
# Phase 13.9 Slice D — Draft-anchored sync endpoint (sibling of recipe sync)
# ---------------------------------------------------------------------------


@router.post(
    "/api/drafts/{draft_id}/riff",
    response_model=RiffTurnResponse,
)
async def riff_draft_turn_endpoint(
    draft_id: UUID,
    body: RiffMessageRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RiffTurnResponse:
    """Send one user turn to the draft-anchored Riff assistant; receive one
    assistant reply. Locked Phase 13.9 contract §4 (sibling route under
    /api/drafts/{id}/riff) + §3.4 (per-turn expiry enforcement) + §5
    (server-side adapter; RIFF_SYSTEM_PROMPT_TEMPLATE unchanged).

    Errors:
        404  draft not found / not owned / expired (dict detail with
             "code": "DRAFT_NOT_FOUND" | "DRAFT_EXPIRED" for mobile
             distinguishability per contract §3.4); OR session not found /
             not owned / recipe-anchored / anchored to a different draft
             (string detail, mirrors recipe sync's session-404 style)
        422  empty or oversized message (handled by Pydantic)
        429  daily Riff cap reached (Phase 13.7 shared across surfaces)
        500  storage failure (draft load / session ops / message insert) or
             Riff usage tracking failure
        502  Anthropic / Claude call failure
    """
    # 1. Auth runs via Depends(get_current_user_id) before this body.

    # 2. Load + validate the draft. Single helper enforces ownership +
    #    expiry per contract §3.4 ("every per-turn boundary"). Runs before
    #    every other DB read so cross-user / expired surfaces 404 ahead of
    #    cap-status leaks.
    try:
        draft = get_active_draft(draft_id, user_id=user_id, supabase=db)
    except DraftNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_NOT_FOUND",
                "message": f"Draft not found: {draft_id}",
            },
        )
    except DraftExpiredError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_EXPIRED",
                "message": f"Draft expired: {draft_id}",
            },
        )
    except StorageError as e:
        logger.error("Riff draft load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load draft")

    # 3. Validate existing session ownership if one was provided. All
    #    riff_* reads/writes go through user_db so RLS enforces ownership
    #    (cross-user SELECT → 0 rows → 404). Three additional rejection
    #    paths beyond cross-user: recipe-anchored session (source_recipe_id
    #    non-null), session anchored to a different draft, or missing.
    #    Existing sessions: validate only — do NOT mutate entry_point
    #    (contract §11).
    if body.session_id is not None:
        try:
            lookup = (
                user_db.table("riff_sessions")
                .select("id, source_recipe_id, source_draft_id")
                .eq("id", str(body.session_id))
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft session lookup failed: %s", e, exc_info=True
            )
            raise HTTPException(
                status_code=500, detail="Failed to load riff session"
            )
        if not lookup.data:
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )
        row = lookup.data[0]
        if row.get("source_recipe_id") is not None:
            # Cross-anchor: recipe-anchored session passed to draft route.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )
        if row.get("source_draft_id") != str(draft_id):
            # Cross-draft: session anchored to a DIFFERENT draft.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )

    # 4. Enforce per-user daily Riff cap (Phase 13.7 §5.2). Runs AFTER
    #    draft + session validation so 404 surfaces ahead of 429.
    try:
        enforce_riff_daily_cap(user_id, supabase=db)
    except RiffUsageLimitExceeded as e:
        logger.info("Riff draft cap reached for user %s: %s", user_id, e)
        raise HTTPException(
            status_code=429,
            detail="Daily Riff limit reached. Try again tomorrow.",
        )

    # 5. Create new session if one wasn't provided. entry_point default
    #    resolved here per contract §11 — locked default "draft_review",
    #    set at session create only, never mutated. Insert via user_db so
    #    the permissive INSERT policy (user_id check) + Slice A RESTRICTIVE
    #    riff_sessions_draft_ownership policy (draft must be owned by
    #    auth.uid()) both gate the write. Slice A CHECK
    #    (num_nonnulls(source_recipe_id, source_draft_id) = 1) satisfied
    #    by construction.
    if body.session_id is None:
        try:
            insert_result = (
                user_db.table("riff_sessions")
                .insert(
                    {
                        "user_id": str(user_id),
                        "source_recipe_id": None,
                        "source_draft_id": str(draft_id),
                        "entry_point": body.entry_point or "draft_review",
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft session create failed: %s", e, exc_info=True
            )
            raise HTTPException(
                status_code=500, detail="Failed to create riff session"
            )
        if not insert_result.data:
            raise HTTPException(
                status_code=500, detail="Failed to create riff session"
            )
        session_id = UUID(insert_result.data[0]["id"])
    else:
        session_id = body.session_id

    # 6. Reserve one Riff turn at the dispatch boundary. Required write
    #    — failure raises RiffUsageTrackingError, translated to HTTP 500
    #    here, which prevents Claude dispatch (no untracked dispatches
    #    once the cap is live). Runs BEFORE the user-message insert so a
    #    tracking failure cannot leave an orphan user row.
    try:
        record_riff_turn(user_id, supabase=db)
    except RiffUsageTrackingError as e:
        logger.error("Riff draft usage tracking failed: %s", e)
        raise HTTPException(
            status_code=500, detail="Failed to record Riff usage"
        )

    # 7. Persist the user message. RLS validates session ownership via the
    #    EXISTS subquery in riff_messages_insert policy. Append-only.
    try:
        user_db.table("riff_messages").insert(
            {
                "session_id": str(session_id),
                "role": "user",
                "content": body.message,
            }
        ).execute()
    except Exception as e:
        logger.error(
            "Riff draft user message insert failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to save riff message")

    # 8. Load the full conversation chronologically. The just-inserted user
    #    turn is at the tail; run_riff_turn bounds to MAX_TURNS internally.
    #    NOT applying _drop_orphaned_user_rows — sync endpoint always pairs
    #    user+assistant in one request and cannot produce orphans (that
    #    helper is streaming-endpoint-only per contract §4).
    try:
        history_result = (
            user_db.table("riff_messages")
            .select("role, content, created_at")
            .eq("session_id", str(session_id))
            .order("created_at", desc=False)
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft history load failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to load riff history")
    history = history_result.data or []

    # 9. Project the draft row into the 6-key shape build_riff_system_prompt
    #    consumes. Slice C adapter; no template edit, no
    #    build_riff_system_prompt edit. Recipe-anchored callers pass
    #    get_recipe() output; draft-anchored callers pass adapter output —
    #    Claude sees byte-identical system prompts for matching source data
    #    (Slice C spot-check tests #8 / #9 / #10).
    recipe_shape = _draft_to_riff_recipe_dict(draft)

    # 10. Call Claude — direct SDK, same anchor pattern as recipe sync.
    settings = get_settings()
    anthropic_client = get_anthropic_client()
    config = get_default_riff_config()

    try:
        assistant_text = run_riff_turn(
            config=config,
            client=anthropic_client,
            recipe=recipe_shape,
            history=history,
            logger=logger,
        )
    except RiffError as e:
        logger.warning("Riff draft Claude call failed: %s: %s", e.code, e)
        raise HTTPException(status_code=502, detail=str(e))

    # 11. Extract optional structured recipe block from the assistant text.
    #     Same extractor the recipe path uses. Pure function — no DB, no
    #     network. Returns ParsedRecipe.model_dump() dict, or None on
    #     miss / invalid block.
    generated_recipe = extract_recipe_block(assistant_text)

    # 12. Persist the assistant reply with generated_recipe populated in
    #     the same INSERT. No follow-up UPDATE — preserves the append-only
    #     RLS contract on riff_messages.
    try:
        assistant_insert = (
            user_db.table("riff_messages")
            .insert(
                {
                    "session_id": str(session_id),
                    "role": "assistant",
                    "content": assistant_text,
                    "generated_recipe": (
                        generated_recipe if generated_recipe is not None else None
                    ),
                }
            )
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft assistant message insert failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to save riff response")

    if not assistant_insert.data:
        raise HTTPException(status_code=500, detail="Failed to save riff response")
    assistant_message_id = UUID(assistant_insert.data[0]["id"])

    # 13. Return.
    return RiffTurnResponse(
        session_id=session_id,
        assistant_message=assistant_text,
        assistant_message_id=assistant_message_id,
        generated_recipe=generated_recipe,
    )


# ---------------------------------------------------------------------------
# Phase 13.5 — Streaming endpoint (sibling of /riff)
# ---------------------------------------------------------------------------

# Safe-for-display messages per V1 §16-G error code. Used as the `message`
# field on SSE `error` events. Server logs preserve the raw RiffError detail
# at WARNING — clients only see these strings.
_ERROR_DISPLAY_MESSAGES: dict[str, str] = {
    "RATE_LIMIT": "Rate limit hit. Try again in a moment.",
    "MODEL_TIMEOUT": "The model took too long to respond.",
    "NETWORK_ERROR": "Network error. Check your connection and try again.",
    "MODEL_ERROR": "The model returned an error.",
    "INTERNAL_ERROR": "Something went wrong on our end.",
}

# Pre-first-byte retryable codes (§16-G + directive). Mid-stream is always
# retryable=False; assistant-insert failure is always retryable=False.
_PRE_FIRST_BYTE_RETRYABLE_CODES: frozenset[str] = frozenset(
    {"RATE_LIMIT", "MODEL_TIMEOUT", "NETWORK_ERROR"}
)


def _drop_orphaned_user_rows(
    rows: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Drop user messages that have no assistant reply after them.

    Cancelled streaming turns leave a user row in riff_messages without a
    paired assistant row (the assistant insert lives after the SDK loop and
    is skipped on cancel). On the NEXT turn, history-load picks both the
    orphan and the just-inserted current user row, so Claude sees two
    consecutive user turns and combines them — the next reply is poisoned
    by the cancelled prompt's intent.

    Filter rule: keep every assistant row, and keep a user row only if some
    assistant appears after it OR it is the last row in the list (the
    just-inserted current turn). Read-side only — no DELETE on
    riff_messages, append-only RLS contract preserved.
    """
    if not rows:
        return rows
    keep: list[bool] = [False] * len(rows)
    seen_assistant_after = False
    for i in range(len(rows) - 1, -1, -1):
        role = rows[i].get("role")
        if role == "assistant":
            seen_assistant_after = True
            keep[i] = True
        elif role == "user":
            if seen_assistant_after or i == len(rows) - 1:
                keep[i] = True
        else:
            # Defensive: unknown role — keep, don't silently drop.
            keep[i] = True
    return [r for r, k in zip(rows, keep) if k]


@router.post("/api/recipes/{recipe_id}/riff/stream")
async def riff_stream_endpoint(
    recipe_id: UUID,
    body: RiffMessageRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> StreamingResponse:
    """Streaming variant of the riff endpoint (Phase 13.5).

    Wire format: SSE (text/event-stream). Event ordering and persistence
    semantics are specified in docs/phase13-4-B-streaming-contract.md
    (§4, §6, §13). Sync endpoint behavior is unchanged.

    Errors that fire BEFORE the SSE response opens (auth, recipe/session
    ownership, user-row insert, flag-off) come back as normal HTTP error
    responses — the byte stream never opens. Errors that fire AFTER the
    response opens go through the SSE `error` event mechanism per §8.

    Cancel: when the client closes the connection, Starlette cancels the
    underlying task and Python injects GeneratorExit at the next yield.
    GeneratorExit propagates through run_riff_turn_stream's `with` block,
    closing the SDK stream cleanly. No assistant row is written. We do
    not attempt to emit terminal `cancelled`/`done` events — the contract
    §7 explicitly notes those are best-effort and may be dropped on hard
    close. Logging-only cancel observability is sufficient.
    """
    settings = get_settings()

    # Flag-off path: route is mounted but invisible by behavior.
    if not settings.riff_streaming_enabled:
        raise HTTPException(status_code=404, detail="Not Found")

    # 1. Validate recipe ownership + load full detail for the system prompt.
    try:
        recipe = get_recipe(recipe_id, user_id=user_id, supabase=db)
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        logger.error("Riff stream: recipe load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load recipe")

    # 2. Validate existing session ownership if one was provided. Same
    #    logic as sync endpoint. Existing sessions: validate only — do
    #    NOT mutate entry_point.
    if body.session_id is not None:
        try:
            lookup = (
                user_db.table("riff_sessions")
                .select("id, source_recipe_id")
                .eq("id", str(body.session_id))
                .execute()
            )
        except Exception as e:
            logger.error("Riff stream: session lookup failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to load riff session")
        if not lookup.data:
            raise HTTPException(
                status_code=404, detail=f"Riff session not found: {body.session_id}"
            )
        row = lookup.data[0]
        if row.get("source_recipe_id") != str(recipe_id):
            raise HTTPException(
                status_code=404, detail=f"Riff session not found: {body.session_id}"
            )

    # 3. Enforce per-user daily Riff cap (Phase 13.7 §5.2). Surfaces as
    #    a normal 429 HTTP response — the SSE stream never opens.
    try:
        enforce_riff_daily_cap(user_id, supabase=db)
    except RiffUsageLimitExceeded as e:
        logger.info("Riff stream cap reached for user %s: %s", user_id, e)
        raise HTTPException(
            status_code=429,
            detail="Daily Riff limit reached. Try again tomorrow.",
        )

    # 4. Create new session if one wasn't provided. entry_point default
    #    resolved here. New sessions only; existing sessions never mutate
    #    entry_point.
    if body.session_id is None:
        try:
            insert_result = (
                user_db.table("riff_sessions")
                .insert(
                    {
                        "user_id": str(user_id),
                        "source_recipe_id": str(recipe_id),
                        "entry_point": body.entry_point or "recipe_detail",
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error("Riff stream: session create failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to create riff session")
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to create riff session")
        session_id = UUID(insert_result.data[0]["id"])
    else:
        session_id = body.session_id

    # 5. Reserve one Riff turn at the dispatch boundary. Required write
    #    — RiffUsageTrackingError → HTTP 500, prevents SSE open + Claude
    #    dispatch. Runs BEFORE user-msg insert so tracking failure cannot
    #    orphan a user row.
    try:
        record_riff_turn(user_id, supabase=db)
    except RiffUsageTrackingError as e:
        logger.error("Riff stream usage tracking failed: %s", e)
        raise HTTPException(
            status_code=500, detail="Failed to record Riff usage"
        )

    # 6. Persist the user message.
    try:
        user_insert = (
            user_db.table("riff_messages")
            .insert(
                {
                    "session_id": str(session_id),
                    "role": "user",
                    "content": body.message,
                }
            )
            .execute()
        )
    except Exception as e:
        logger.error("Riff stream: user message insert failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save riff message")
    if not user_insert.data:
        raise HTTPException(status_code=500, detail="Failed to save riff message")
    user_message_id = UUID(user_insert.data[0]["id"])

    # 7. Load conversation history (chronological).
    try:
        history_result = (
            user_db.table("riff_messages")
            .select("role, content, created_at")
            .eq("session_id", str(session_id))
            .order("created_at", desc=False)
            .execute()
        )
    except Exception as e:
        logger.error("Riff stream: history load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load riff history")
    history = history_result.data or []

    # Drop orphaned user rows (cancelled streaming turns) before dispatch
    # so the next turn isn't poisoned by the cancelled prompt's intent.
    # Streaming endpoint only — sync endpoint always pairs user+assistant
    # in one request and cannot produce orphans.
    history = _drop_orphaned_user_rows(history)

    # 8. Open the SSE response. From here on, errors go through SSE `error`.
    anthropic_client = get_anthropic_client()
    config = get_default_riff_config()

    def _stream_events():
        # First two events confirm dispatch immediately so the client can
        # render the optimistic user bubble even if Claude is slow.
        yield _encode_sse_event(
            "session_resolved", {"session_id": str(session_id)}
        )
        yield _encode_sse_event(
            "user_message_committed", {"user_message_id": str(user_message_id)}
        )

        delta_count = 0
        full_text_parts: list[str] = []

        try:
            for delta in run_riff_turn_stream(
                config=config,
                client=anthropic_client,
                recipe=recipe,
                history=history,
                logger=logger,
            ):
                full_text_parts.append(delta)
                yield _encode_sse_event(
                    "assistant_delta",
                    {"text": delta, "seq": delta_count},
                )
                delta_count += 1
        except RiffError as e:
            logger.warning(
                "Riff stream Claude failed: code=%s delta_count=%d detail=%s",
                e.code,
                delta_count,
                e,
            )
            retryable = (
                delta_count == 0
                and e.code in _PRE_FIRST_BYTE_RETRYABLE_CODES
            )
            display_msg = _ERROR_DISPLAY_MESSAGES.get(
                e.code, _ERROR_DISPLAY_MESSAGES["MODEL_ERROR"]
            )
            yield _encode_sse_event(
                "error",
                {
                    "code": e.code,
                    "message": display_msg,
                    "retryable": retryable,
                },
            )
            yield _encode_sse_event("done", {})
            return

        # SDK stream completed normally. Accumulated full text is the
        # canonical assistant content (per §5). Run extraction, then INSERT
        # the assistant row atomically. assistant_complete is emitted only
        # AFTER the row is committed.
        full_text = "".join(full_text_parts)
        generated_recipe = extract_recipe_block(full_text) if full_text else None

        try:
            assistant_insert = (
                user_db.table("riff_messages")
                .insert(
                    {
                        "session_id": str(session_id),
                        "role": "assistant",
                        "content": full_text,
                        "generated_recipe": generated_recipe,
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff stream: assistant insert failed: %s",
                e,
                exc_info=True,
            )
            yield _encode_sse_event(
                "error",
                {
                    "code": "INTERNAL_ERROR",
                    "message": _ERROR_DISPLAY_MESSAGES["INTERNAL_ERROR"],
                    "retryable": False,
                },
            )
            yield _encode_sse_event("done", {})
            return

        if not assistant_insert.data:
            logger.error("Riff stream: assistant insert returned no data")
            yield _encode_sse_event(
                "error",
                {
                    "code": "INTERNAL_ERROR",
                    "message": _ERROR_DISPLAY_MESSAGES["INTERNAL_ERROR"],
                    "retryable": False,
                },
            )
            yield _encode_sse_event("done", {})
            return

        assistant_message_id = UUID(assistant_insert.data[0]["id"])

        yield _encode_sse_event(
            "assistant_complete",
            {"assistant_message_id": str(assistant_message_id)},
        )

        if generated_recipe is not None:
            yield _encode_sse_event(
                "generated_recipe_ready",
                {"generated_recipe": generated_recipe},
            )

        yield _encode_sse_event("done", {})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _stream_events(),
        media_type="text/event-stream",
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Phase 13.9 Slice E — Draft-anchored streaming endpoint
# (sibling of recipe stream, flag-gated identically)
# ---------------------------------------------------------------------------


@router.post("/api/drafts/{draft_id}/riff/stream")
async def riff_draft_stream_endpoint(
    draft_id: UUID,
    body: RiffMessageRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> StreamingResponse:
    """Streaming variant of the draft-anchored Riff endpoint (Phase 13.9
    Slice E). Sibling of the recipe stream (Phase 13.5).

    Wire format: SSE (text/event-stream). Event ordering, persistence,
    cancel, and error semantics are bit-identical to the recipe stream —
    same _encode_sse_event, _drop_orphaned_user_rows, _ERROR_DISPLAY_MESSAGES,
    _PRE_FIRST_BYTE_RETRYABLE_CODES, run_riff_turn_stream. The Phase 13.5
    streaming lifecycle is preserved verbatim.

    Slice E-specific differences (all upstream of the SSE generator):
        - get_active_draft enforces ownership + expiry (contract §3.4)
        - 404 dict detail for DRAFT_NOT_FOUND / DRAFT_EXPIRED (mobile)
        - Draft-anchor session validation (anchor type + draft match)
        - _draft_to_riff_recipe_dict adapter feeds run_riff_turn_stream
        - entry_point defaults to "draft_review" (contract §11)

    Errors that fire BEFORE the SSE response opens (auth, flag-off, draft
    ownership / expiry, session ownership / anchor mismatch, cap,
    tracking, user-row insert, session create, history load) come back as
    normal HTTP error responses — the byte stream never opens. Errors
    that fire AFTER the response opens go through the SSE `error` event.

    Cancel: identical to recipe stream. GeneratorExit propagates through
    run_riff_turn_stream's `with` block, closing the SDK stream cleanly.
    No assistant row is written on cancel.
    """
    settings = get_settings()

    # 0. Flag-off path: route mounted but invisible by behavior. Same gate
    #    the recipe stream uses.
    if not settings.riff_streaming_enabled:
        raise HTTPException(status_code=404, detail="Not Found")

    # 1. Load + validate the draft. Single helper enforces ownership +
    #    expiry per contract §3.4 ("every per-turn boundary"). Failures
    #    surface as HTTP 404 dict / 500 BEFORE SSE opens.
    try:
        draft = get_active_draft(draft_id, user_id=user_id, supabase=db)
    except DraftNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_NOT_FOUND",
                "message": f"Draft not found: {draft_id}",
            },
        )
    except DraftExpiredError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_EXPIRED",
                "message": f"Draft expired: {draft_id}",
            },
        )
    except StorageError as e:
        logger.error(
            "Riff draft stream: draft load failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to load draft")

    # 2. Validate existing session ownership if one was provided. Same
    #    anchor-type + draft-match checks as the Slice D sync endpoint.
    #    Existing sessions: validate only — do NOT mutate entry_point
    #    (contract §11).
    if body.session_id is not None:
        try:
            lookup = (
                user_db.table("riff_sessions")
                .select("id, source_recipe_id, source_draft_id")
                .eq("id", str(body.session_id))
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft stream: session lookup failed: %s",
                e,
                exc_info=True,
            )
            raise HTTPException(
                status_code=500, detail="Failed to load riff session"
            )
        if not lookup.data:
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )
        row = lookup.data[0]
        if row.get("source_recipe_id") is not None:
            # Cross-anchor: recipe-anchored session passed to draft route.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )
        if row.get("source_draft_id") != str(draft_id):
            # Cross-draft: session anchored to a DIFFERENT draft.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )

    # 3. Enforce per-user daily Riff cap (Phase 13.7 §5.2). Runs AFTER
    #    draft + session validation so 404 surfaces ahead of 429.
    try:
        enforce_riff_daily_cap(user_id, supabase=db)
    except RiffUsageLimitExceeded as e:
        logger.info(
            "Riff draft stream cap reached for user %s: %s", user_id, e
        )
        raise HTTPException(
            status_code=429,
            detail="Daily Riff limit reached. Try again tomorrow.",
        )

    # 4. Create new session if absent. entry_point default "draft_review"
    #    per contract §11. Insert via user_db so the permissive INSERT
    #    policy (user_id check) + Slice A RESTRICTIVE
    #    riff_sessions_draft_ownership policy both gate the write.
    if body.session_id is None:
        try:
            insert_result = (
                user_db.table("riff_sessions")
                .insert(
                    {
                        "user_id": str(user_id),
                        "source_recipe_id": None,
                        "source_draft_id": str(draft_id),
                        "entry_point": body.entry_point or "draft_review",
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft stream: session create failed: %s",
                e,
                exc_info=True,
            )
            raise HTTPException(
                status_code=500, detail="Failed to create riff session"
            )
        if not insert_result.data:
            raise HTTPException(
                status_code=500, detail="Failed to create riff session"
            )
        session_id = UUID(insert_result.data[0]["id"])
    else:
        session_id = body.session_id

    # 5. Reserve one Riff turn. Required write — RiffUsageTrackingError →
    #    HTTP 500, prevents SSE open + Claude dispatch. Runs BEFORE
    #    user-msg insert so tracking failure cannot orphan a user row.
    try:
        record_riff_turn(user_id, supabase=db)
    except RiffUsageTrackingError as e:
        logger.error("Riff draft stream usage tracking failed: %s", e)
        raise HTTPException(
            status_code=500, detail="Failed to record Riff usage"
        )

    # 6. Persist the user message.
    try:
        user_insert = (
            user_db.table("riff_messages")
            .insert(
                {
                    "session_id": str(session_id),
                    "role": "user",
                    "content": body.message,
                }
            )
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft stream: user message insert failed: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail="Failed to save riff message")
    if not user_insert.data:
        raise HTTPException(status_code=500, detail="Failed to save riff message")
    user_message_id = UUID(user_insert.data[0]["id"])

    # 7. Load conversation history (chronological).
    try:
        history_result = (
            user_db.table("riff_messages")
            .select("role, content, created_at")
            .eq("session_id", str(session_id))
            .order("created_at", desc=False)
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft stream: history load failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to load riff history")
    history = history_result.data or []

    # 8. Apply orphan filter (streaming-only — same helper recipe stream
    #    uses). Drops user rows without paired assistant rows so cancelled
    #    prompts can't poison the next turn. Read-side only, no DELETE,
    #    append-only RLS preserved.
    history = _drop_orphaned_user_rows(history)

    # 9. Project the draft row into the 6-key shape build_riff_system_prompt
    #    consumes (Slice C). recipe_shape is captured in the generator
    #    closure. Recipe stream passes get_recipe() output; draft stream
    #    passes adapter output — byte-identical system prompt for matching
    #    source data (Slice C spot-check tests).
    recipe_shape = _draft_to_riff_recipe_dict(draft)

    # 10. Open SSE response. From here on, errors go through SSE `error`.
    anthropic_client = get_anthropic_client()
    config = get_default_riff_config()

    def _stream_events():
        # First two events confirm dispatch immediately so the client can
        # render the optimistic user bubble even if Claude is slow.
        yield _encode_sse_event(
            "session_resolved", {"session_id": str(session_id)}
        )
        yield _encode_sse_event(
            "user_message_committed", {"user_message_id": str(user_message_id)}
        )

        delta_count = 0
        full_text_parts: list[str] = []

        try:
            for delta in run_riff_turn_stream(
                config=config,
                client=anthropic_client,
                recipe=recipe_shape,
                history=history,
                logger=logger,
            ):
                full_text_parts.append(delta)
                yield _encode_sse_event(
                    "assistant_delta",
                    {"text": delta, "seq": delta_count},
                )
                delta_count += 1
        except RiffError as e:
            logger.warning(
                "Riff draft stream Claude failed: code=%s delta_count=%d detail=%s",
                e.code,
                delta_count,
                e,
            )
            retryable = (
                delta_count == 0
                and e.code in _PRE_FIRST_BYTE_RETRYABLE_CODES
            )
            display_msg = _ERROR_DISPLAY_MESSAGES.get(
                e.code, _ERROR_DISPLAY_MESSAGES["MODEL_ERROR"]
            )
            yield _encode_sse_event(
                "error",
                {
                    "code": e.code,
                    "message": display_msg,
                    "retryable": retryable,
                },
            )
            yield _encode_sse_event("done", {})
            return

        # SDK stream completed normally. Accumulated full text is the
        # canonical assistant content. Run extraction, then INSERT the
        # assistant row atomically. assistant_complete is emitted only
        # AFTER the row is committed.
        full_text = "".join(full_text_parts)
        generated_recipe = extract_recipe_block(full_text) if full_text else None

        try:
            assistant_insert = (
                user_db.table("riff_messages")
                .insert(
                    {
                        "session_id": str(session_id),
                        "role": "assistant",
                        "content": full_text,
                        "generated_recipe": generated_recipe,
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft stream: assistant insert failed: %s",
                e,
                exc_info=True,
            )
            yield _encode_sse_event(
                "error",
                {
                    "code": "INTERNAL_ERROR",
                    "message": _ERROR_DISPLAY_MESSAGES["INTERNAL_ERROR"],
                    "retryable": False,
                },
            )
            yield _encode_sse_event("done", {})
            return

        if not assistant_insert.data:
            logger.error(
                "Riff draft stream: assistant insert returned no data"
            )
            yield _encode_sse_event(
                "error",
                {
                    "code": "INTERNAL_ERROR",
                    "message": _ERROR_DISPLAY_MESSAGES["INTERNAL_ERROR"],
                    "retryable": False,
                },
            )
            yield _encode_sse_event("done", {})
            return

        assistant_message_id = UUID(assistant_insert.data[0]["id"])

        yield _encode_sse_event(
            "assistant_complete",
            {"assistant_message_id": str(assistant_message_id)},
        )

        if generated_recipe is not None:
            yield _encode_sse_event(
                "generated_recipe_ready",
                {"generated_recipe": generated_recipe},
            )

        yield _encode_sse_event("done", {})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _stream_events(),
        media_type="text/event-stream",
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Phase 13.9 Slice F — Draft-anchored save endpoint
# (atomic via save_draft_riff_recipe RPC from migration 023)
# ---------------------------------------------------------------------------


@router.post(
    "/api/drafts/{draft_id}/riff/save",
    response_model=RiffSaveResponse,
)
def riff_draft_save_endpoint(
    draft_id: UUID,
    body: RiffSaveRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RiffSaveResponse:
    """Save a draft-anchored Riff-generated recipe to the user's cookbook
    atomically (Phase 13.9 Slice F).

    Locked contract: docs/capture-draft-riff-contract.md §3.1 (5-step
    atomic sequence) + §9.1 (save rules) + §3.4 (per-turn expiry).
    Mirrors recipe save (api/routes/recipes.py::riff_save_endpoint) for
    pre-validation; uses the atomic save_draft_riff_recipe RPC from
    migration 023 for the write side. Recipe insert, ingredient/step
    inserts, riff_sessions anchor migration, and recipe_drafts delete
    happen inside a single Postgres transaction per §3.1.

    Save is NOT a billable Riff turn — no enforce_riff_daily_cap, no
    record_riff_turn (matches recipe save).

    The "already-migrated" 409 path uses the bidirectional link from
    Slice F: recipes[session.source_recipe_id].riff_session_id ==
    session.id iff the recipe was created BY this session via the
    Slice F migration. Plain recipe-anchored sessions (created on
    /api/recipes/{X}/riff) do not satisfy this — their source recipe
    pre-existed and has riff_session_id NULL or pointing at a different
    session. Without this discriminator, the route would incorrectly
    return 409 with an unrelated recipe_id for plain recipe-anchored
    sessions.

    Errors:
        404  draft missing / not owned / expired (dict detail
             {code: DRAFT_NOT_FOUND | DRAFT_EXPIRED}); OR session
             missing / plain recipe-anchored / not anchored to this
             draft; OR message missing / cross-session (string detail)
        409  session already migrated to a recipe via Slice F save —
             idempotent retry. Detail body carries existing recipe_id
             so mobile (Slice G+) can navigate forward gracefully:
             {code: ALREADY_SAVED, recipe_id: <uuid>}
        422  generated_recipe absent OR ParsedRecipe re-validation fails
             (defense-in-depth — catches schema drift since extraction)
        500  storage failure or unknown RPC error
    """
    # 1. Validate session via user_db FIRST. RLS scopes to caller
    #    (cross-user -> empty result -> 404). Session state must be
    #    resolved BEFORE requiring the draft: a successful save deletes
    #    the draft, so a committed-then-timed-out retry arrives with the
    #    draft correctly gone. Requiring the draft first would turn that
    #    legitimate retry into DRAFT_NOT_FOUND instead of the 409
    #    ALREADY_SAVED contract the mobile hook translates to success.
    try:
        session_lookup = (
            user_db.table("riff_sessions")
            .select("id, source_recipe_id, source_draft_id")
            .eq("id", str(body.session_id))
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft save: session lookup failed: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail="Failed to load riff session"
        )
    if not session_lookup.data:
        raise HTTPException(
            status_code=404,
            detail=f"Riff session not found: {body.session_id}",
        )
    session_row = session_lookup.data[0]

    # 2a. source_draft_id IS NULL → discriminate via bidirectional link.
    #     If recipes[source_recipe_id].riff_session_id == session.id,
    #     this session was migrated FROM this draft via a prior Slice F
    #     save → idempotent retry → 409. Otherwise the session is plain
    #     recipe-anchored (Slice D recipe sync) and not a valid save
    #     target for this draft → 404.
    if session_row.get("source_draft_id") is None:
        existing_recipe_id = session_row.get("source_recipe_id")
        if existing_recipe_id is None:
            # Impossible per Slice A CHECK (num_nonnulls = 1) but defensive.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )

        try:
            recipe_lookup = (
                user_db.table("recipes")
                .select("id, riff_session_id")
                .eq("id", existing_recipe_id)
                .execute()
            )
        except Exception as e:
            logger.error(
                "Riff draft save: recipe lookup failed: %s",
                e,
                exc_info=True,
            )
            raise HTTPException(
                status_code=500, detail="Failed to verify save state"
            )
        if not recipe_lookup.data:
            # Defensive — FK should prevent dangling references.
            raise HTTPException(
                status_code=404,
                detail=f"Riff session not found: {body.session_id}",
            )
        recipe_row = recipe_lookup.data[0]

        if recipe_row.get("riff_session_id") == str(body.session_id):
            # Idempotent retry of a successful Slice F save (contract §9.1).
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "ALREADY_SAVED",
                    "recipe_id": existing_recipe_id,
                },
            )
        # Plain recipe-anchored session — not a valid save target for
        # this draft. Same 404 string as the other session-not-found paths.
        raise HTTPException(
            status_code=404,
            detail=f"Riff session not found: {body.session_id}",
        )

    # 2b. Cross-draft reject: session anchored to a DIFFERENT draft.
    if session_row.get("source_draft_id") != str(draft_id):
        raise HTTPException(
            status_code=404,
            detail=f"Riff session not found: {body.session_id}",
        )

    # 2c. Only a session that has NOT migrated requires an active draft.
    #     Ownership + expiry per §3.4 (Slice B helper).
    try:
        get_active_draft(draft_id, user_id=user_id, supabase=db)
    except DraftNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_NOT_FOUND",
                "message": f"Draft not found: {draft_id}",
            },
        )
    except DraftExpiredError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_EXPIRED",
                "message": f"Draft expired: {draft_id}",
            },
        )
    except StorageError as e:
        logger.error(
            "Riff draft save: draft load failed: %s", e, exc_info=True
        )
        raise HTTPException(status_code=500, detail="Failed to load draft")

    # 3. Validate message via user_db. RLS gates session ownership via
    #    the riff_messages_select EXISTS predicate. Cross-session
    #    rejected defensively — URL session_id is the source of truth.
    try:
        message_lookup = (
            user_db.table("riff_messages")
            .select("id, session_id, generated_recipe")
            .eq("id", str(body.message_id))
            .execute()
        )
    except Exception as e:
        logger.error(
            "Riff draft save: message lookup failed: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail="Failed to load riff message"
        )
    if not message_lookup.data:
        raise HTTPException(
            status_code=404,
            detail=f"Riff message not found: {body.message_id}",
        )
    message_row = message_lookup.data[0]
    if message_row.get("session_id") != str(body.session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Riff message not found: {body.message_id}",
        )

    # 4. generated_recipe presence + ParsedRecipe re-validation. Mirrors
    #    recipe save (api/routes/recipes.py:497-512) — defense-in-depth
    #    against schema drift between extraction time and save time.
    generated_recipe = message_row.get("generated_recipe")
    if generated_recipe is None:
        raise HTTPException(
            status_code=422,
            detail="No generated recipe available for this message",
        )
    try:
        ParsedRecipe.model_validate(generated_recipe)
    except ValidationError as e:
        logger.warning(
            "Riff draft save: generated_recipe re-validation failed: %s", e
        )
        raise HTTPException(
            status_code=422, detail="Generated recipe failed validation"
        )

    # 5. Atomic save via Slice F wrapper / RPC. The RPC re-validates
    #    inside the transaction (SELECT FOR UPDATE on the session) to
    #    close TOCTOU windows between the route's pre-checks and the
    #    actual writes. The RPC race path naturally only fires for
    #    legitimate Slice F migrations — source_draft_id can ONLY
    #    transition to NULL via Slice F (no UPDATE policy on
    #    riff_sessions; only this RPC has SECURITY DEFINER UPDATE
    #    access). So the RPC's "already_migrated" return is always a
    #    safe 409 with the migrated recipe_id.
    try:
        save_result = save_draft_riff(
            draft_id=draft_id,
            session_id=body.session_id,
            message_id=body.message_id,
            riff_label=body.riff_label,
            user_supabase=user_db,
            logger=logger,
        )
    except DraftExpiredError:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DRAFT_EXPIRED",
                "message": f"Draft expired: {draft_id}",
            },
        )
    except DraftNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Riff session not found: {body.session_id}",
        )
    except StorageError as e:
        if e.code == "GENERATED_RECIPE_MISSING":
            raise HTTPException(
                status_code=422,
                detail="No generated recipe available for this message",
            )
        logger.error(
            "Riff draft save: persist failed: %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=500, detail="Failed to save riff recipe"
        )

    # 6. Translate wrapper result to HTTP response.
    if save_result["status"] == "already_migrated":
        # Race: session migrated between route step 2 and RPC.
        # The wrapper surfaces the existing recipe_id; route returns 409.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ALREADY_SAVED",
                "recipe_id": save_result["recipe_id"],
            },
        )
    # status == "created"

    # 7. Bounded save-time step mapper + atomic attach (Issue 1). Strictly
    #    subordinate to recipe durability: any failure leaves the steps
    #    unknown (fallback) with the degradation recorded internally, and
    #    the response is still a normal success. Mirrors the recipe-
    #    anchored save (api/routes/recipes.py riff_save_endpoint step 6).
    #    Client/config acquisition sits INSIDE the soft boundary: a
    #    provider-setup failure after the committed base save must degrade
    #    to unknown mappings, never turn a durable save into an error.
    try:
        mapping = map_ingredients_to_steps(
            generated_recipe.get("ingredients") or [],
            generated_recipe.get("steps") or [],
            client=get_anthropic_client(),
            config=get_default_config(),
            logger=logger,
        )
    except Exception:
        logger.warning(
            "Riff draft save: step mapper setup failed", exc_info=True
        )
        mapping = None
    if mapping is None:
        mapping = [None] * len(generated_recipe.get("steps") or [])
    # Issue 3: the freshly saved recipe is at content_rev DEFAULT 1.
    apply_step_mapping(
        save_result["recipe_id"],
        mapping,
        expected_content_rev=1,
        supabase=db,
        logger=logger,
    )

    return RiffSaveResponse(recipe_id=UUID(save_result["recipe_id"]))
