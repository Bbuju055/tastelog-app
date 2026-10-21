"""
Tastelog: Recipe CRUD operations.

Pure functions with explicit dependencies - no global state.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import UUID, uuid4

import anthropic
import filetype
from supabase import Client

from api.core.exceptions import RecipeNotFoundError, StorageError, TastelogError
from api.core.extraction_review import require_recipe_content
from api.core.parser import ParserConfig, get_default_config, parse_recipe_image
from api.core.step_mapping import (
    EDIT_MAPPING_MAX_RETRIES,
    EDIT_MAPPING_TIMEOUT_SECONDS,
    apply_step_mapping,
    derive_step_ingredient_positions,
    map_ingredients_to_steps,
)
from api.models.recipe import RecipeContentUpdateRequest


_BUCKET_RECIPE_IMAGES = "recipe-images"
_MAX_TAG_LENGTH = 50


class EditConflictError(TastelogError):
    """Content revision conflict: the recipe changed since it was read."""

    pass


class ContentValidationError(TastelogError):
    """Explicit-operation payload failed validation (zero mutation)."""

    pass


def get_tags_for_recipe(
    recipe_id: UUID,
    *,
    supabase: Client,
) -> list[str]:
    """Return tags for a single recipe, ordered by creation."""
    try:
        result = (
            supabase.table("recipe_tags")
            .select("tag")
            .eq("recipe_id", str(recipe_id))
            .order("created_at")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error fetching tags: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )
    return [row["tag"] for row in (result.data or [])]


def get_tags_for_recipes(
    recipe_ids: list[str],
    *,
    supabase: Client,
) -> dict[str, list[str]]:
    """Batch-fetch tags for multiple recipes. Returns {recipe_id: [tag, ...]}."""
    if not recipe_ids:
        return {}
    try:
        result = (
            supabase.table("recipe_tags")
            .select("recipe_id, tag")
            .in_("recipe_id", recipe_ids)
            .order("created_at")
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error fetching tags: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )
    tags_by_recipe: dict[str, list[str]] = {}
    for row in result.data or []:
        tags_by_recipe.setdefault(row["recipe_id"], []).append(row["tag"])
    return tags_by_recipe


def _normalize_tags(tags: list[str]) -> list[str]:
    """Normalize tags: trim, drop empty, drop >50 chars, dedupe case-insensitively.

    Preserves first-entered display casing. Tags exceeding max length after trim
    are silently dropped (deterministic — never relies on DB constraint for rejection).
    """
    seen: dict[str, str] = {}
    for tag in tags:
        trimmed = tag.strip()
        if not trimmed or len(trimmed) > _MAX_TAG_LENGTH:
            continue
        lower = trimmed.lower()
        if lower not in seen:
            seen[lower] = trimmed
    return list(seen.values())


def replace_recipe_tags(
    recipe_id: UUID,
    *,
    tags: list[str],
    user_id: UUID,
    rpc_supabase: Client,
    supabase: Client,
) -> dict[str, object]:
    """Atomically replace all tags for a recipe (set semantics).

    Normalizes input, then calls the replace_recipe_tags RPC for atomic
    delete + insert. Returns the full recipe detail shape (via get_recipe).

    Args:
        rpc_supabase: User-scoped client (carries auth.uid() for RPC).
        supabase: Service-role client (for readback via get_recipe).
    """
    normalized = _normalize_tags(tags)

    try:
        rpc_supabase.rpc(
            "replace_recipe_tags",
            {
                "p_recipe_id": str(recipe_id),
                "p_tags": normalized,
            },
        ).execute()
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "not owned" in msg:
            raise RecipeNotFoundError(
                f"Recipe not found: {recipe_id}",
                code="RECIPE_NOT_FOUND",
            )
        raise StorageError(
            f"Failed to replace tags: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    return get_recipe(recipe_id, user_id=user_id, supabase=supabase)


def _detect_mime_or_raise(path: Path) -> tuple[str, str]:
    """
    Returns: (mime, extension)
    Raises StorageError if unknown/unsupported.
    """
    kind = filetype.guess(str(path))
    if kind is None or not kind.mime:
        raise StorageError(
            f"Unable to detect file type: {path.name}",
            code="UNKNOWN_FILE_TYPE",
        )

    supported = {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
    }
    if kind.mime not in supported:
        raise StorageError(
            f"Unsupported file type: {kind.mime}",
            code="UNSUPPORTED_FILE_TYPE",
        )

    ext = (kind.extension or path.suffix.lstrip(".") or "").strip().lower()
    if not ext:
        raise StorageError(
            f"Unable to determine file extension: {path.name}",
            code="UNKNOWN_FILE_EXTENSION",
        )

    return kind.mime, ext


def upload_image(
    image_path: str,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> str:
    """Upload image/PDF to Supabase Storage, return storage key."""
    path = Path(image_path)
    if not path.exists():
        raise StorageError(f"File not found: {path.name}", code="FILE_NOT_FOUND")

    mime, ext = _detect_mime_or_raise(path)

    storage_key = f"{user_id}/{uuid4()}.{ext}"

    try:
        with open(path, "rb") as f:
            file_data = f.read()
    except Exception as e:
        raise StorageError(
            f"Failed to read file: {type(e).__name__}: {str(e)[:100]}",
            code="FILE_READ_FAILED",
        )

    try:
        supabase.storage.from_(_BUCKET_RECIPE_IMAGES).upload(
            storage_key,
            file_data,
            {"content-type": mime},
        )
    except Exception as e:
        raise StorageError(
            f"Failed to upload file: {type(e).__name__}: {str(e)[:100]}",
            code="UPLOAD_FAILED",
        )

    logger.info(f"Uploaded recipe asset: {storage_key} ({mime})")
    return storage_key


def _cleanup_failed_capture(
    *,
    recipe_id: str | None,
    storage_key: str | None,
    supabase: Client,
    logger: logging.Logger,
) -> None:
    """Best-effort compensation after a failed capture."""
    if recipe_id:
        try:
            supabase.table("recipe_steps").delete().eq("recipe_id", recipe_id).execute()
        except Exception as e:
            logger.warning(f"Cleanup failed (steps) for recipe {recipe_id}: {e}")

        try:
            supabase.table("recipe_ingredients").delete().eq(
                "recipe_id", recipe_id
            ).execute()
        except Exception as e:
            logger.warning(f"Cleanup failed (ingredients) for recipe {recipe_id}: {e}")

        try:
            supabase.table("recipes").delete().eq("id", recipe_id).execute()
        except Exception as e:
            logger.warning(f"Cleanup failed (recipe) for recipe {recipe_id}: {e}")

    if storage_key:
        try:
            supabase.storage.from_(_BUCKET_RECIPE_IMAGES).remove([storage_key])
        except Exception as e:
            logger.warning(f"Cleanup failed (storage) for {storage_key}: {e}")


def capture_recipe(
    image_path: str,
    *,
    user_id: UUID,
    supabase: Client,
    anthropic_client: anthropic.Anthropic,
    parser_config: ParserConfig,
    logger: logging.Logger,
) -> dict[str, object]:
    """
    Full capture pipeline:
      1) Upload file to storage
      2) Parse local file with Claude Vision
      3) Insert recipe + ingredients + steps
      4) On any failure: compensate (delete rows + storage object) best-effort
    """
    storage_key: str | None = None
    recipe_id: str | None = None

    try:
        storage_key = upload_image(
            image_path,
            user_id=user_id,
            supabase=supabase,
            logger=logger,
        )

        parsed = parse_recipe_image(
            image_path,
            client=anthropic_client,
            config=parser_config,
            logger=logger,
        )

        require_recipe_content(parsed.get("ingredients"), parsed.get("steps"))

        recipe_data = {
            "user_id": str(user_id),
            "title": parsed["title"],
            "image_path": storage_key,
            # don't lie: this is model output, not OCR
            "raw_model_json": json.dumps(parsed, ensure_ascii=False),
            "servings": parsed.get("servings"),
            "prep_time": parsed.get("prep_time"),
            "cook_time": parsed.get("cook_time"),
            "confidence_score": parsed.get("confidence", 0),
            # Issue 1: mapping-aware path; apply_step_mapping below records
            # the terminal outcome after the child rows exist.
            "step_mapping_outcome": "pending",
        }

        try:
            result = supabase.table("recipes").insert(recipe_data).execute()
        except Exception as e:
            raise StorageError(
                f"Failed to insert recipe: {type(e).__name__}: {str(e)[:100]}",
                code="DB_INSERT_FAILED",
            )

        if not result.data:
            raise StorageError("Recipe insert returned no data", code="DB_INSERT_FAILED")

        recipe = result.data[0]
        recipe_id = recipe["id"]
        logger.info(f"Created recipe: {recipe_id}")

        ingredients_data = parsed.get("ingredients") or []
        if ingredients_data:
            ingredients = [
                {
                    "recipe_id": recipe_id,
                    "position": i + 1,
                    "quantity": ing.get("quantity"),
                    "unit": ing.get("unit"),
                    "name": ing["name"],
                    "prep": ing.get("prep"),
                    "raw_text": ing.get("raw_text"),
                }
                for i, ing in enumerate(ingredients_data)
            ]
            try:
                supabase.table("recipe_ingredients").insert(ingredients).execute()
            except Exception as e:
                raise StorageError(
                    f"Failed to insert ingredients: {type(e).__name__}: {str(e)[:100]}",
                    code="DB_INSERT_FAILED",
                )

        steps_data = parsed.get("steps") or []
        if steps_data:
            steps = [
                {
                    "recipe_id": recipe_id,
                    "position": step.get("position", i + 1),
                    "instruction": step["instruction"],
                }
                for i, step in enumerate(steps_data)
            ]
            try:
                supabase.table("recipe_steps").insert(steps).execute()
            except Exception as e:
                raise StorageError(
                    f"Failed to insert steps: {type(e).__name__}: {str(e)[:100]}",
                    code="DB_INSERT_FAILED",
                )

        # Issue 1: attach the parse-time step mapping. Soft by contract:
        # apply_step_mapping never raises, so a mapping failure can only
        # leave steps unknown (fallback), never fail the capture.
        # Issue 3: the freshly created recipe is at content_rev DEFAULT 1.
        apply_step_mapping(
            recipe_id,
            derive_step_ingredient_positions(steps_data),
            expected_content_rev=1,
            supabase=supabase,
            logger=logger,
        )

        return recipe

    except Exception:
        _cleanup_failed_capture(
            recipe_id=recipe_id,
            storage_key=storage_key,
            supabase=supabase,
            logger=logger,
        )
        raise


def save_riff_recipe_atomic(
    recipe_id: UUID,
    session_id: UUID,
    message_id: UUID,
    riff_label: str | None,
    *,
    user_supabase: Client,
    logger: logging.Logger,
) -> dict:
    """Atomically save a recipe-anchored Riff to the cookbook (Issue 1).

    Thin wrapper around the save_riff_recipe_atomic(...) Postgres RPC
    (migration 026), replacing the old non-transactional Python inserts:
    recipe + ingredients + steps commit in ONE transaction, and
    recipes.source_riff_message_id UNIQUE makes retries idempotent. A
    retry after an ambiguous timeout resolves to the existing recipe
    (status="already_saved") instead of creating a duplicate; Python-side
    compensation logic is unnecessary because the RPC is all-or-nothing.

    IMPORTANT: requires the user-scoped Supabase client so the RPC's
    auth.uid() resolves correctly (mirrors save_draft_riff).

    Returns a dict with locked shape:
        {"status": "created" | "already_saved", "recipe_id": <uuid str>}

    The route layer translates:
      - status="created"       -> HTTP 200 with RiffSaveResponse(recipe_id)
      - status="already_saved" -> HTTP 409 with detail {code, recipe_id}

    Raises:
        RecipeNotFoundError -- session / message missing or cross-user
                               (P0002 from RPC; route pre-validation makes
                               this defensive)
        StorageError        -- session/recipe mismatch (P0004),
                               generated_recipe absent (22023), malformed
                               RPC shape, or unknown RPC failure
    """
    rpc_params: dict[str, object] = {
        "p_recipe_id": str(recipe_id),
        "p_session_id": str(session_id),
        "p_message_id": str(message_id),
        "p_riff_label": riff_label,  # None -> JSON null -> SQL NULL
    }

    try:
        result = user_supabase.rpc(
            "save_riff_recipe_atomic", rpc_params
        ).execute()
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "p0002" in msg:
            raise RecipeNotFoundError(
                "Riff session or message not found",
                code="RIFF_SAVE_NOT_FOUND",
            )
        if "does not belong" in msg or "p0004" in msg:
            raise StorageError(
                "Riff session does not belong to this recipe",
                code="RIFF_SAVE_MISMATCH",
            )
        if "no generated recipe" in msg or "22023" in msg:
            raise StorageError(
                "No generated recipe available for this message",
                code="GENERATED_RECIPE_MISSING",
            )
        raise StorageError(
            f"Riff save RPC failed: {type(e).__name__}: {str(e)[:100]}",
            code="RPC_FAILED",
        )

    data = result.data
    if isinstance(data, list):
        data = data[0] if data else None
    if (
        not isinstance(data, dict)
        or data.get("status") not in ("created", "already_saved")
        or not data.get("recipe_id")
    ):
        raise StorageError(
            "Riff save RPC returned malformed data", code="RPC_FAILED"
        )

    logger.info(
        "Riff save (%s): %s", data["status"], data["recipe_id"]
    )
    return data


def _fetch_recipe_snapshot(
    recipe_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict[str, object]:
    """One coherent snapshot via the get_recipe_snapshot RPC (Issue 3).

    A single SELECT statement inside the RPC guarantees one MVCC snapshot
    across the recipe row, ingredients, steps, associations and tags.
    Returns the raw snapshot dict (recipe / ingredients / steps /
    associations / tags). Ownership is a query predicate: a missing or
    cross-user recipe returns no row.
    """
    try:
        result = supabase.rpc(
            "get_recipe_snapshot",
            {"p_recipe_id": str(recipe_id), "p_user_id": str(user_id)},
        ).execute()
    except Exception as e:
        # Fixed copy only (CF-LEAK1 discipline): some read routes surface
        # StorageError messages verbatim as HTTP detail, so the message
        # must never embed str(e).
        raise StorageError(
            f"Database error during recipe read: {type(e).__name__}",
            code="DB_ERROR",
        )

    data = result.data
    if isinstance(data, list):
        data = data[0] if data else None
    if not data:
        # Don't leak existence across users. The spaced wording is part of
        # the Issue 3 contract (matches the RPC's TL404 message).
        raise RecipeNotFoundError(
            f"Recipe not found or not owned by user: {recipe_id}",
            code="RECIPE_NOT_FOUND",
        )
    if not isinstance(data, dict) or "recipe" not in data:
        raise StorageError(
            "Recipe snapshot RPC returned malformed data", code="RPC_FAILED"
        )
    return data


def _compose_detail_from_snapshot(
    snapshot: dict[str, object],
) -> dict[str, object]:
    """Flatten a snapshot into the RecipeDetailResponse-compatible dict.

    Preserves the Issue 1 ingredient_ids composition. The internal mapping
    version and last_content_mutation_id never leave the API; content_rev
    does (Issue 3 CAS anchor).
    """
    recipe = dict(snapshot["recipe"])  # type: ignore[arg-type]
    recipe.pop("last_content_mutation_id", None)
    ingredients = [dict(row) for row in snapshot.get("ingredients") or []]
    steps = [dict(row) for row in snapshot.get("steps") or []]
    associations = snapshot.get("associations") or []
    tags = snapshot.get("tags") or []

    # Issue 1: compose per-step ingredient_ids. The internal mapping
    # version never leaves the API:
    #   version NULL -> ingredient_ids = None (unknown/legacy)
    #   version set  -> ids in canonical recipe ingredient (position) order
    #                   ([] = authoritatively no ingredients)
    ingredient_order = {row["id"]: row["position"] for row in ingredients}
    ids_by_step: dict[str, list[str]] = {}
    for row in associations:
        ids_by_step.setdefault(row["step_id"], []).append(row["ingredient_id"])

    for step in steps:
        version = step.pop("ingredient_mapping_version", None)
        if version is None:
            step["ingredient_ids"] = None
        else:
            step["ingredient_ids"] = sorted(
                ids_by_step.get(step["id"], []),
                key=lambda ingredient_id: ingredient_order.get(
                    ingredient_id, len(ingredient_order) + 1
                ),
            )

    return {
        **recipe,
        "tags": tags,
        "ingredients": ingredients,
        "steps": steps,
    }


def get_recipe(
    recipe_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
) -> dict[str, object]:
    """Retrieve full recipe with ingredients and steps. Verifies ownership.

    Issue 3: rewired to the coherent get_recipe_snapshot RPC so every
    consumer reads one MVCC snapshot (no fan-out incoherence between the
    step read and the association read).
    """
    snapshot = _fetch_recipe_snapshot(
        recipe_id, user_id=user_id, supabase=supabase
    )
    return _compose_detail_from_snapshot(snapshot)


# =============================================================================
# Issue 3: optimistic two-phase content edit (plan sections 6.1, 8).
#
# PHASE A (no lock, no open transaction): coherent snapshot -> replay
# fast-path -> fail-fast CAS -> in-memory candidate + validation ->
# invalidation scope -> genuine-no-op early return.
# PHASE B (outside any DB transaction/row lock): bounded mapper (5s hard
# timeout, zero automatic retries) when the scope requires recomputation.
# PHASE C: the short atomic update_recipe_content RPC (re-checks replay/
# ownership/CAS under the row lock; discards the computed mapping on a
# lost race -> typed conflict).
# =============================================================================

def _ops_payload(body: RecipeContentUpdateRequest) -> dict[str, object]:
    """Serialize exactly the intentional operations (tri-state preserved)."""
    ops: dict[str, object] = {}
    if body.fields is not None:
        ops["fields"] = {
            key: getattr(body.fields, key)
            for key in body.fields.model_fields_set
        }
    for section_name in ("ingredients", "steps"):
        section = getattr(body, section_name)
        if section is None:
            continue
        section_ops: dict[str, object] = {}
        if section.update is not None:
            section_ops["update"] = [
                {
                    "id": str(op.id),
                    "fields": {
                        key: getattr(op.fields, key)
                        for key in op.fields.model_fields_set
                    },
                }
                for op in section.update
            ]
        if section.create is not None:
            if section_name == "ingredients":
                section_ops["create"] = [
                    {
                        "temp_id": str(op.temp_id),
                        "name": op.name,
                        "quantity": op.quantity,
                        "unit": op.unit,
                        "prep": op.prep,
                    }
                    for op in section.create
                ]
            else:
                section_ops["create"] = [
                    {"temp_id": str(op.temp_id), "instruction": op.instruction}
                    for op in section.create
                ]
        if section.delete is not None:
            section_ops["delete"] = [str(row_id) for row_id in section.delete]
        if section.order is not None:
            section_ops["order"] = [str(row_id) for row_id in section.order]
        ops[section_name] = section_ops
    return ops


class _EditPlan:
    """Phase A output: candidate content + scope + no-op verdict."""

    def __init__(
        self,
        *,
        candidate_ingredients: list[dict[str, object]],
        candidate_steps: list[dict[str, object]],
        invalidated_scope: list[int],
        is_noop: bool,
    ) -> None:
        self.candidate_ingredients = candidate_ingredients
        self.candidate_steps = candidate_steps
        self.invalidated_scope = invalidated_scope
        self.is_noop = is_noop


def _section_membership(
    section,
    current_ids: list[str],
    section_name: str,
) -> tuple[list[str], list[str], list[str]]:
    """Validate section membership against the snapshot (plan section 6.8).

    Returns (delete_ids, temp_ids, final_order_ids) where final_order_ids
    is the post-edit id sequence (temp ids included) or the surviving
    current order when no order array was sent.
    """
    if section is None:
        return [], [], list(current_ids)
    current_set = set(current_ids)
    update_ids = [str(op.id) for op in (section.update or [])]
    delete_ids = [str(row_id) for row_id in (section.delete or [])]
    temp_ids = [str(op.temp_id) for op in (section.create or [])]
    for row_id in update_ids:
        if row_id not in current_set:
            raise ContentValidationError(
                f"Unknown {section_name} id in update op",
                code="CONTENT_OPS_INVALID",
            )
    for row_id in delete_ids:
        if row_id not in current_set:
            raise ContentValidationError(
                f"Unknown {section_name} id in delete op",
                code="CONTENT_OPS_INVALID",
            )
    for temp_id in temp_ids:
        if temp_id in current_set:
            raise ContentValidationError(
                "temp_id collides with an existing row id",
                code="CONTENT_OPS_INVALID",
            )
    surviving = [row_id for row_id in current_ids if row_id not in delete_ids]
    if section.order is not None:
        order_ids = [str(row_id) for row_id in section.order]
        if sorted(order_ids) != sorted(surviving + temp_ids):
            raise ContentValidationError(
                f"Order array must cover the complete final {section_name} "
                "membership exactly once each",
                code="CONTENT_OPS_INVALID",
            )
        return delete_ids, temp_ids, order_ids
    return delete_ids, temp_ids, surviving


def _build_edit_plan(
    body: RecipeContentUpdateRequest,
    snapshot: dict[str, object],
) -> _EditPlan:
    """Apply the explicit operations in memory; classify the mapping scope.

    Scope semantics (plan section 8.2): ingredient update/create -> whole
    recipe; ingredient delete -> only steps whose associations referenced
    the deleted ids (from the snapshot pre-image); step update/create ->
    that step; step delete / pure reorder / scalar fields -> nothing.
    """
    snap_recipe = snapshot["recipe"]
    snap_ings = list(snapshot.get("ingredients") or [])
    snap_steps = list(snapshot.get("steps") or [])
    snap_assoc = list(snapshot.get("associations") or [])

    cur_ing_ids = [row["id"] for row in snap_ings]
    cur_step_ids = [row["id"] for row in snap_steps]
    ing_by_id = {row["id"]: row for row in snap_ings}
    step_by_id = {row["id"]: row for row in snap_steps}

    ing_delete, ing_temp, ing_final_order = _section_membership(
        body.ingredients, cur_ing_ids, "ingredient"
    )
    step_delete, step_temp, step_final_order = _section_membership(
        body.steps, cur_step_ids, "step"
    )

    # Effective scalar changes (IS DISTINCT FROM against the snapshot).
    scalar_changed = False
    if body.fields is not None:
        for key in body.fields.model_fields_set:
            if getattr(body.fields, key) != snap_recipe.get(key):
                scalar_changed = True
                break

    # Effective row updates. Only rows with an ACTUAL semantic change are
    # candidates for raw_text clearing; a patch equal to the current row
    # is a no-op component and leaves every stored byte alone.
    changed_ing_ids: set[str] = set()
    if body.ingredients is not None and body.ingredients.update is not None:
        for op in body.ingredients.update:
            row = ing_by_id[str(op.id)]
            if any(
                getattr(op.fields, key) != row.get(key)
                for key in op.fields.model_fields_set
            ):
                changed_ing_ids.add(str(op.id))
    changed_step_ids: set[str] = set()
    if body.steps is not None and body.steps.update is not None:
        for op in body.steps.update:
            row = step_by_id[str(op.id)]
            if (
                "instruction" in op.fields.model_fields_set
                and op.fields.instruction != row.get("instruction")
            ):
                changed_step_ids.add(str(op.id))

    ing_reordered = ing_final_order != [
        row_id for row_id in cur_ing_ids if row_id not in ing_delete
    ] or bool(ing_temp)
    step_reordered = step_final_order != [
        row_id for row_id in cur_step_ids if row_id not in step_delete
    ] or bool(step_temp)

    is_noop = not (
        scalar_changed
        or changed_ing_ids
        or changed_step_ids
        or ing_delete
        or step_delete
        or ing_temp
        or step_temp
        or ing_reordered
        or step_reordered
    )

    # Candidate rows in final order (mapper input truth: raw_text is
    # cleared only on semantically-changed rows; untouched rows keep it).
    ing_creates_by_temp = {
        str(op.temp_id): op
        for op in ((body.ingredients.create if body.ingredients else None) or [])
    }
    ing_updates_by_id = {
        str(op.id): op
        for op in ((body.ingredients.update if body.ingredients else None) or [])
    }
    candidate_ingredients: list[dict[str, object]] = []
    for row_id in ing_final_order:
        if row_id in ing_creates_by_temp:
            op = ing_creates_by_temp[row_id]
            candidate_ingredients.append(
                {
                    "name": op.name,
                    "quantity": op.quantity,
                    "unit": op.unit,
                    "prep": op.prep,
                    "raw_text": None,
                }
            )
        else:
            row = dict(ing_by_id[row_id])
            update_op = ing_updates_by_id.get(row_id)
            if update_op is not None and row_id in changed_ing_ids:
                for key in update_op.fields.model_fields_set:
                    row[key] = getattr(update_op.fields, key)
                row["raw_text"] = None
            candidate_ingredients.append(
                {
                    "name": row.get("name"),
                    "quantity": row.get("quantity"),
                    "unit": row.get("unit"),
                    "prep": row.get("prep"),
                    "raw_text": row.get("raw_text"),
                }
            )

    step_creates_by_temp = {
        str(op.temp_id): op
        for op in ((body.steps.create if body.steps else None) or [])
    }
    step_updates_by_id = {
        str(op.id): op
        for op in ((body.steps.update if body.steps else None) or [])
    }
    candidate_steps: list[dict[str, object]] = []
    for row_id in step_final_order:
        if row_id in step_creates_by_temp:
            candidate_steps.append(
                {"instruction": step_creates_by_temp[row_id].instruction}
            )
        else:
            row = step_by_id[row_id]
            update_op = step_updates_by_id.get(row_id)
            if update_op is not None and row_id in changed_step_ids:
                candidate_steps.append(
                    {"instruction": update_op.fields.instruction}
                )
            else:
                candidate_steps.append({"instruction": row.get("instruction")})

    # Complete-candidate validation (fail-closed defense in depth; the
    # model validators already enforce each piece on the wire).
    effective_title = (
        body.fields.title
        if body.fields is not None and "title" in body.fields.model_fields_set
        else snap_recipe.get("title")
    )
    if not effective_title or not str(effective_title).strip():
        raise ContentValidationError(
            "Title cannot be empty", code="CONTENT_OPS_INVALID"
        )
    for row in candidate_ingredients:
        if not row["name"] or not str(row["name"]).strip():
            raise ContentValidationError(
                "Ingredient name cannot be empty", code="CONTENT_OPS_INVALID"
            )
    for row in candidate_steps:
        if not row["instruction"] or not str(row["instruction"]).strip():
            raise ContentValidationError(
                "Step instruction cannot be empty", code="CONTENT_OPS_INVALID"
            )

    # Invalidation scope (post-edit step positions, 1-based).
    scope: set[int] = set()
    final_pos_by_step_id = {
        row_id: index + 1 for index, row_id in enumerate(step_final_order)
    }
    if changed_ing_ids or ing_temp:
        scope.update(range(1, len(step_final_order) + 1))
    elif ing_delete:
        deleted = set(ing_delete)
        for assoc in snap_assoc:
            if assoc["ingredient_id"] in deleted:
                position = final_pos_by_step_id.get(assoc["step_id"])
                if position is not None:
                    scope.add(position)
    for step_id in changed_step_ids:
        position = final_pos_by_step_id.get(step_id)
        if position is not None:
            scope.add(position)
    for temp_id in step_temp:
        scope.add(final_pos_by_step_id[temp_id])

    return _EditPlan(
        candidate_ingredients=candidate_ingredients,
        candidate_steps=candidate_steps,
        invalidated_scope=sorted(scope),
        is_noop=is_noop,
    )


def _map_update_rpc_error(e: Exception) -> TastelogError:
    """Map a failed update_recipe_content RPC call to a typed error.

    SQLSTATE first; the spaced not-found wording is the fallback for
    TL404 only (plan section 6.6).
    """
    msg = str(e).lower()
    if "tl404" in msg or "not found or not owned" in msg:
        return RecipeNotFoundError(
            "Recipe not found or not owned by user",
            code="RECIPE_NOT_FOUND",
        )
    if "tl409" in msg:
        return EditConflictError(
            "Recipe content revision conflict", code="EDIT_CONFLICT"
        )
    if "tl422" in msg:
        return ContentValidationError(
            "Content operations failed validation",
            code="CONTENT_OPS_INVALID",
        )
    return StorageError(
        f"Recipe update RPC failed: {type(e).__name__}: {str(e)[:100]}",
        code="RPC_FAILED",
    )


def update_recipe_content(
    recipe_id: UUID,
    *,
    user_id: UUID,
    body: RecipeContentUpdateRequest,
    supabase: Client,
    logger: logging.Logger,
) -> dict[str, object]:
    """Optimistic two-phase content edit (Issue 3, plan section 6.1).

    Raises:
        RecipeNotFoundError      recipe missing / not owned (or deleted
                                 between snapshot and commit)
        EditConflictError        content_rev CAS failure (typed 409)
        ContentValidationError   operation payload invalid (typed 422)
        StorageError             infrastructure failure
    """
    # PHASE A: preflight/snapshot. No lock, no open transaction.
    snapshot = _fetch_recipe_snapshot(
        recipe_id, user_id=user_id, supabase=supabase
    )
    snap_recipe = snapshot["recipe"]

    # Lost-response replay fast-path: WHILE this mutation remains the
    # current content mutation, retrying it returns idempotent success
    # with no provider work and no mutation (narrow guarantee, 6.2).
    if snap_recipe.get("last_content_mutation_id") == str(body.mutation_id):
        return _compose_detail_from_snapshot(snapshot)

    # Fail fast BEFORE any provider cost.
    if snap_recipe.get("content_rev") != body.expected_content_rev:
        raise EditConflictError(
            "Recipe content revision conflict", code="EDIT_CONFLICT"
        )

    plan = _build_edit_plan(body, snapshot)

    # A genuine no-op: no provider work, no mutation, no rev advance.
    if plan.is_noop:
        return _compose_detail_from_snapshot(snapshot)

    # PHASE B: bounded mapping work OUTSIDE any DB transaction/row lock.
    # 5s hard timeout, zero automatic retries; soft-failure by contract
    # (a mapping failure must never fail a valid recipe edit).
    mappings_param: list[dict[str, object]] | None = None
    if plan.invalidated_scope:
        try:
            from api.core.anthropic_client import get_anthropic_client

            bounded_client = get_anthropic_client().with_options(
                timeout=EDIT_MAPPING_TIMEOUT_SECONDS,
                max_retries=EDIT_MAPPING_MAX_RETRIES,
            )
            mapping = map_ingredients_to_steps(
                plan.candidate_ingredients,
                plan.candidate_steps,
                client=bounded_client,
                config=get_default_config(),
                logger=logger,
            )
        except Exception:
            logger.warning(
                "Edit-time step mapper setup failed", exc_info=True
            )
            mapping = None
        if mapping is not None:
            mappings_param = [
                {
                    "step_position": position,
                    "ingredient_positions": mapping[position - 1],
                }
                for position in plan.invalidated_scope
                if mapping[position - 1] is not None
            ]

    # PHASE C: the short atomic commit RPC. Re-checks replay/ownership/
    # CAS under the row lock; a lost race DISCARDS the computed mapping.
    try:
        result = supabase.rpc(
            "update_recipe_content",
            {
                "p_recipe_id": str(recipe_id),
                "p_user_id": str(user_id),
                "p_expected_content_rev": body.expected_content_rev,
                "p_mutation_id": str(body.mutation_id),
                "p_ops": _ops_payload(body),
                "p_mappings": mappings_param,
                "p_invalidated_scope": plan.invalidated_scope,
            },
        ).execute()
    except Exception as e:
        raise _map_update_rpc_error(e)

    data = result.data
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict) or data.get("status") not in (
        "updated",
        "replay",
        "noop",
    ):
        raise StorageError(
            "Recipe update RPC returned malformed data", code="RPC_FAILED"
        )
    logger.info(
        "Recipe content update (%s): %s rev=%s",
        data["status"],
        recipe_id,
        data.get("content_rev"),
    )

    # Coherent re-read: the response is the committed truth.
    final_snapshot = _fetch_recipe_snapshot(
        recipe_id, user_id=user_id, supabase=supabase
    )
    return _compose_detail_from_snapshot(final_snapshot)


def update_recipe_favorite(
    recipe_id: UUID,
    *,
    favorite: bool,
    user_id: UUID,
    supabase: Client,
) -> dict[str, object]:
    """Update the favorite status of a recipe. Verifies ownership.

    Returns the full recipe detail shape (via get_recipe) so the caller
    can return a consistent RecipeDetailResponse.
    """
    try:
        result = (
            supabase.table("recipes")
            .update({"favorite": favorite})
            .eq("id", str(recipe_id))
            .eq("user_id", str(user_id))
            .execute()
        )
    except Exception as e:
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not result.data:
        raise RecipeNotFoundError(
            f"Recipe not found: {recipe_id}",
            code="RECIPE_NOT_FOUND",
        )

    return get_recipe(recipe_id, user_id=user_id, supabase=supabase)


def delete_recipe(
    recipe_id: UUID,
    *,
    user_id: UUID,
    supabase: Client,
    logger: logging.Logger,
) -> bool:
    """Delete a recipe and its related data + storage object."""
    try:
        recipe_result = (
            supabase.table("recipes")
            .select("id, user_id, image_path")
            .eq("id", str(recipe_id))
            .eq("user_id", str(user_id))
            .single()
            .execute()
        )
    except Exception as e:
        msg = str(e).lower()
        if "no rows" in msg or "0 rows" in msg:
            raise RecipeNotFoundError(
                f"Recipe not found or not owned by user: {recipe_id}",
                code="RECIPE_NOT_FOUND",
            )
        raise StorageError(
            f"Database error: {type(e).__name__}: {str(e)[:100]}",
            code="DB_ERROR",
        )

    if not recipe_result.data:
        raise RecipeNotFoundError(
            f"Recipe not found or not owned by user: {recipe_id}",
            code="RECIPE_NOT_FOUND",
        )

    recipe = recipe_result.data

    try:
        supabase.table("recipe_steps").delete().eq("recipe_id", str(recipe_id)).execute()
        supabase.table("recipe_ingredients").delete().eq(
            "recipe_id", str(recipe_id)
        ).execute()
        supabase.table("recipes").delete().eq("id", str(recipe_id)).execute()
    except Exception as e:
        raise StorageError(
            f"Failed to delete recipe: {type(e).__name__}: {str(e)[:100]}",
            code="DB_DELETE_FAILED",
        )

    image_path = recipe.get("image_path")
    if image_path:
        try:
            supabase.storage.from_(_BUCKET_RECIPE_IMAGES).remove([image_path])
        except Exception as e:
            logger.warning(f"Failed to delete storage object {image_path}: {e}")

    logger.info(f"Deleted recipe: {recipe_id}")
    return True
