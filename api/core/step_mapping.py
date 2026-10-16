"""
Tastelog: durable step-ingredient mapping (Issue 1).

One module owns the mapping lifecycle between "the model told us which
ingredients each step uses" and "authoritative rows in
recipe_step_ingredients":

  - validate_positions_value:   the four-state per-step input contract
  - derive_step_ingredient_positions: parsed steps -> canonical mapping list
  - strip_step_mapping:         steps for the OLD public draft shape
  - map_ingredients_to_steps:   bounded soft-failure provider mapper
                                (JSON-LD imports + Riff save time)
  - apply_step_mapping:         attach via the atomic RPC + record outcome
  - normalize_edited_ingredients: truthful raw_text-edit normalization
  - compute_confirm_mappings:   server-side semantic edit invalidation

State contract (per step):
  None  -> unknown: renderer falls back to the strict text matcher
  []    -> authoritative: the step uses no ingredients
  [i..] -> authoritative 1-based ingredient positions

Promotion to authoritative happens ONLY through the
attach_step_ingredient_mapping RPC (single transaction; any invalid
position rolls the whole attach back). Every failure path here degrades
to unknown; nothing is ever sanitized into false authority.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import anthropic
from supabase import Client

from api.core.parser import ParserConfig

logger = logging.getLogger(__name__)

# Canonical key inside recipe_drafts.raw_model_json. The draft's PUBLIC
# steps shape stays untouched (build 3 / old-API rollback compatibility);
# mapping truth lives only in this server-owned opaque seam.
STEP_MAPPING_KEY = "step_ingredient_positions"

# Internal recipe-level evidence values (recipes.step_mapping_outcome).
# Never exposed on the wire and never shown to users.
OUTCOME_PENDING = "pending"
OUTCOME_COMPLETE = "complete"
OUTCOME_PARTIAL = "partial"
OUTCOME_DEGRADED = "degraded"

# Issue 3 (plan section 8.4): the interactive edit path's HARD mapping
# budget. 5 seconds maximum wall clock, ZERO automatic provider retries,
# applied via client.with_options(...) at the edit-mapping call site
# (api.core.recipes.update_recipe_content). The SDK defaults (600s
# timeout, 2 retries) are never acceptable inside an interactive save.
# Creation producers keep their existing call configuration.
EDIT_MAPPING_TIMEOUT_SECONDS = 5.0
EDIT_MAPPING_MAX_RETRIES = 0

# First line doubles as the deterministic-stub dispatch marker
# (api.core.anthropic_client._dispatch_create).
STEP_MAPPING_PROMPT = """You are matching recipe ingredients to the cooking steps that use them.

Given a numbered ingredient list and numbered steps, return ONLY a valid JSON array (no markdown, no explanation) with exactly one object per step, in step order:

[
  {"step": 1, "ingredients": []},
  {"step": 2, "ingredients": [1, 3]},
  {"step": 3, "ingredients": null}
]

Rules:
- "ingredients" lists the numbers of every ingredient physically used or added in that step.
- Collective references ("the dry ingredients", "the sauce") include EVERY member ingredient.
- An ingredient can appear in multiple steps if it is used more than once.
- Use [] ONLY when you are confident the step uses no ingredients at all (preheating, resting, flipping).
- If you cannot confidently determine the COMPLETE set of ingredients a step uses, set "ingredients" to null for that step. Never guess, and never leave an uncertain ingredient out of an otherwise-listed step: an incomplete list is worse than null.
- Use only the given ingredient numbers.
"""


# ---------------------------------------------------------------------------
# Four-state validation
# ---------------------------------------------------------------------------


def validate_positions_value(
    value: object, ingredient_count: int
) -> list[int] | None:
    """Validate one step's raw mapping value against the four-state contract.

    Returns:
        []      valid, authoritative empty
        [i..]   valid, deduped preserving source order, all in range
        None    unknown: absent, null, or malformed (non-list, booleans,
                non-integers, zero/negative, or ANY out-of-range reference).
                [1, 99] never becomes [1]; [99] never becomes [].
    """
    if value is None:
        return None
    if not isinstance(value, list):
        return None
    deduped: list[int] = []
    for item in value:
        # bool is an int subclass in Python: reject explicitly.
        if isinstance(item, bool) or not isinstance(item, int):
            return None
        if item < 1 or item > ingredient_count:
            return None
        if item not in deduped:
            deduped.append(item)
    return deduped


def derive_step_ingredient_positions(
    steps: list[dict[str, Any]],
) -> list[list[int] | None]:
    """Extract the canonical mapping list from ParsedRecipe-dumped steps.

    ParsedRecipe already enforced the four-state contract; this only reads
    the field, treating an absent key as unknown.
    """
    return [step.get("ingredient_positions") for step in steps]


def strip_step_mapping(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Steps for the OLD public draft shape: position + instruction only.

    Mapping data must never enter recipe_drafts.steps: the pre-mapping API's
    StepData model (extra="forbid") would reject such drafts after a
    rollback.
    """
    return [
        {"position": step["position"], "instruction": step["instruction"]}
        for step in steps
    ]


