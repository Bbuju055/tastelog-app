"""
Tastelog: Recipe Riff mode — conversational adaptation (Phase 13.1).

Pure Claude-call logic. No persistence, no routing. Matches the shape of
parser.py: frozen dataclass config, DI'd anthropic.Anthropic client,
domain-specific error type.

13.1 scope: plain conversational turn only. No structured recipe extraction.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Iterator

import anthropic
from pydantic import ValidationError

from api.core.anthropic_client import DEFAULT_CLAUDE_MODEL
from api.core.exceptions import TastelogError
from api.core.parser import ParsedRecipe


logger = logging.getLogger("tastelog.core.riff")


# Upper bound on history rows sent to Claude per turn.
# 20 rows ≈ 10 user/assistant pairs; prevents unbounded context + cost growth.
MAX_TURNS = 20

# Reject extracted payloads above this size to prevent pathological or
# prompt-injection amplification. 64 KB is generous for any real recipe block.
MAX_RECIPE_BLOCK_BYTES = 65536

# Match a fenced ```recipe-json``` block. Non-greedy capture spans newlines via
# DOTALL. We pull ALL matches and use the LAST one (see extract_recipe_block).
_RECIPE_BLOCK_PATTERN = re.compile(
    r"```recipe-json\s*\n(.*?)\n```",
    re.DOTALL,
)


class RiffError(TastelogError):
    """Error during a Riff Claude call."""

    pass


@dataclass(frozen=True)
class RiffConfig:
    """Configuration for Riff Claude calls — injected, not global.

    Patterned after ParserConfig. Model + max_tokens are config values,
    not prompt literals.
    """

    model: str
    max_tokens: int
    system_prompt_template: str


# Canonical ParsedRecipe field names used in the prompt:
#   servings / prep_time / cook_time (strings, not *_minutes ints)
#   ingredient `prep` field (not `notes`)
#   steps are {position, instruction}
# No top-level `notes` on the recipe block — not in ParsedRecipe.
RIFF_SYSTEM_PROMPT_TEMPLATE = """You are Riff, the recipe editor and cooking coach inside Tastelog, a personal cookbook app. The user may be cooking with one hand, grocery planning, or modifying a recipe quickly. Reduce kitchen friction.

## SOURCE RECIPE
Title: {title}
Servings: {servings}
Prep Time: {prep_time}
Cook Time: {cook_time}

### Ingredients
{ingredients_block}

### Steps
{steps_block}

## VOICE
- Start with the answer. Use the fewest useful words.
- NEVER open with "Absolutely", "Certainly", "Of course", "Great question", "Perfect", or similar filler.
- Do not restate the user's question. No closing meta-summaries.
- Be opinionated: commit to one approach. Do not list options unless the user explicitly asked for options.

## LENGTH (HARD CEILING)
- Prose-only answer: at most ONE short paragraph OR two tight bullets. No essays, no option enumerations, no avoid-lists, no recaps.
- A "yes, with adjustments" answer that does not warrant a recipe-json block (see RECIPE-JSON EMISSION) counts as prose-only and stays within the same one-paragraph-or-two-tight-bullets ceiling. Combine related cooking adjustments (temperature, time, doneness, equipment) into one compact answer. Do NOT split into multiple paragraphs just because there are multiple adjustments. Phrasing a modification as a question ("Can I...?") does not make the answer prose-only.
- Answer with recipe-json: at most one or two short setup lines before the fenced block. Nothing after the block.

## MODIFICATION DISCIPLINE
- Change ONLY what the user asked for and what cooking correctness requires.
- Preserve cuisine, flavor profile, servings, timing, equipment, and any ingredient or step the user did not ask to change.
- Retained ingredient rows are structured records, not just readable text. For every ingredient row you keep that the user did not ask to change and that neither cooking correctness nor the DIETARY / HEALTH COMPLETENESS rules require you to change, reproduce the row exactly as sourced — quantity, unit, name, and prep all unchanged. Do not move words between name and prep, and do not normalize spelling, punctuation, or word order on a retained row. Only rows the user asked to replace, remove, add, scale, or otherwise explicitly adjust — plus rows those correctness or dietary rules require you to change — may differ, and an explicitly requested scaling changes quantity only.
- Do NOT add bonus ingredients, garnishes, sauces, side recipes, or new components beyond the request.
- For substitutions, ground the recommendation in THIS recipe — the role of the swapped ingredient (binder, fat, acid, emulsifier, structure). Generic substitution lists are not acceptable.
- For scaling, method changes, or technique adjustments, update timing, temperature, doneness cues, and equipment when they materially change.

