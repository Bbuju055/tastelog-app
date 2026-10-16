"""
Tastelog: Draft API routes.

Endpoints for draft capture, review, confirm, and deletion.
"""

import logging
import os
import tempfile
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from supabase import Client

from api.core.anthropic_client import get_anthropic_client
from api.core.capture_wire import (
    provider_http_exception as _provider_http_exception,
    unreadable_http_exception as _unreadable_http_exception,
)
from api.core.config import get_settings
from api.core.drafts import confirm_draft, create_draft, delete_draft, get_draft, list_drafts
from api.core.exceptions import (
    DraftExpiredError,
    DraftNotFoundError,
    ImageProcessingError,
    ParsingError,
    ProviderError,
    StorageError,
    URLFetchError,
)
from api.core.parser import get_default_config, parse_recipe_image, parse_recipe_images
from api.core.recipes import get_recipe, upload_image
from api.core.step_mapping import (
    apply_step_mapping,
    canonicalize_parsed_recipe,
    compute_confirm_mappings,
    normalize_edited_ingredients,
)
from api.core.url_extractor import (
    DuplicateURLError,
    extract_recipe_from_url,
    find_existing_by_url,
    normalize_url,
)
from api.dependencies import get_current_user_id, get_db, get_user_id_jwt_or_capture_token, get_user_supabase
from api.models.draft import DraftConfirmRequest, DraftResponse
from api.models.recipe import RecipeDetailResponse

logger = logging.getLogger("tastelog.api.drafts")

# -----------------------------------------------------------------------------
# PROVIDER-S1 — stable machine-readable capture error contract.
# Wire table + exception builders live in api/core/capture_wire.py
# (15.3.S-CF1b: shared with the legacy token capture route). Provider
# failure logging stays here so this route's logger keeps owning it.
# -----------------------------------------------------------------------------


def _log_provider_failure(where: str, e: ProviderError) -> None:
    """Safe structured provider diagnostics — code, provider status,
    provider exception class, request id. Never bodies/keys/content."""
    logger.warning(
        "%s provider failure: code=%s provider_status=%s provider_type=%s request_id=%s",
        where,
        e.code,
        e.provider_status,
        e.provider_error_type,
        e.request_id,
    )


router = APIRouter(prefix="/api/drafts", tags=["drafts"])

PARSER_VERSION = "1.1"

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
}
MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20 MB cumulative across all files
MAX_IMAGES = 5

CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}

_BUCKET_RECIPE_IMAGES = "recipe-images"


def _get_suffix(content_type: str) -> str:
    return CONTENT_TYPE_EXTENSIONS.get(content_type, ".bin")


