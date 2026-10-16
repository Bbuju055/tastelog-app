"""
Tastelog: Recipe API routes.

Endpoints for recipe capture, retrieval, search, and deletion.
"""

import logging
import os
import tempfile
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import ValidationError
from supabase import Client

from api.core.anthropic_client import get_anthropic_client
from api.core.capture_wire import (
    provider_http_exception,
    unreadable_http_exception,
)
from api.core.config import get_settings
from api.core.exceptions import (
    ImageProcessingError,
    ParsingError,
    ProviderError,
    RecipeNotFoundError,
    StorageError,
)
from api.core.idempotency import (
    IdempotencyConflictError,
    IdempotencyServiceError,
    check_idempotency,
    hash_image_bytes,
    store_idempotency,
)
from api.core.parser import ParsedRecipe, get_default_config
from api.core.recipes import (
    ContentValidationError,
    EditConflictError,
    capture_recipe,
    delete_recipe,
    get_recipe,
    replace_recipe_tags,
    save_riff_recipe_atomic,
    update_recipe_content,
    update_recipe_favorite,
)
from api.core.search import list_recipes, search_recipes
from api.core.step_mapping import apply_step_mapping, map_ingredients_to_steps
from api.core.token_auth import (
    InvalidTokenError,
    RateLimitExceededError,
    RateLimitUnavailableError,
    check_and_record_rate_limit,
    hash_token,
    parse_bearer_token,
    update_last_used,
    verify_capture_token,
)
from api.dependencies import get_current_user_id, get_db, get_user_db
from api.models.capture_response import CaptureResponse
from api.models.recipe import (
    RecipeContentUpdateRequest,
    RecipeDetailResponse,
    RecipeFavoriteUpdateRequest,
    RecipeSearchResult,
    RecipeTagsUpdateRequest,
)
from api.models.riff import RiffSaveRequest, RiffSaveResponse

logger = logging.getLogger("tastelog.api.recipes")

router = APIRouter(prefix="/api/recipes", tags=["recipes"])

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
}
MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10MB

CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}


def _get_suffix(content_type: str) -> str:
    """Get file extension for content type."""
    return CONTENT_TYPE_EXTENSIONS.get(content_type, ".bin")