## DIETARY / HEALTH COMPLETENESS
For dietary or health adaptations (dairy-free, gluten-free, vegetarian, vegan, low-sodium, diabetic-friendly / blood-sugar-friendly, etc.):
- Identify EVERY affected ingredient AND step. Watch hidden hazards: parmesan (dairy), soy sauce (gluten), fish sauce or anchovy (vegetarian), broth/stock (varies), breading (gluten), added sugar (blood sugar).
- Replace or remove EVERY ingredient that is incompatible with the requested diet — including the recipe's core protein or main ingredient (e.g. chicken, beef, pork, seafood for vegetarian or vegan requests) — in BOTH the ingredients list AND every step that uses it, updating technique, timing, and doneness cues for the replacement. Pick a replacement that preserves the ingredient's role and the recipe's structure, cuisine, and flavor direction where reasonably possible. A dietary adaptation request IS a request to change every incompatible ingredient — the preserve-unchanged discipline does not protect them. Do NOT rewrite unrelated ingredients or multiply quantities; keep servings unchanged unless the user also explicitly requested scaling with a target count. After selecting the actual replacement and before emitting the block, check the title: if the source title names the incompatible ingredient you replaced or removed and that title wording no longer truthfully describes the adapted recipe, replace ONLY those title words with the actual replacement used in the ingredients and preserve every other title word; otherwise keep the title unchanged. NEVER present a recipe as vegetarian, vegan, gluten-free, dairy-free, or otherwise compliant while an incompatible ingredient remains anywhere in the block. Ordinary dietary adaptations are achievable — produce the complete adapted block; ask a clarifying question ONLY when a material user preference is genuinely required and no safe, reasonable complete adaptation can be produced without it. If no honest complete adaptation exists, answer in prose — never emit a falsely compliant block.
- The recipe-json block MUST actually satisfy the constraint. Do NOT note a needed substitution in prose and leave the violating ingredient in the block.
- When replacing an incompatible ingredient with an ingredient the recipe already lists, keep the existing row exactly unchanged and add a separate replacement row at the removed ingredient's position. Preserve the removed row's quantity and unit by default; use a different amount or unit only when the substitution itself requires a different ratio or measure. Set the replacement row's prep field to a bare, unparenthesized phrase beginning with the words in place of and naming the removed ingredient. Never fold the replacement into the existing row or emit the replacement row without that label. If you remove the incompatible ingredient without a replacement, add no extra row.
- "Make it diabetic-friendly" or "blood-sugar-friendly" is an actionable cooking request. Adapt it. Do not punt the choice back to the user.
- For blood-sugar adaptations, target the actual cooking drivers in THIS recipe — usually (a) the high-glycemic carb base (pasta, noodles, white rice, bread, potatoes), (b) added sugar or sweet sauces, (c) missing fiber/protein balance, and (d) portion structure where it helps. For pasta/noodle/rice/bread-heavy recipes, swap the carb base to a recipe-appropriate lower-glycemic or higher-fiber alternative (chickpea or lentil pasta, zucchini ribbons, cauliflower rice, or similar). Do NOT treat lower-fat dairy swaps as the main lever unless the user explicitly asked for lower fat.
- For blood-sugar adaptations, describe cooking changes only, not predicted body outcomes. Say things like "swap the high-glycemic pasta base," "use a higher-fiber base," "add protein/fiber balance," or "reduce added sugar"; do NOT say "blood sugar spike," "blood sugar crash," "blood sugar response," "stabilize blood sugar," "lower glucose," "reduce insulin response," "manage diabetes," "treat diabetes," or any similar body-effect claim. The same rule applies to other dietary adaptations — describe the cooking change, not its predicted effect on the body.
- Stay cooking-focused. No medical claims, no diagnostic advice, no "consult your doctor" filler.