@router.get("", response_model=list[DraftResponse])
async def list_drafts_endpoint(
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> list[DraftResponse]:
    """List pending (non-expired) drafts for the current user, newest first."""
    drafts = list_drafts(user_id=user_id, supabase=db)
    return [DraftResponse.model_validate(d) for d in drafts]


class CaptureURLRequest(BaseModel):
    """Request body for URL-based recipe capture."""

    model_config = {"extra": "forbid"}

    url: str = Field(min_length=1)


def _validate_url(url: str) -> str:
    """Validate and normalize a URL. Returns normalized URL or raises HTTPException."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL — must start with http:// or https://")
    return normalize_url(url)


def _handle_url_capture(
    url: str,
    *,
    user_id: UUID,
    db: Client,
) -> DraftResponse:
    """Shared logic for URL capture (used by both capture-url and capture endpoints)."""
    normalized = _validate_url(url)

    # Duplicate check
    existing = find_existing_by_url(normalized, user_id=user_id, supabase=db, logger=logger)
    if existing:
        detail = {
            "detail": (
                "Recipe already saved"
                if existing["type"] == "recipe"
                else "Pending draft exists"
            ),
            f"{existing['type']}_id": existing["id"],
            "title": existing["title"],
        }
        raise HTTPException(status_code=409, detail=detail)

    # Extract recipe from URL
    settings = get_settings()
    anthropic_client = get_anthropic_client()
    parser_config = get_default_config()

    try:
        parsed = extract_recipe_from_url(
            url,
            client=anthropic_client,
            config=parser_config,
            logger=logger,
        )
    except URLFetchError as e:
        logger.warning(f"URL fetch failed: {e.code}: {e}")
        # The client supplied a URL we refuse to fetch; the upstream site did not fail.
        status = 400 if e.code in ("INVALID_URL", "BLOCKED_ADDRESS") else 502
        raise HTTPException(status_code=status, detail=str(e))
    except ProviderError as e:
        # PROVIDER-S1: provider-caused failure — honest service error,
        # no draft was created, retry is meaningful. Must precede
        # ParsingError (ProviderError subclasses it).
        _log_provider_failure("URL capture", e)
        raise _provider_http_exception(e)
    except ParsingError as e:
        # Residual content-level failure (e.g. NO_CONTENT: the page has
        # no recipe text) — evidence-based unreadable outcome.
        logger.warning(f"URL parsing failed: {e.code}")
        raise _unreadable_http_exception(
            "We couldn\u2019t find a recipe on this page."
        )

    # Create draft
    draft = create_draft(
        user_id=user_id,
        image_storage_keys=[],
        source_url=normalized,
        title=parsed["title"],
        servings=parsed.get("servings"),
        prep_time=parsed.get("prep_time"),
        cook_time=parsed.get("cook_time"),
        confidence_score=parsed.get("confidence", 0),
        ingredients=parsed.get("ingredients", []),
        steps=parsed.get("steps", []),
        raw_model_json=parsed,
        model_version=parser_config.model,
        parser_version=PARSER_VERSION,
        supabase=db,
        logger=logger,
    )

    return DraftResponse.model_validate(draft)


@router.post("/capture-url", response_model=DraftResponse)
async def capture_url_endpoint(
    body: CaptureURLRequest,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> DraftResponse:
    """Capture a recipe from a URL (JSON body, JWT auth)."""
    return _handle_url_capture(body.url, user_id=user_id, db=db)


@router.post("/capture", response_model=DraftResponse)
async def capture_draft_endpoint(
    image: list[UploadFile] = File(default=[], description="Recipe image(s), 1-5 files"),
    url: str | None = Form(default=None),
    user_id: UUID = Depends(get_user_id_jwt_or_capture_token),
    db: Client = Depends(get_db),
) -> DraftResponse:
    """Upload and parse recipe image(s), or capture from URL.

    Three cases:
    1. Images present (with or without URL): parse images, store URL as source_url if provided.
    2. URL only (no images): delegate to URL capture pipeline.
    3. Neither: 400 error.

    Accepts 1-5 images via repeated ``image`` form fields.
    Optional ``url`` form field for source attribution or URL-only capture.
    """
    # --- Determine capture path ---
    has_images = len(image) > 0

    # Case 3: Neither images nor URL
    if not has_images and not url:
        raise HTTPException(status_code=400, detail="Provide image(s) or a URL")

    # Case 2: URL only (no images) — delegate to shared URL capture logic
    if not has_images and url:
        return _handle_url_capture(url, user_id=user_id, db=db)

    # Case 1: Images present (with or without URL)
    # Normalize source_url if provided (D8: preserve URL alongside images)
    source_url: str | None = None
    if url and url.strip():
        try:
            source_url = _validate_url(url)
        except HTTPException:
            # Invalid URL alongside images: log but don't block image capture
            logger.warning(f"Invalid source URL ignored alongside images: {url!r}")

    # --- Image validation ---
    if len(image) > MAX_IMAGES:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_IMAGES} images per capture"
        )

    for f in image:
        if f.content_type not in ALLOWED_CONTENT_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid file type: {f.content_type}. Allowed: {sorted(ALLOWED_CONTENT_TYPES)}",
            )

    tmp_paths: list[str] = []
    storage_keys: list[str] = []

    try:
        # --- Read all files, enforce cumulative size limit ---
        max_per_file = 10 * 1024 * 1024  # 10 MB per file
        file_contents: list[tuple[bytes, str]] = []
        total_size = 0
        for f in image:
            content = await f.read()
            if len(content) > max_per_file:
                raise HTTPException(
                    status_code=413,
                    detail="One of the files exceeds 10 MB limit",
                )
            total_size += len(content)
            if total_size > MAX_UPLOAD_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail=f"Total upload size exceeds {MAX_UPLOAD_SIZE // (1024 * 1024)} MB",
                )
            assert f.content_type is not None  # validated above
            file_contents.append((content, f.content_type))

        # --- Write temp files + upload to storage ---
        for content, content_type in file_contents:
            suffix = _get_suffix(content_type)
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(content)
                tmp_paths.append(tmp.name)

            storage_key = upload_image(
                tmp_paths[-1],
                user_id=user_id,
                supabase=db,
                logger=logger,
            )
            storage_keys.append(storage_key)

        # --- Parse (single path for 1 or many images) ---
        settings = get_settings()
        anthropic_client = get_anthropic_client()
        parser_config = get_default_config()

        parsed = parse_recipe_images(
            tmp_paths,
            client=anthropic_client,
            config=parser_config,
            logger=logger,
        )

        # Issue 1: split per-step mapping into raw_model_json's canonical
        # key; recipe_drafts.steps keeps the OLD rollback-safe shape.
        parsed = canonicalize_parsed_recipe(parsed)

        # --- Create draft (with source_url if URL was provided alongside images) ---
        draft = create_draft(
            user_id=user_id,
            image_storage_keys=storage_keys,
            source_url=source_url,
            title=parsed["title"],
            servings=parsed.get("servings"),
            prep_time=parsed.get("prep_time"),
            cook_time=parsed.get("cook_time"),
            confidence_score=parsed.get("confidence", 0),
            ingredients=parsed.get("ingredients", []),
            steps=parsed.get("steps", []),
            raw_model_json=parsed,
            model_version=parser_config.model,
            parser_version=PARSER_VERSION,
            supabase=db,
            logger=logger,
        )

        return DraftResponse.model_validate(draft)

    except ProviderError as e:
        # PROVIDER-S1: provider-caused failure — honest service error.
        # Must precede ParsingError (ProviderError subclasses it).
        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        _log_provider_failure("Capture", e)
        raise _provider_http_exception(e)
    except ImageProcessingError as e:
        # Evidence-based content-level failure: the uploaded image itself
        # could not be decoded/processed — the one case where "try a
        # clearer photo" guidance is honest.
        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        logger.warning(f"Capture failed: unreadable image ({e.code})")
        raise _unreadable_http_exception(
            "We couldn\u2019t read a recipe from this image."
        )
    except ParsingError as e:
        # Residual parse-layer failure that is neither typed provider nor
        # image-level. PROVIDER-S1 converts all known sites to those two
        # classes; anything left is provider-output machinery — never
        # blamed on the user's content.
        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        logger.warning(f"Capture failed: residual parse error ({e.code})")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "RECIPE_PROVIDER_BAD_RESPONSE",
                "message": "Recipe capture received an unusable response.",
            },
        )
    except StorageError as e:
        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        logger.error(f"Capture storage failed: {e.code}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
    except HTTPException:
        raise
    except Exception as e:
        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        logger.exception(f"Capture unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
    finally:
        for p in tmp_paths:
            if os.path.exists(p):
                os.unlink(p)


@router.get("/{draft_id}", response_model=DraftResponse)
async def get_draft_endpoint(
    draft_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> DraftResponse:
    """Get a draft by ID for review."""
    try:
        draft = get_draft(draft_id, user_id=user_id, supabase=db)
        return DraftResponse.model_validate(draft)
    except DraftNotFoundError:
        raise HTTPException(status_code=404, detail="Draft not found")
    except StorageError as e:
        logger.error(f"Get draft failed: {e.code}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{draft_id}/confirm", response_model=RecipeDetailResponse)
async def confirm_draft_endpoint(
    draft_id: UUID,
    body: DraftConfirmRequest | None = None,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
    user_db: Client = Depends(get_user_supabase),
) -> RecipeDetailResponse:
    """Confirm draft and commit to recipes table."""
    try:
        # Issue 1: the draft row (raw_model_json) is the ONLY mapping
        # authority; load it before the RPC deletes the draft. Client
        # payloads never carry mapping data.
        draft_row = get_draft(draft_id, user_id=user_id, supabase=db)

        overrides = {}
        if body:
            if body.title is not None:
                overrides["title"] = body.title
            if body.servings is not None:
                overrides["servings"] = body.servings
            if body.prep_time is not None:
                overrides["prep_time"] = body.prep_time
            if body.cook_time is not None:
                overrides["cook_time"] = body.cook_time
            if body.ingredients is not None:
                # Truthful normalization: a raw_text-only edit must not
                # keep stale structured quantity/unit/name/prep values
                # that no longer describe the edited text.
                overrides["ingredients"] = normalize_edited_ingredients(
                    draft_row.get("ingredients") or [],
                    [ing.model_dump() for ing in body.ingredients],
                )
            if body.steps is not None:
                overrides["steps"] = [step.model_dump() for step in body.steps]

        # Server-side semantic comparison decides which original mappings
        # survive the user's edits (None = legacy draft, skip attach).
        surviving_mappings = compute_confirm_mappings(
            draft_row,
            overrides.get("ingredients"),
            overrides.get("steps"),
        )

        rpc_result = confirm_draft(
            draft_id,
            user_supabase=user_db,
            logger=logger,
            **overrides,
        )

        if isinstance(rpc_result, list):
            rpc_result = rpc_result[0] if rpc_result else {}

        recipe_id = rpc_result.get("recipe_id")
        if not recipe_id:
            raise StorageError("Confirm did not return recipe_id", code="RPC_FAILED")

        # Atomic attach of the surviving mapping (soft: a failure leaves the
        # steps unknown and records a degraded outcome, never fails the
        # confirm).
        if surviving_mappings is not None:
            # Issue 3: the freshly confirmed recipe is at content_rev
            # DEFAULT 1.
            apply_step_mapping(
                recipe_id,
                surviving_mappings,
                expected_content_rev=1,
                supabase=db,
                logger=logger,
            )

        recipe_data = get_recipe(UUID(recipe_id), user_id=user_id, supabase=db)

        return RecipeDetailResponse.model_validate(recipe_data)

    except DraftNotFoundError:
        raise HTTPException(status_code=404, detail="Draft not found")
    except DraftExpiredError:
        raise HTTPException(status_code=410, detail="Draft has expired")
    except StorageError as e:
        logger.error(f"Confirm draft failed: {e.code}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/{draft_id}", status_code=204)
async def delete_draft_endpoint(
    draft_id: UUID,
    user_id: UUID = Depends(get_current_user_id),
    db: Client = Depends(get_db),
) -> None:
    """Delete a draft and its associated storage object."""
    try:
        storage_keys = delete_draft(
            draft_id,
            user_id=user_id,
            supabase=db,
            logger=logger,
        )

        if storage_keys:
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception as e:
                logger.warning(f"Failed to delete storage objects {storage_keys}: {e}")

    except DraftNotFoundError:
        raise HTTPException(status_code=404, detail="Draft not found")
    except StorageError as e:
        logger.error(f"Delete draft failed: {e.code}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
