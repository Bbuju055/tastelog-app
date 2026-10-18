"""
Tastelog: Draft API routes.

Endpoints for draft capture, review, confirm, and deletion.
"""

import logging
import os
import tempfile
from uuid import UUID, uuid4

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field
from supabase import Client

from api.core.anthropic_client import get_anthropic_client
from api.core.capture_wire import (
    provider_http_exception as _provider_http_exception,
    unreadable_http_exception as _unreadable_http_exception,
)
from api.core.config import get_settings
from api.core.draft_idempotency import (
    IdempotencyInProgressError,
    InvalidIdempotencyKeyError,
    clean_idempotency_key,
    complete_draft_capture,
    hash_capture_payload,
    release_draft_capture,
    reserve_draft_capture,
)
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
from api.core.idempotency import IdempotencyConflictError, IdempotencyServiceError
from api.core.parser import get_default_config, parse_recipe_image, parse_recipe_images
from api.core.recipes import get_recipe, upload_image
from api.core.token_auth import (
    RateLimitExceededError,
    RateLimitUnavailableError,
    check_and_record_rate_limit,
)
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
    try:
        return normalize_url(url)
    except ValueError:  # malformed IPv6 brackets or port
        raise HTTPException(status_code=400, detail="Invalid URL")


def _enforce_capture_rate_limit(user_id: UUID, db: Client) -> None:
    """Per-user sliding window shared by both draft capture routes.

    Reuses the capture-token limiter and its table; the key column is
    ``token_hash`` but it is free text, so the key here is ``user:<uuid>``.
    """
    try:
        check_and_record_rate_limit(f"user:{user_id}", supabase=db)
    except RateLimitExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except RateLimitUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))


# Optional on both draft capture routes until every client sends it; a client
# that omits it gets today's non-idempotent behaviour unchanged.
_IDEMPOTENCY_HEADER = Header(default=None, alias="Idempotency-Key", max_length=100)

# A retry with the same key while the first attempt is still running: tell
# the client when to come back rather than making it guess.
_IN_PROGRESS_RETRY_AFTER_SECONDS = "5"


@dataclass
class _CaptureAttempt:
    """What the capture work got as far as, for deciding whether a failed
    attempt may have left a draft behind.

    insert_attempted: create_draft was called. Until the database answers,
        the row may or may not have committed.
    insert_rejected: the database answered with a code that proves the row
        was refused and rolled back (see _insert_definitely_rejected).
    """

    insert_attempted: bool = False
    insert_rejected: bool = False


# SQLSTATE classes that prove Postgres refused the statement and rolled it
# back, so no row can exist: 22 (data), 23 (integrity), 42 (syntax / access
# rule), 40 (transaction rollback), 0A (unsupported), 53/54 (resource / limit),
# P0 (PL/pgSQL RAISE). Nothing else counts: PostgREST's own PGRSTxxx codes can
# be produced after the transaction committed (e.g. PGRST111/112 while building
# the response), gateway 5xx bodies, connection errors, malformed responses,
# 08xxx, 57xxx and XXxxx all leave the outcome unknown.
_REJECTED_SQLSTATE_CLASSES = ("22", "23", "42", "40", "0A", "53", "54", "P0")


def _insert_definitely_rejected(cause: BaseException | None) -> bool:
    if not isinstance(cause, APIError) or not isinstance(cause.code, str):
        return False
    code = cause.code.strip().upper()
    return len(code) == 5 and code[:2] in _REJECTED_SQLSTATE_CLASSES


def _create_draft_tracked(attempt: _CaptureAttempt, **kwargs) -> dict:
    """create_draft, recording on ``attempt`` whether a failure is a confirmed
    rejection or an unknown outcome (timeout, lost connection, gateway error)."""
    attempt.insert_attempted = True
    try:
        return create_draft(**kwargs)
    except StorageError as e:
        attempt.insert_rejected = _insert_definitely_rejected(e.__cause__)
        raise


def _committed_draft(user_id: UUID, draft_id: UUID, db: Client) -> dict | None:
    """The reserved draft's row if it is visible now, else None (not found, or
    the database could not be asked; both mean "not visible")."""
    try:
        return get_draft(draft_id, user_id=user_id, supabase=db)
    except DraftNotFoundError:
        return None
    except Exception as e:  # StorageError or anything else from the client
        logger.error(f"Idempotency post-failure draft check failed: {type(e).__name__}")
        return None