def canonicalize_parsed_recipe(parsed: dict[str, Any]) -> dict[str, Any]:
    """Split a parsed-recipe dict into the rollback-safe draft layout.

    Moves per-step mapping out of the steps (which become the OLD public
    shape) into the canonical top-level key. The result is what capture
    routes store: `steps` feed recipe_drafts.steps unchanged in shape,
    and the whole dict (with the canonical key) feeds raw_model_json.
    """
    steps = parsed.get("steps") or []
    return {
        **parsed,
        STEP_MAPPING_KEY: derive_step_ingredient_positions(steps),
        "steps": strip_step_mapping(steps),
    }


# ---------------------------------------------------------------------------
# Bounded soft-failure provider mapper (JSON-LD imports + Riff save time)
# ---------------------------------------------------------------------------


def _format_mapper_ingredient(ingredient: dict[str, Any]) -> str:
    raw_text = ingredient.get("raw_text")
    if isinstance(raw_text, str) and raw_text.strip():
        return raw_text.strip()
    parts = [
        ingredient.get("quantity"),
        ingredient.get("unit"),
        ingredient.get("name"),
    ]
    line = " ".join(str(p) for p in parts if p is not None and str(p).strip())
    prep = ingredient.get("prep")
    if prep is not None and str(prep).strip():
        line = f"{line}, {prep}"
    return line


def map_ingredients_to_steps(
    ingredients: list[dict[str, Any]],
    steps: list[dict[str, Any]],
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> list[list[int] | None] | None:
    """Map ingredients to steps in one bounded provider call. SOFT-FAILURE.

    Every failure (provider error, invalid JSON, malformed records) returns
    None or per-entry None instead of raising: mapping degradation must
    never fail a capture or a save. The caller records the degraded outcome.

    Returns a list aligned to `steps` (entries per the four-state contract),
    or None when the call produced nothing usable at all.
    """
    if not ingredients or not steps:
        return None

    numbered_ingredients = "\n".join(
        f"{i + 1}. {_format_mapper_ingredient(ing)}"
        for i, ing in enumerate(ingredients)
    )
    numbered_steps = "\n".join(
        f"{i + 1}. {step.get('instruction', '')}" for i, step in enumerate(steps)
    )

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"{STEP_MAPPING_PROMPT}\n\n"
                        f"Ingredients:\n{numbered_ingredients}\n\n"
                        f"Steps:\n{numbered_steps}"
                    ),
                }
            ],
        )
    except Exception:
        logger.warning("Step mapper provider call failed", exc_info=True)
        return None

    response_text = ""
    for block in getattr(message, "content", []):
        text = getattr(block, "text", None)
        if isinstance(text, str):
            response_text += text
    response_text = response_text.strip()
    if response_text.startswith("```"):
        lines = [
            line
            for line in response_text.split("\n")
            if not line.strip().startswith("```")
        ]
        response_text = "\n".join(lines).strip()

    try:
        parsed = json.loads(response_text)
    except json.JSONDecodeError:
        logger.warning("Step mapper returned invalid JSON")
        return None

    if not isinstance(parsed, list):
        logger.warning("Step mapper returned a non-list response")
        return None

    result: list[list[int] | None] = [None] * len(steps)
    seen_steps: set[int] = set()
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        step_no = entry.get("step")
        if isinstance(step_no, bool) or not isinstance(step_no, int):
            continue
        if step_no < 1 or step_no > len(steps):
            continue
        if step_no in seen_steps:
            # Conflicting duplicate records for one step: structural
            # ambiguity, degrade the whole response to unknown.
            logger.warning("Step mapper returned duplicate step records")
            return None
        seen_steps.add(step_no)
        result[step_no - 1] = validate_positions_value(
            entry.get("ingredients"), len(ingredients)
        )
    return result