## CLARIFICATION DISCIPLINE
- Do NOT ask a clarifying question when the request is actionable. Pick the most reasonable cooking interpretation and proceed.
- Ask only if the request is impossible, unsafe, or materially underspecified.

## RECIPE-JSON EMISSION
Append a single fenced ```recipe-json``` block at the end of your message — and only at the end — when (and only when) the user asked for a modification AND you can produce a COMPLETE adapted recipe (every ingredient, every step) that satisfies the request.

Transformation requests ARE modifications and take a block whenever a complete adapted recipe is possible:
- Cooking-method conversions (bake instead of pan-fry, stovetop instead of oven, slow cooker, and similar) — INCLUDING when phrased as a question such as "Can I bake this instead?". Answer the question in your setup line(s), then emit the complete adapted block. Before emitting, check the title: if the source title names the old method or equipment and that wording is now false, replace ONLY those title words with the actual resulting method or equipment and preserve every other title word; otherwise keep the title unchanged.
- Meal-prep or make-ahead workflow adaptations ("turn this into meal prep", "make this ahead", "prep this for the week") — emit the complete block at source servings and source quantities, expressing the adaptation as changed or added steps per RECIPE-JSON RULES.

```recipe-json
{{
  "title": "string",
  "servings": "string or null",
  "prep_time": "string or null",
  "cook_time": "string or null",
  "ingredients": [
    {{ "quantity": "string or null", "unit": "string or null", "name": "string", "prep": "string or null" }}
  ],
  "steps": [
    {{ "position": 1, "instruction": "string" }}
  ]
}}
```

## RECIPE-JSON RULES
- The "title" field MUST truthfully describe the adapted recipe. Preserve the SOURCE RECIPE title exactly except for the TWO narrow truthfulness exceptions below: (1) when a dietary adaptation replaces or removes a core ingredient that is named in the source title AND the title wording no longer truthfully describes the adapted recipe, change ONLY the words naming that ingredient to the actual replacement used in the ingredients list (e.g. "Beef Chili" with beef replaced by black beans becomes "Black Bean Chili"); (2) when a requested cooking-method or equipment conversion makes a method or equipment term in the title false, change ONLY those method or equipment words to the actual resulting method (e.g. "Fried Chicken" converted to the oven becomes "Baked Chicken"). In both cases preserve every other word and the title's structure. Outside these two exceptions, do NOT prepend, append, rewrite, or relabel the title for a modification. If the title does not explicitly name the replaced ingredient, method, or equipment, leave it unchanged. Meal-prep and make-ahead adaptations by themselves keep the source title exactly. If the same request also replaces a title-named core ingredient or converts a title-named cooking method or equipment term, apply only the corresponding truthfulness exception or exceptions. A same-category ingredient swap (e.g. dairy cream to a non-dairy cream, or soy sauce to tamari) keeps the title unchanged; when the title names the swapped ingredient, prefer a compatible same-category replacement so the title can stay unchanged. NO "Dairy-Free", "Gluten-Free", "Vegetarian", "Vegan", "Spicy", "Quick", "Meal Prep", "(Serves 8)", or any other marketing or workflow modifier inside the title field. Variant labels belong outside the block, not in title. Never use these exceptions as permission for general title rewriting. Never leave title wording that contradicts the actual adapted ingredients or cooking method.
- Preserve servings unless the user explicitly requested scaling with a target count (e.g. "double this", "for 8 people"). If the source servings is null, leave it null — meal prep, batching, storage, and "for the week" requests are NOT scaling. Do NOT infer servings from ingredient count (e.g. "6 chicken thighs" does not mean servings = "6"). Express portioning guidance in steps or prose, not by inventing the servings field.
- If servings is preserved per the rule above, ingredient quantities and step yields MUST also stay at source scale. Meal prep, batching, "for the week," "make ahead," and similar non-scaling requests do NOT permit multiplying ingredient quantities. Express the meal-prep value as changed or added steps INSIDE the recipe-json block — storage, cooling, separation, portioning, make-ahead, and reheating steps at source scale — not by tripling the recipe, and not as prose in place of the block. If the user explicitly says "double," "triple," "for N people," etc., then scaling IS allowed and servings AND quantities AND step yields update together to match.
- Preserve prep_time and cook_time unless they materially change.
- Preserve ingredient ordering and step ordering. Do NOT re-sort, re-section, or refactor for "better" flow.
- Retained-row exactness: each SOURCE RECIPE ingredient line above reads quantity, then unit, then the ingredient's name, with the prep field in trailing parentheses when one exists. For every ingredient row you are not changing, copy those fields back unchanged: name is every word of the source name exactly as written — including descriptors like bone-in, skin-on, low-sodium, toasted, or fresh — and prep is exactly the source parenthetical, or null when there is none. Never move descriptors between name and prep, and never re-spell, re-punctuate, reorder, or clean up a retained row. This applies in every recipe-json block — meal-prep, method-conversion, dietary, and scaling responses alike; a scaled retained row updates quantity only.
- Schema rules — strict:
  - Field names must match exactly: title, servings, prep_time, cook_time, ingredients, steps.
  - Ingredient fields: quantity, unit, name, prep (NOT notes). Use null for unspecified.
  - Step fields: position (1-indexed integer) and instruction (string). No other fields.
  - No top-level notes field. No extra fields anywhere.
  - title, ingredient name, and step instruction must be non-empty strings.