def _clean_idempotency_header(raw: str | None) -> str | None:
    if raw is None:
        return None
    try:
        return clean_idempotency_key(raw)
    except InvalidIdempotencyKeyError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _run_idempotent(
    *,
    user_id: UUID,
    idempotency_key: str | None,
    payload_hash: str,
    db: Client,
    work: Callable[[UUID, _CaptureAttempt], DraftResponse],
) -> DraftResponse:
    """Run ``work(draft_id, attempt)`` once per (user, key, payload); replay afterwards.

    The draft id is minted here and the work must create the draft under it,
    through _create_draft_tracked so ``attempt`` records how far it got.
    Without a key the work simply runs. With one, the key is reserved
    atomically first (migration 028) and the reservation records the draft
    id: a replay returns the recorded response without running the work or
    the rate limiter; a holder that wrote its draft but never completed is
    recovered by returning that exact draft; a concurrent holder is 409; a
    different payload under the same key is 409.

    A failure of the work releases this request's own reservation only when
    no draft can exist: the failure came before the insert, or the database
    rejected the insert. An insert with an unknown outcome (timeout, lost
    connection) keeps the reservation: if the row is already visible it is
    returned as the result; if not, it may still commit, and a retry then
    finds it through the recover path instead of creating a second draft.
    A failure to complete never releases either.
    """
    draft_id = uuid4()
    attempt = _CaptureAttempt()
    if idempotency_key is None:
        return work(draft_id, attempt)

    log_extra = {"user_id": str(user_id), "idempotency_key_prefix": idempotency_key[:8]}
    try:
        reservation = reserve_draft_capture(
            user_id, idempotency_key, payload_hash, draft_id, supabase=db
        )
    except IdempotencyInProgressError as e:
        raise HTTPException(
            status_code=409,
            detail={"code": e.code, "message": str(e)},
            headers={"Retry-After": _IN_PROGRESS_RETRY_AFTER_SECONDS},
        )
    except IdempotencyConflictError as e:
        raise HTTPException(status_code=409, detail={"code": e.code, "message": str(e)})
    except IdempotencyServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))

    if reservation.outcome == "replay":
        assert reservation.response is not None  # guaranteed by the helper
        return DraftResponse.model_validate(reservation.response)
    if reservation.outcome == "recover":
        assert reservation.draft_id is not None  # guaranteed by the helper
        try:
            draft = get_draft(reservation.draft_id, user_id=user_id, supabase=db)
        except DraftNotFoundError:
            # Existed when the RPC looked, gone now (the user deleted it).
            # This key can neither recover nor be reused; a new capture
            # is a new attempt with a new key.
            raise HTTPException(
                status_code=404,
                detail="The draft created by this Idempotency-Key no longer exists",
            )
        except StorageError as e:
            logger.error(f"Idempotency recover read failed: {e.code}: {e}")
            raise HTTPException(status_code=500, detail="Internal server error")
        return DraftResponse.model_validate(draft)

    try:
        response = work(draft_id, attempt)
    except BaseException:
        if not attempt.insert_attempted or attempt.insert_rejected:
            # No draft can exist: free the key for the client's retry.
            try:
                release_draft_capture(user_id, idempotency_key, draft_id, supabase=db)
            except IdempotencyServiceError:
                # Stays pending until it expires; a retry of this key gets
                # 409 meanwhile. Nothing was created, nothing is duplicated.
                logger.error("draft_idempotency_release_failed", extra=log_extra)
            raise
        # The insert's outcome is unknown: the statement may still commit
        # after a timeout, so the reservation is kept whatever the lookup
        # says. If the row is already visible the capture succeeded as far
        # as the client is concerned: hand it back and record it.
        committed = _committed_draft(user_id, draft_id, db)
        if committed is None:
            logger.error("draft_idempotency_insert_outcome_unknown", extra=log_extra)
            raise
        logger.warning("draft_idempotency_recovered_after_failure", extra=log_extra)
        response = DraftResponse.model_validate(committed)

    try:
        completed = complete_draft_capture(
            user_id, idempotency_key, draft_id, response.model_dump(mode="json"), supabase=db
        )
    except IdempotencyServiceError:
        # The draft exists and the client gets it. The row stays pending with
        # the draft id, so a retry recovers this same draft instead of
        # creating another; replay just costs one extra read.
        logger.error("draft_idempotency_complete_failed", extra=log_extra)
    else:
        if not completed:
            # Our pending row is gone (expired mid-capture). The draft still
            # exists and is returned; a retry past expiry is a new attempt.
            logger.warning("draft_idempotency_complete_no_row", extra=log_extra)
    return response


def _handle_url_capture(
    url: str,
    *,
    user_id: UUID,
    db: Client,
    idempotency_key: str | None = None,
) -> DraftResponse:
    """Shared logic for URL capture (used by both capture-url and capture endpoints)."""
    normalized = _validate_url(url)
    return _run_idempotent(
        user_id=user_id,
        idempotency_key=idempotency_key,
        payload_hash=hash_capture_payload([normalized.encode("utf-8")]),
        db=db,
        work=lambda draft_id, attempt: _capture_url(
            url, normalized, user_id=user_id, db=db, draft_id=draft_id, attempt=attempt
        ),
    )