# ---------------------------------------------------------------------------
# Atomic attachment + outcome recording
# ---------------------------------------------------------------------------


def apply_step_mapping(
    recipe_id: str,
    mappings: list[list[int] | None],
    *,
    expected_content_rev: int,
    supabase: Client,
    logger: logging.Logger,
) -> str:
    """Attach the valid mappings atomically and record the recipe outcome.

    NEVER raises: mapping is strictly subordinate to recipe durability. On
    any failure the affected steps simply stay unknown (version NULL) and
    the outcome records the degradation.

    Issue 3 freshness guard: the attach RPC refuses (TL428) when the
    recipe's content_rev no longer matches expected_content_rev (a mapping
    computed against superseded content must not promote), which degrades
    inside this boundary; the outcome UPDATE carries the same rev guard so
    a stale attempt cannot overwrite a newer edit's atomically-recorded
    outcome. All creation producers pass rev 1 (their recipes are created
    in-request at DEFAULT 1).

    Returns the recorded outcome: 'complete' | 'partial' | 'degraded'.
    """
    payload = [
        {"step_position": i + 1, "ingredient_positions": positions}
        for i, positions in enumerate(mappings)
        if positions is not None
    ]

    if not payload:
        outcome = OUTCOME_DEGRADED
    else:
        try:
            supabase.rpc(
                "attach_step_ingredient_mapping",
                {
                    "p_recipe_id": str(recipe_id),
                    "p_expected_content_rev": expected_content_rev,
                    "p_mappings": payload,
                },
            ).execute()
            outcome = (
                OUTCOME_COMPLETE
                if len(payload) == len(mappings)
                else OUTCOME_PARTIAL
            )
        except Exception as e:
            # The RPC is one transaction: a failure attached nothing and
            # every step is still unknown. A TL428 stale refusal is the
            # designed freshness outcome, recorded as degraded.
            if "tl428" in str(e).lower():
                logger.warning(
                    "Step mapping attach refused (stale content rev) for "
                    "recipe %s",
                    recipe_id,
                )
            else:
                logger.warning(
                    "Step mapping attach failed for recipe %s",
                    recipe_id,
                    exc_info=True,
                )
            outcome = OUTCOME_DEGRADED

    try:
        supabase.table("recipes").update(
            {"step_mapping_outcome": outcome}
        ).eq("id", str(recipe_id)).eq(
            "content_rev", expected_content_rev
        ).execute()
    except Exception:
        # Outcome stays 'pending': still honest (mapping never promoted
        # without the attach succeeding first).
        logger.warning(
            "Step mapping outcome update failed for recipe %s",
            recipe_id,
            exc_info=True,
        )

    return outcome


# ---------------------------------------------------------------------------
# Draft confirm: truthful normalization + semantic edit invalidation
# ---------------------------------------------------------------------------

_SEMANTIC_FIELDS = ("quantity", "unit", "name", "prep")


def _ingredient_row_key(row: dict[str, Any]) -> tuple[Any, ...]:
    """Identity key for count-change matching: all semantic fields + raw_text."""
    return tuple(row.get(field) for field in (*_SEMANTIC_FIELDS, "raw_text"))