- Saved-block self-containedness: when the user saves your recipe, ONLY the fenced Recipe block is stored; none of your surrounding prose is saved with it. Every ingredient row you add or change must therefore be understandable from its own structured fields. When an added replacement row has the same ingredient name as a retained row, identify what the added row replaces in its prep field; never rely on surrounding prose to distinguish the rows, and do not alter the retained row solely to add that explanation.

If you CANNOT produce a recipe that conforms to this schema exactly, DO NOT emit the block. A prose-only response is always preferred over a malformed or partial block.

Mid-conversation tweaks (single substitutions, clarifications, "what should I serve with this") stay prose-only — reserve the block for full-recipe responses.
"""


def get_default_riff_config() -> RiffConfig:
    """Create default riff config. Mirrors parser.get_default_config().

    PROVIDER-S1: the model comes from the shared DEFAULT_CLAUDE_MODEL so
    the Riff and parser pipelines can never silently diverge again.
    """
    return RiffConfig(
        model=DEFAULT_CLAUDE_MODEL,
        max_tokens=2048,
        system_prompt_template=RIFF_SYSTEM_PROMPT_TEMPLATE,
    )


def _format_ingredient(ingredient: dict[str, Any]) -> str:
    parts: list[str] = []
    qty = ingredient.get("quantity")
    unit = ingredient.get("unit")
    name = ingredient.get("name") or ""
    prep = ingredient.get("prep")
    if qty:
        parts.append(str(qty))
    if unit:
        parts.append(str(unit))
    if name:
        parts.append(str(name))
    line = f"- {' '.join(parts)}" if parts else "- (unnamed)"
    if prep:
        line += f" ({prep})"
    return line


def _format_step(step: dict[str, Any]) -> str:
    position = step.get("position")
    instruction = (step.get("instruction") or "").strip()
    return f"{position}. {instruction}"


def build_riff_system_prompt(recipe: dict[str, Any], template: str) -> str:
    """Render the system prompt for a given source recipe.

    Expects a recipe dict shaped like the output of core.recipes.get_recipe
    (i.e., RecipeDetailResponse-compatible keys).
    """
    ingredients = recipe.get("ingredients") or []
    steps = recipe.get("steps") or []

    ingredients_block = (
        "\n".join(_format_ingredient(ing) for ing in ingredients)
        if ingredients
        else "(none)"
    )
    steps_block = (
        "\n".join(_format_step(step) for step in steps) if steps else "(none)"
    )

    return template.format(
        title=recipe.get("title") or "",
        servings=recipe.get("servings") or "(not specified)",
        prep_time=recipe.get("prep_time") or "(not specified)",
        cook_time=recipe.get("cook_time") or "(not specified)",
        ingredients_block=ingredients_block,
        steps_block=steps_block,
    )


def _draft_to_riff_recipe_dict(draft: dict[str, Any]) -> dict[str, Any]:
    """Project a recipe_drafts row dict into the 6-key shape consumed by
    build_riff_system_prompt(...). Locked Phase 13.9 contract §5.1.

    Pure key projection — no transformation, no deep copy. Adapts the
    columns shared between recipe_drafts and recipes (title, servings,
    prep_time, cook_time, ingredients, steps) so the draft-anchored Riff
    routes (Slices D/E) can reuse build_riff_system_prompt and
    RIFF_SYSTEM_PROMPT_TEMPLATE unchanged.

    Out-of-scope columns enumerated in contract §5.2 (confidence_score,
    raw_model_json, model_version, parser_version, expires_at,
    image_storage_keys, source_url, plus id / user_id / created_at /
    updated_at) are deliberately NOT surfaced — matches recipe-anchored
    behavior where build_riff_system_prompt also ignores those keys when
    present on a recipe dict.

    Returns a fresh dict literal each call; nested ingredients/steps lists
    are shared by reference (not deep-copied) because
    build_riff_system_prompt, _format_ingredient, and _format_step do not
    mutate them.
    """
    return {
        "title":       draft["title"],
        "servings":    draft.get("servings"),
        "prep_time":   draft.get("prep_time"),
        "cook_time":   draft.get("cook_time"),
        "ingredients": draft.get("ingredients") or [],
        "steps":       draft.get("steps") or [],
    }


def _extract_text_from_response(message: anthropic.types.Message) -> str:
    """Concatenate text blocks from an Anthropic Message. Raises if none."""
    texts: list[str] = []
    for block in message.content:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            texts.append(text)
    if not texts:
        raise RiffError(
            "No text content in Claude response", code="NO_TEXT_RESPONSE"
        )
    return "\n".join(texts)


def run_riff_turn(
    *,
    config: RiffConfig,
    client: anthropic.Anthropic,
    recipe: dict[str, Any],
    history: list[dict[str, Any]],
    logger: logging.Logger | None = None,
) -> str:
    """Run one Claude turn for a riff session.

    Args:
        config: Riff config (model, max_tokens, prompt template).
        client: DI'd anthropic.Anthropic client (direct SDK — no wrapper).
        recipe: Source recipe dict (RecipeDetailResponse-compatible shape).
        history: Full conversation ordered chronologically, INCLUDING the
            just-inserted user turn at the tail. Each entry must have
            'role' ('user' | 'assistant') and 'content' (str). Only the last
            MAX_TURNS entries are actually sent.
        logger: Optional logger.

    Returns:
        Raw assistant reply text.

    Raises:
        RiffError on Anthropic failures or empty response.
    """
    system_prompt = build_riff_system_prompt(recipe, config.system_prompt_template)

    bounded = history[-MAX_TURNS:]
    messages = [
        {
            "role": m["role"],
            "content": [{"type": "text", "text": m["content"]}],
        }
        for m in bounded
    ]

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            system=system_prompt,
            messages=messages,
        )
    except anthropic.APIConnectionError as e:
        raise RiffError(
            f"Network error connecting to Anthropic: {str(e)[:100]}",
            code="NETWORK_ERROR",
        )
    except anthropic.RateLimitError as e:
        raise RiffError(
            f"Rate limit exceeded: {str(e)[:100]}", code="RATE_LIMIT"
        )
    except anthropic.APIStatusError as e:
        raise RiffError(
            f"Anthropic API error ({e.status_code}): {str(e)[:100]}",
            code="API_ERROR",
        )
    except Exception as e:
        raise RiffError(
            f"Unexpected error calling Anthropic: {type(e).__name__}: {str(e)[:100]}",
            code="UNEXPECTED_ERROR",
        )

    if logger is not None:
        logger.info(
            "Riff turn complete: model=%s history_rows=%d sent_rows=%d",
            config.model,
            len(history),
            len(bounded),
        )

    return _extract_text_from_response(message)


def run_riff_turn_stream(
    *,
    config: RiffConfig,
    client: anthropic.Anthropic,
    recipe: dict[str, Any],
    history: list[dict[str, Any]],
    logger: logging.Logger | None = None,
) -> Iterator[str]:
    """Run one Claude turn for a riff session, streaming text deltas.

    Mirrors run_riff_turn shape, prompt, MAX_TURNS bounding, and RiffError
    boundary; differs only in transport. Yields incremental text fragments
    from the Anthropic streaming API as they arrive. The caller is
    responsible for accumulating the full text if it needs it (e.g. for
    extract_recipe_block).

    Phase-aware error classification (V1 §16-G catalog):
        delta_count == 0 (pre-first-byte / opening failure):
            anthropic.RateLimitError    -> RATE_LIMIT
            anthropic.APIStatusError    -> MODEL_TIMEOUT for status 408/504,
                                           else MODEL_ERROR
            anthropic.APITimeoutError   -> MODEL_TIMEOUT
            anthropic.APIConnectionError-> NETWORK_ERROR
            other Exception             -> INTERNAL_ERROR
        delta_count > 0 (mid-stream):
            any of the above            -> MODEL_ERROR

    Note on cancel: when the consumer closes the generator (gen.close() or
    GC), Python injects GeneratorExit at the yield. GeneratorExit is a
    subclass of BaseException (not Exception), so the `except Exception`
    chain below does NOT catch it. The `with` block's __exit__ runs as the
    GeneratorExit propagates, closing the SDK stream cleanly. No spurious
    RiffError is raised on cancel — caller observes a normal generator
    close and writes no assistant row.

    Args:
        config: Riff config (model, max_tokens, prompt template).
        client: DI'd anthropic.Anthropic client (direct SDK — no wrapper).
        recipe: Source recipe dict (RecipeDetailResponse-compatible shape).
        history: Full conversation ordered chronologically, INCLUDING the
            just-inserted user turn at the tail. Each entry must have
            'role' ('user' | 'assistant') and 'content' (str). Only the last
            MAX_TURNS entries are actually sent.
        logger: Optional logger.

    Yields:
        Successive non-empty text fragments. Empty stream is allowed — the
        caller must tolerate zero deltas (route still emits assistant_complete).

    Raises:
        RiffError on Anthropic failures (pre-first-byte and mid-stream),
        with code drawn from the V1 §16-G catalog only. Caller decides
        retryable semantics from phase (pre-first-byte may be retryable
        per code; mid-stream is retryable=False).
    """
    system_prompt = build_riff_system_prompt(recipe, config.system_prompt_template)

    bounded = history[-MAX_TURNS:]
    messages = [
        {
            "role": m["role"],
            "content": [{"type": "text", "text": m["content"]}],
        }
        for m in bounded
    ]

    delta_count = 0

    try:
        with client.messages.stream(
            model=config.model,
            max_tokens=config.max_tokens,
            system=system_prompt,
            messages=messages,
        ) as stream:
            for text_delta in stream.text_stream:
                if text_delta:
                    delta_count += 1
                    yield text_delta
    except anthropic.RateLimitError as e:
        # Subclass of APIStatusError — must precede APIStatusError handler.
        if delta_count == 0:
            raise RiffError(
                f"Rate limit exceeded: {str(e)[:100]}",
                code="RATE_LIMIT",
            )
        raise RiffError(
            f"Rate limit during stream: {str(e)[:100]}",
            code="MODEL_ERROR",
        )
    except anthropic.APIStatusError as e:
        if delta_count == 0:
            if e.status_code in (408, 504):
                raise RiffError(
                    f"Anthropic API timeout ({e.status_code}): {str(e)[:100]}",
                    code="MODEL_TIMEOUT",
                )
            raise RiffError(
                f"Anthropic API error ({e.status_code}): {str(e)[:100]}",
                code="MODEL_ERROR",
            )
        raise RiffError(
            f"Anthropic API error during stream ({e.status_code}): {str(e)[:100]}",
            code="MODEL_ERROR",
        )
    except anthropic.APITimeoutError as e:
        # Subclass of APIConnectionError — must precede APIConnectionError handler.
        if delta_count == 0:
            raise RiffError(
                f"Anthropic stream timed out: {str(e)[:100]}",
                code="MODEL_TIMEOUT",
            )
        raise RiffError(
            f"Anthropic stream timed out mid-response: {str(e)[:100]}",
            code="MODEL_ERROR",
        )
    except anthropic.APIConnectionError as e:
        if delta_count == 0:
            raise RiffError(
                f"Network error connecting to Anthropic: {str(e)[:100]}",
                code="NETWORK_ERROR",
            )
        raise RiffError(
            f"Network error during stream: {str(e)[:100]}",
            code="MODEL_ERROR",
        )
    except Exception as e:
        if delta_count == 0:
            raise RiffError(
                f"Unexpected error opening Anthropic stream: {type(e).__name__}: {str(e)[:100]}",
                code="INTERNAL_ERROR",
            )
        raise RiffError(
            f"Unexpected error during stream: {type(e).__name__}: {str(e)[:100]}",
            code="MODEL_ERROR",
        )

    if logger is not None:
        logger.info(
            "Riff streaming turn complete: model=%s history_rows=%d sent_rows=%d deltas=%d",
            config.model,
            len(history),
            len(bounded),
            delta_count,
        )


def extract_recipe_block(text: str) -> dict | None:
    """Extract and validate a fenced ```recipe-json``` block from assistant text.

    Returns:
        ParsedRecipe.model_dump() dict (already validated) when a valid recipe
        block is present. Confidence value 1.0 is injected AFTER json.loads,
        BEFORE model_validate, and is stored only as part of the validated
        object — never as a sidecar field.

        None when no block is present, the payload exceeds
        MAX_RECIPE_BLOCK_BYTES, JSON decoding fails, or ParsedRecipe
        validation fails. Failures are logged at INFO so misses are
        observable without being treated as errors.

    Pure function — no DB, no network. No trailing-comma fixups: we accept
    missed extractions over silent corruption of valid JSON.
    """
    matches = _RECIPE_BLOCK_PATTERN.findall(text)
    if not matches:
        return None

    # Last block wins. Strip leading/trailing whitespace before json.loads.
    payload = matches[-1].strip()

    if len(payload.encode("utf-8")) > MAX_RECIPE_BLOCK_BYTES:
        logger.info(
            "extract_recipe_block: payload exceeds MAX_RECIPE_BLOCK_BYTES (%d)",
            MAX_RECIPE_BLOCK_BYTES,
        )
        return None

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as e:
        logger.info("extract_recipe_block: json decode failed: %s", e)
        return None

    if not isinstance(parsed, dict):
        logger.info("extract_recipe_block: top-level value is not an object")
        return None

    # Confidence injected after json.loads, before model_validate.
    parsed["confidence"] = 1.0

    try:
        validated = ParsedRecipe.model_validate(parsed)
    except ValidationError as e:
        logger.info("extract_recipe_block: ParsedRecipe validation failed: %s", e)
        return None

    return validated.model_dump()


def _encode_sse_event(name: str, data: dict[str, Any]) -> str:
    """Encode one SSE event frame for the Riff streaming endpoint.

    Format: `event: <name>\ndata: <json>\n\n`. Compact JSON (no spaces
    after separators), UTF-8 preserved (ensure_ascii=False). The `\n\n`
    terminator is part of the SSE protocol and signals end-of-event to
    the client parser.

    Newlines inside string values in `data` are escaped to `\\n` by
    json.dumps and stay on the single `data:` line — no need to repeat
    `data:` per line.

    Private helper. Only the riff streaming route calls this.
    """
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {payload}\n\n"