def _capture_url(
    url: str,
    normalized: str,
    *,
    user_id: UUID,
    db: Client,
    draft_id: UUID,
    attempt: _CaptureAttempt,
) -> DraftResponse:
    """URL capture proper: limit, duplicate check, extract, create the draft.

    ``normalized`` is used for the duplicate check and as the draft's
    source_url; the extractor receives the URL as given, as before.
    """
    _enforce_capture_rate_limit(user_id, db)

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
    draft = _create_draft_tracked(
        attempt,
        draft_id=draft_id,
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
    idempotency_key: str | None = _IDEMPOTENCY_HEADER,
) -> DraftResponse:
    """Capture a recipe from a URL (JSON body, JWT auth).

    Optional ``Idempotency-Key`` header: a retry with the same key and URL
    returns the same draft instead of creating another.
    """
    return _handle_url_capture(
        body.url,
        user_id=user_id,
        db=db,
        idempotency_key=_clean_idempotency_header(idempotency_key),
    )


@router.post("/capture", response_model=DraftResponse)
async def capture_draft_endpoint(
    image: list[UploadFile] = File(default=[], description="Recipe image(s), 1-5 files"),
    url: str | None = Form(default=None),
    user_id: UUID = Depends(get_user_id_jwt_or_capture_token),
    db: Client = Depends(get_db),
    idempotency_key: str | None = _IDEMPOTENCY_HEADER,
) -> DraftResponse:
    """Upload and parse recipe image(s), or capture from URL.

    Three cases:
    1. Images present (with or without URL): parse images, store URL as source_url if provided.
    2. URL only (no images): delegate to URL capture pipeline.
    3. Neither: 400 error.

    Accepts 1-5 images via repeated ``image`` form fields.
    Optional ``url`` form field for source attribution or URL-only capture.
    Optional ``Idempotency-Key`` header: a retry with the same key and the
    same files + URL returns the same draft instead of creating another.
    """
    idempotency_key = _clean_idempotency_header(idempotency_key)

    # --- Determine capture path ---
    has_images = len(image) > 0

    # Case 3: Neither images nor URL
    if not has_images and not url:
        raise HTTPException(status_code=400, detail="Provide image(s) or a URL")

    # Case 2: URL only (no images) — delegate to shared URL capture logic
    if not has_images and url:
        return _handle_url_capture(
            url, user_id=user_id, db=db, idempotency_key=idempotency_key
        )

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

    if idempotency_key is None:
        # Count and type checks above are free; limit before copying up to
        # MAX_UPLOAD_SIZE into memory, uploading, or calling the model.
        _enforce_capture_rate_limit(user_id, db)
        file_contents = await _read_images(image)
        return _capture_images(
            file_contents,
            source_url=source_url,
            user_id=user_id,
            db=db,
            draft_id=uuid4(),
            attempt=_CaptureAttempt(),
        )

    # With a key the payload identity (every file's bytes + the URL) is needed
    # before reserving, and a replay must not be rate limited, so the bytes are
    # read first and the limiter runs only for new work.
    file_contents = await _read_images(image)
    payload_hash = hash_capture_payload(
        [content for content, _ in file_contents] + [(source_url or "").encode("utf-8")]
    )

    def _work(draft_id: UUID, attempt: _CaptureAttempt) -> DraftResponse:
        _enforce_capture_rate_limit(user_id, db)
        return _capture_images(
            file_contents,
            source_url=source_url,
            user_id=user_id,
            db=db,
            draft_id=draft_id,
            attempt=attempt,
        )

    return _run_idempotent(
        user_id=user_id,
        idempotency_key=idempotency_key,
        payload_hash=payload_hash,
        db=db,
        work=_work,
    )


async def _read_images(image: list[UploadFile]) -> list[tuple[bytes, str]]:
    """Read every upload into memory, enforcing per-file and cumulative limits."""
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
    return file_contents


def _capture_images(
    file_contents: list[tuple[bytes, str]],
    *,
    source_url: str | None,
    user_id: UUID,
    db: Client,
    draft_id: UUID,
    attempt: _CaptureAttempt,
) -> DraftResponse:
    """Image capture proper: temp files, storage upload, parse, create the draft."""
    tmp_paths: list[str] = []
    storage_keys: list[str] = []

    try:
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
        draft = _create_draft_tracked(
            attempt,
            draft_id=draft_id,
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
        if storage_keys and (not attempt.insert_attempted or attempt.insert_rejected):
            try:
                db.storage.from_(_BUCKET_RECIPE_IMAGES).remove(storage_keys)
            except Exception:
                logger.warning(f"Failed to cleanup storage: {storage_keys}")
        logger.error(f"Capture storage failed: {e.code}: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
    except HTTPException:
        raise
    except Exception as e:
        if storage_keys and (not attempt.insert_attempted or attempt.insert_rejected):
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