@router.get("/search", response_model=list[RecipeSearchResult])
async def search_recipes_endpoint(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(default=10, ge=1, le=50, description="Max results"),
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[RecipeSearchResult]:
    """Search recipes by title and ingredients."""
    try:
        results = search_recipes(
            q,
            user_id=user_id,
            supabase=db,
            logger=logger,
            limit=limit,
        )
        return [RecipeSearchResult.model_validate(r) for r in results]
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("", response_model=list[RecipeSearchResult])
async def list_recipes_endpoint(
    limit: int = Query(default=50, ge=1, le=100, description="Max results"),
    offset: int = Query(default=0, ge=0, description="Pagination offset"),
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[RecipeSearchResult]:
    """List all recipes for the current user."""
    try:
        results = list_recipes(
            user_id=user_id,
            supabase=db,
            limit=limit,
            offset=offset,
        )
        return [RecipeSearchResult.model_validate(r) for r in results]
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/capture", response_model=CaptureResponse)
def capture_recipe_endpoint(
    image: UploadFile = File(..., description="Recipe image or PDF"),
    source: Literal["web", "shortcuts", "mobile_app", "share_extension"] = "web",
    authorization: str | None = Header(default=None, alias="Authorization"),
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=100),
    db: Client = Depends(get_db),
) -> CaptureResponse:
    """Upload and parse a recipe image.

    Auth: Capture token ONLY (Bearer tl_cap_...). Supabase JWTs are NOT accepted.
    Requires Idempotency-Key header (UUID recommended).

    Accepts JPEG, PNG, GIF, WEBP images or PDF files (max 10MB).
    Returns capture status with view URL.
    """
    # 1. Authenticate via capture token
    token = parse_bearer_token(authorization)
    if token is None:
        raise HTTPException(
            status_code=401,
            detail="Capture token required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        token_record = verify_capture_token(token, supabase=db)
    except InvalidTokenError as e:
        raise HTTPException(
            status_code=401,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Compute token_hash from plaintext (decoupled from DB record shape)
    token_hash = hash_token(token)

    # Sentry: tag capture source (never blocks capture flow).
    try:
        import sentry_sdk

        sentry_sdk.set_tag("capture.source", source)
    except Exception:
        pass

    # 2. Validate Idempotency-Key
    idempotency_key = idempotency_key.strip()
    if not idempotency_key or any(c in idempotency_key for c in [" ", "\n", "\r", "\t"]):
        raise HTTPException(
            status_code=400,
            detail="Invalid Idempotency-Key: must be non-empty with no whitespace",
        )

    # 3. Read and validate file
    if image.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{image.content_type}'. Allowed: {sorted(ALLOWED_CONTENT_TYPES)}",
        )

    try:
        content = image.file.read()
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to read uploaded file")

    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024 * 1024)}MB",
        )

    # 4. Compute payload hash
    payload_hash = hash_image_bytes(content)

    # 5. Idempotency check (BEFORE rate limiting - retries must not 429)
    try:
        cached_response = check_idempotency(
            token_record.id,
            idempotency_key,
            payload_hash,
            supabase=db,
        )
        if cached_response is not None:
            update_last_used(token_record.id, supabase=db)
            return CaptureResponse.model_validate(cached_response)
    except IdempotencyConflictError:
        raise HTTPException(
            status_code=409,
            detail="Idempotency key already used with different payload",
        )
    except IdempotencyServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # 6. Rate limit check (only for new requests, not retries)
    try:
        check_and_record_rate_limit(token_hash, supabase=db)
    except RateLimitExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except RateLimitUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # 7. Generate capture_id
    capture_id = uuid4()

    # 8. Process capture
    tmp_path = None
    try:
        suffix = _get_suffix(image.content_type)
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        settings = get_settings()
        anthropic_client = get_anthropic_client()
        parser_config = get_default_config()

        # TODO: Persist source to captures table when async processing is implemented
        logger.info(
            "capture_request_started",
            extra={
                "capture_id": str(capture_id),
                "source": source,
                "token_id": str(token_record.id),
                "content_type": image.content_type,
                "content_size": len(content),
                "idempotency_key_prefix": idempotency_key[:8],
            },
        )

        recipe = capture_recipe(
            tmp_path,
            user_id=token_record.user_id,
            supabase=db,
            anthropic_client=anthropic_client,
            parser_config=parser_config,
            logger=logger,
        )

        recipe_id = UUID(recipe["id"])

        # 9. Build response
        response = CaptureResponse(
            capture_id=capture_id,
            recipe_id=recipe_id,
            status="complete",
            view_url=f"/recipes/{recipe_id}",
        )

        # 10. Store idempotency (FAIL-CLOSED)
        try:
            store_idempotency(
                token_record.id,
                idempotency_key,
                payload_hash,
                response.model_dump(mode="json"),
                supabase=db,
            )
        except IdempotencyServiceError:
            # Capture may have succeeded; idempotency persistence failed.
            # Client must retry with same Idempotency-Key.
            # Duplicates are possible until persistence succeeds.
            logger.error(
                "idempotency_store_failed",
                extra={
                    "capture_id": str(capture_id),
                    "token_id": str(token_record.id),
                    "idempotency_key_prefix": idempotency_key[:8],
                    "payload_hash_prefix": payload_hash[:16],
                },
            )
            raise HTTPException(
                status_code=503,
                detail="Failed to complete request. Please retry with same Idempotency-Key.",
            )

        # 11. Update last_used_at (best-effort)
        update_last_used(token_record.id, supabase=db)

        return response

    except ProviderError as e:
        # PROVIDER-S1 (15.3.S-CF1b): provider-caused failure is an honest
        # service error, never blamed on the user's content. Must precede
        # ParsingError (ProviderError subclasses it). capture_recipe()
        # compensation already removed any partial side effects.
        logger.warning(
            "Capture provider failure: code=%s provider_status=%s provider_type=%s request_id=%s",
            e.code,
            e.provider_status,
            e.provider_error_type,
            e.request_id,
        )
        raise provider_http_exception(e)
    except ImageProcessingError as e:
        # Evidence-based content-level failure: the uploaded image itself
        # could not be decoded/processed.
        logger.warning(f"Capture failed: unreadable image ({e.code})")
        raise unreadable_http_exception(
            "We couldn\u2019t read a recipe from this image."
        )
    except ParsingError as e:
        # Residual parse-layer failure that is neither typed provider nor
        # image-level: provider-output machinery, never blamed on the
        # user's content.
        logger.warning(f"Capture failed: residual parse error ({e.code})")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "RECIPE_PROVIDER_BAD_RESPONSE",
                "message": "Recipe capture received an unusable response.",
            },
        )
    except StorageError as e:
        if e.code in {
            "UNKNOWN_FILE_TYPE",
            "UNSUPPORTED_FILE_TYPE",
            "UNKNOWN_FILE_EXTENSION",
        }:
            # Content-derived: the declared MIME passed route validation but
            # the actual bytes are not a readable supported file. Retrying
            # the same file will fail again; never promise a retry.
            logger.warning(f"Capture failed: undecodable upload ({e.code})")
            raise unreadable_http_exception(
                "We couldn\u2019t read a recipe from this image."
            )
        # Storage/DB infra failure. capture_recipe() compensation already
        # attempted cleanup and no idempotency record was stored, so a
        # same-key retry is the designed recovery. Fixed copy only:
        # str(e) can embed internals.
        logger.error(f"Capture storage failed: {e.code}: {e}")
        raise HTTPException(
            status_code=503,
            detail="Recipe capture failed before completion. Retry with the same Idempotency-Key.",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Capture unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@router.get("/{recipe_id}", response_model=RecipeDetailResponse)
async def get_recipe_endpoint(
    recipe_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> RecipeDetailResponse:
    """Get a recipe by ID with ingredients and steps."""
    try:
        recipe_data = get_recipe(recipe_id, user_id=user_id, supabase=db)
        return RecipeDetailResponse.model_validate(recipe_data)
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{recipe_id}", response_model=RecipeDetailResponse)
def update_recipe_content_endpoint(
    recipe_id: UUID,
    body: RecipeContentUpdateRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RecipeDetailResponse:
    """Edit saved recipe content via explicit operations (Issue 3).

    Optimistic two-phase save: coherent snapshot + fail-fast checks,
    bounded mapping work outside any DB transaction, then a short atomic
    commit RPC (CAS on content_rev). The mutation itself runs service-role
    (the RPC checks ownership explicitly); the user-scoped client is
    acquired per the tags-route precedent so the JWT is fully validated.

    Errors (fixed copy only, CF-LEAK1 discipline, no str(e)):
        404  recipe missing, not owned, or externally deleted
        409  {code: "EDIT_CONFLICT"}, content changed since it was read
        422  operation payload failed validation (zero mutation)
        500  infrastructure failure
    """
    del user_db  # acquired for JWT validation only; mutation is service-role
    try:
        recipe_data = update_recipe_content(
            recipe_id,
            user_id=user_id,
            body=body,
            supabase=db,
            logger=logger,
        )
        return RecipeDetailResponse.model_validate(recipe_data)
    except RecipeNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"Recipe not found: {recipe_id}"
        )
    except EditConflictError:
        raise HTTPException(
            status_code=409, detail={"code": "EDIT_CONFLICT"}
        )
    except ContentValidationError:
        raise HTTPException(
            status_code=422, detail="Recipe content operations failed validation"
        )
    except StorageError as e:
        logger.error("Recipe content update failed: %s", e.code)
        raise HTTPException(status_code=500, detail="Failed to update recipe")


@router.patch("/{recipe_id}/favorite", response_model=RecipeDetailResponse)
async def update_recipe_favorite_endpoint(
    recipe_id: UUID,
    body: RecipeFavoriteUpdateRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> RecipeDetailResponse:
    """Update the favorite status of a recipe."""
    try:
        recipe_data = update_recipe_favorite(
            recipe_id,
            favorite=body.favorite,
            user_id=user_id,
            supabase=db,
        )
        return RecipeDetailResponse.model_validate(recipe_data)
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{recipe_id}/tags", response_model=RecipeDetailResponse)
async def update_recipe_tags_endpoint(
    recipe_id: UUID,
    body: RecipeTagsUpdateRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RecipeDetailResponse:
    """Replace all tags for a recipe (set semantics)."""
    try:
        recipe_data = replace_recipe_tags(
            recipe_id,
            tags=body.tags,
            user_id=user_id,
            rpc_supabase=user_db,
            supabase=db,
        )
        return RecipeDetailResponse.model_validate(recipe_data)
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{recipe_id}", status_code=204)
async def delete_recipe_endpoint(
    recipe_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> None:
    """Delete a recipe and its associated data."""
    try:
        delete_recipe(
            recipe_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
        )
    except RecipeNotFoundError:
        raise HTTPException(status_code=404, detail=f"Recipe not found: {recipe_id}")
    except StorageError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{recipe_id}/riff/save", response_model=RiffSaveResponse)
def riff_save_endpoint(
    recipe_id: UUID,
    body: RiffSaveRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_db),
) -> RiffSaveResponse:
    """Save a riff-generated recipe to the user's cookbook (Phase 13.2).

    The recipe text comes from a specific assistant message in a riff
    session anchored to {recipe_id}. The message must already have a
    populated `generated_recipe` JSONB (set at turn time by the /riff
    endpoint).

    Errors:
        404  recipe / session / message not found, not owned, or message
             does not belong to the named session
        409  session does not belong to the named recipe
        422  generated_recipe absent OR re-validation through
             ParsedRecipe.model_validate() failed
        500  insert failure
    """
    # 1. Validate recipe ownership. Reuses the canonical loader for
    #    consistency with the /riff endpoint. RecipeNotFoundError covers
    #    the cross-user / missing cases.
    try:
        get_recipe(recipe_id, user_id=user_id, supabase=db)
    except RecipeNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Recipe not found: {recipe_id}",
        )
    except StorageError as e:
        logger.error("Riff save: recipe load failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load recipe")

    # 2. Load session via user_db (RLS filters by user). 404 on missing or
    #    not-owned; 409 on recipe mismatch — the URL recipe_id is the truth.
    try:
        session_lookup = (
            user_db.table("riff_sessions")
            .select("id, source_recipe_id")
            .eq("id", str(body.session_id))
            .execute()
        )
    except Exception as e:
        logger.error("Riff save: session lookup failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load riff session")
    if not session_lookup.data:
        raise HTTPException(
            status_code=404,
            detail=f"Riff session not found: {body.session_id}",
        )
    session_row = session_lookup.data[0]
    if session_row.get("source_recipe_id") != str(recipe_id):
        raise HTTPException(
            status_code=409,
            detail="Riff session does not belong to this recipe",
        )

    # 3. Load message via user_db (RLS via session ownership in the
    #    riff_messages_select policy). 404 on missing or not-owned; 404
    #    if the message belongs to a different session (defensive — do
    #    not leak existence across sessions).
    try:
        message_lookup = (
            user_db.table("riff_messages")
            .select("id, session_id, generated_recipe")
            .eq("id", str(body.message_id))
            .execute()
        )
    except Exception as e:
        logger.error("Riff save: message lookup failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load riff message")
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

    # 4. generated_recipe presence + canonical re-validation through
    #    ParsedRecipe.model_validate() (defense-in-depth — also catches
    #    schema drift if validation logic changed since extraction).
    generated_recipe = message_row.get("generated_recipe")
    if generated_recipe is None:
        raise HTTPException(
            status_code=422,
            detail="No generated recipe available for this message",
        )
    try:
        validated = ParsedRecipe.model_validate(generated_recipe)
    except ValidationError as e:
        logger.warning("Riff save: re-validation failed: %s", e)
        raise HTTPException(
            status_code=422,
            detail="Generated recipe failed validation",
        )

    # 5. Persist atomically + idempotently (Issue 1): the
    #    save_riff_recipe_atomic RPC commits recipe + ingredients + steps
    #    in one transaction, keyed on recipes.source_riff_message_id so a
    #    retry after an ambiguous timeout resolves to the existing recipe.
    try:
        save_result = save_riff_recipe_atomic(
            recipe_id,
            body.session_id,
            body.message_id,
            body.riff_label,
            user_supabase=user_db,
            logger=logger,
        )
    except RecipeNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Riff message not found: {body.message_id}",
        )
    except StorageError as e:
        logger.error("Riff save: persist failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save riff recipe")

    if save_result["status"] == "already_saved":
        # Idempotent retry: mirror the draft-anchored save's contract so
        # mobile translates this to graceful success.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ALREADY_SAVED",
                "recipe_id": save_result["recipe_id"],
            },
        )

    new_recipe_id = save_result["recipe_id"]

    # 6. Bounded save-time step mapper + atomic attach (Issue 1). Strictly
    #    subordinate to recipe durability: any failure leaves the steps
    #    unknown (fallback) with the degradation recorded internally, and
    #    the response is still a normal success.
    #    Client/config acquisition sits INSIDE the soft boundary: a
    #    provider-setup failure after the committed base save must degrade
    #    to unknown mappings, never turn a durable save into an error.
    parsed = validated.model_dump()
    try:
        mapping = map_ingredients_to_steps(
            parsed.get("ingredients") or [],
            parsed.get("steps") or [],
            client=get_anthropic_client(),
            config=get_default_config(),
            logger=logger,
        )
    except Exception:
        logger.warning("Riff save: step mapper setup failed", exc_info=True)
        mapping = None
    if mapping is None:
        mapping = [None] * len(parsed.get("steps") or [])
    # Issue 3: the freshly saved recipe is at content_rev DEFAULT 1.
    apply_step_mapping(
        new_recipe_id,
        mapping,
        expected_content_rev=1,
        supabase=db,
        logger=logger,
    )

    return RiffSaveResponse(recipe_id=UUID(new_recipe_id))