def normalize_edited_ingredients(
    draft_ingredients: list[dict[str, Any]],
    override_ingredients: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Resolve the raw_text divergence truthfully.

    The draft editor edits raw_text only, shipping the untouched original
    structured fields alongside. Persisting those as-is would display a
    stale quantity against text it no longer describes. For any row whose
    raw_text changed while its structured fields did not, collapse to an
    unstructured truthful row: name = edited raw_text, quantity/unit/prep
    cleared. Rows whose structured fields actually changed (a future
    field-level editor) pass through untouched.

    A count mismatch makes positional alignment unprovable, but the
    truthfulness contract still applies: a row byte-identical to SOME
    original row keeps its structured fields (they still describe its
    unchanged text); any other row with meaningful raw_text collapses to
    unstructured truth, because its structured fields cannot be proven to
    describe that text. (Mapping invalidation is separate and total on
    count change: compute_confirm_mappings.)
    """
    if len(draft_ingredients) != len(override_ingredients):
        original_rows = {
            _ingredient_row_key(row) for row in draft_ingredients
        }
        collapsed: list[dict[str, Any]] = []
        for edited in override_ingredients:
            edited_raw = edited.get("raw_text")
            if _ingredient_row_key(edited) in original_rows:
                collapsed.append(edited)
            elif isinstance(edited_raw, str) and edited_raw.strip():
                collapsed.append(
                    {
                        **edited,
                        "quantity": None,
                        "unit": None,
                        "name": edited_raw.strip(),
                        "prep": None,
                        "raw_text": edited_raw,
                    }
                )
            else:
                # No raw_text to collapse to: the row is the user's
                # explicit payload; pass it through.
                collapsed.append(edited)
        return collapsed

    normalized: list[dict[str, Any]] = []
    for original, edited in zip(draft_ingredients, override_ingredients):
        edited_raw = edited.get("raw_text")
        original_raw = original.get("raw_text")
        structured_unchanged = all(
            edited.get(field) == original.get(field)
            for field in _SEMANTIC_FIELDS
        )
        raw_changed = (
            isinstance(edited_raw, str)
            and edited_raw.strip() != ""
            and edited_raw != original_raw
        )
        if raw_changed and structured_unchanged:
            normalized.append(
                {
                    **edited,
                    "quantity": None,
                    "unit": None,
                    "name": edited_raw.strip(),
                    "prep": None,
                    "raw_text": edited_raw,
                }
            )
        else:
            normalized.append(edited)
    return normalized


def compute_confirm_mappings(
    draft: dict[str, Any],
    ingredients_override: list[dict[str, Any]] | None,
    steps_override: list[dict[str, Any]] | None,
) -> list[list[int] | None] | None:
    """Determine which original mappings survive the user's edits.

    Client-carried positions are never trusted: the server-held original
    mapping in raw_model_json is the only source, and it survives only
    where the confirmed content is semantically identical to what the
    model actually mapped.

    Returns:
        None                       no mapping data at all (legacy draft) ->
                                   skip attach entirely, outcome stays as
                                   the RPC left it (NULL)
        list aligned to the final  entries per the four-state contract;
        steps                      all-None means "mapping data existed but
                                   nothing survived" -> attach records
                                   'degraded'
    """
    raw_model_json = draft.get("raw_model_json")
    if not isinstance(raw_model_json, dict):
        return None
    original = raw_model_json.get(STEP_MAPPING_KEY)
    if original is None:
        return None

    draft_steps = draft.get("steps") or []
    draft_ingredients = draft.get("ingredients") or []
    step_count = len(draft_steps)
    ingredient_count = len(draft_ingredients)

    if not isinstance(original, list) or len(original) != step_count:
        # Structural ambiguity in the stored mapping itself.
        return [None] * step_count

    mappings: list[list[int] | None] = [
        validate_positions_value(entry, ingredient_count) for entry in original
    ]

    # Structural ingredient change (count differs): every positional
    # reference is ambiguous.
    if (
        ingredients_override is not None
        and len(ingredients_override) != ingredient_count
    ):
        return [None] * step_count

    # Structural step change (count differs): same.
    if steps_override is not None and len(steps_override) != step_count:
        return [None] * step_count

    # Per-step: a changed instruction is no longer the text the model
    # mapped.
    if steps_override is not None:
        for i, (original_step, edited_step) in enumerate(
            zip(draft_steps, steps_override)
        ):
            if original_step.get("instruction") != edited_step.get(
                "instruction"
            ):
                mappings[i] = None

    # Per-ingredient: a semantic change invalidates every step that
    # referenced that ingredient. (Run against the NORMALIZED override so a
    # raw_text edit counts as the semantic change it truthfully is.)
    if ingredients_override is not None:
        changed_positions: set[int] = set()
        for i, (original_ing, edited_ing) in enumerate(
            zip(draft_ingredients, ingredients_override)
        ):
            if any(
                original_ing.get(field) != edited_ing.get(field)
                for field in _SEMANTIC_FIELDS
            ):
                changed_positions.add(i + 1)
        if changed_positions:
            for i, positions in enumerate(mappings):
                if positions and any(
                    p in changed_positions for p in positions
                ):
                    mappings[i] = None

    return mappings
