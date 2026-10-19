"""
Tastelog: Anthropic client factory (Phase 14.2D).

Single boundary for constructing the Anthropic SDK client. Production
default is the real `anthropic.Anthropic` SDK; isolated load targets can
opt into a deterministic in-process stub by setting
`ANTHROPIC_STUB_MODE=deterministic`. The stub mimics only the API
surface the existing call sites already use (`messages.create`,
`messages.stream`) and never makes a network call.

Env contract (mirrors Phase 14.2A `SENTRY_TRACES_SAMPLE_RATE` discipline):
    unset / "" / "off" / "OFF"   -> real anthropic.Anthropic SDK
    "deterministic" / "DETERMINISTIC" -> deterministic in-process stub
    any other value              -> ValueError (fail fast — no silent fallback)

Hard non-changes:
- Production default behavior is bit-identical to today when env is unset.
- No real Anthropic call ever originates from the stub.
- The factory never logs the API key or any secret value — only the
  resolved mode token.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Iterator

import anthropic

from api.core.config import get_settings
from api.core.exceptions import ProviderError

logger = logging.getLogger("tastelog.core.anthropic_client")

# -----------------------------------------------------------------------------
# Default model (PROVIDER-S1)
#
# The single source of truth for the production Claude model. Both config
# factories (parser.get_default_config, riff.get_default_riff_config)
# consume this constant so the two pipelines can never silently diverge
# again (mirrored hardcodes of a model the provider later retired caused
# a full capture outage; see the ROADMAP PROVIDER-S1 record). Explicit
# model overrides on constructed configs remain supported — this is only
# the default.
# -----------------------------------------------------------------------------

DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"

# Internal ProviderError codes (PROVIDER-S1). Routes map these to the
# stable wire codes; see api/routes/drafts.py.
PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED"
PROVIDER_BAD_RESPONSE = "PROVIDER_BAD_RESPONSE"


def provider_error_from_exception(e: Exception) -> ProviderError:
    """Classify an Anthropic SDK exception into a typed ProviderError.

    Must be called while the original exception is in hand; call sites
    use ``raise provider_error_from_exception(e) from e`` so the chain
    is preserved. Subclass order matters: APITimeoutError subclasses
    APIConnectionError, and RateLimitError subclasses APIStatusError.

    Messages and captured fields are deliberately safe: internal code,
    provider HTTP status, provider exception class, request id — never
    response bodies, auth material, or user content.
    """
    if isinstance(e, anthropic.APITimeoutError):
        return ProviderError(
            "Provider request timed out",
            code=PROVIDER_TIMEOUT,
            provider_error_type=type(e).__name__,
        )
    if isinstance(e, anthropic.APIConnectionError):
        return ProviderError(
            "Provider connection failed",
            code=PROVIDER_UNAVAILABLE,
            provider_error_type=type(e).__name__,
        )
    if isinstance(e, anthropic.RateLimitError):
        return ProviderError(
            "Provider rate limited",
            code=PROVIDER_RATE_LIMITED,
            provider_status=429,
            provider_error_type=type(e).__name__,
            request_id=getattr(e, "request_id", None),
        )
    if isinstance(e, anthropic.APIStatusError):
        return ProviderError(
            f"Provider API error (HTTP {e.status_code})",
            code=PROVIDER_UNAVAILABLE,
            provider_status=e.status_code,
            provider_error_type=type(e).__name__,
            request_id=getattr(e, "request_id", None),
        )
    # Non-SDK exceptions are not provider failures — callers must not
    # route them here (they bubble to the generic 500 handler instead).
    raise TypeError(
        f"provider_error_from_exception expects an Anthropic SDK error, got {type(e).__name__}"
    )


_STUB_MODE_OFF = "off"
_STUB_MODE_DETERMINISTIC = "deterministic"

# Marker substring that uniquely identifies the URL-extractor's ingredient
# structuring prompt (`INGREDIENT_STRUCTURING_PROMPT` in
# api.core.url_extractor). Used by the stub to dispatch between recipe
# parsing and ingredient structuring on the single-string user-content
# path. Kept as a literal so the factory has no import-time dependency
# on url_extractor (avoids any potential import cycle).
_INGREDIENT_STRUCTURING_MARKER = (
    "Parse each ingredient string into structured components."
)

# Tail marker used by `structure_ingredients_with_claude` to delimit the
# numbered raw-ingredient list inside the prompt.
_INGREDIENT_LIST_MARKER = "Ingredients:\n"

# Marker substring that uniquely identifies the step-ingredient mapper
# prompt (`STEP_MAPPING_PROMPT` in api.core.step_mapping). Kept as a
# literal for the same no-import-cycle reason as the structuring marker.
# Checked BEFORE the structuring marker: the mapper prompt also contains
# an "Ingredients:" section.
_STEP_MAPPING_MARKER = (
    "matching recipe ingredients to the cooking steps that use them"
)

# Tail marker used by `map_ingredients_to_steps` to delimit the numbered
# step list inside the mapper prompt.
_STEP_LIST_MARKER = "Steps:\n"


# Schema-compatible deterministic recipe used for parser image, parser text,
# and URL-text-fallback paths. Validates against
# `api.core.parser.ParsedRecipe` (title required, confidence in [0,1],
# ingredients/steps with the canonical field names + `extra = "forbid"`).
_DETERMINISTIC_RECIPE_JSON: dict[str, Any] = {
    "title": "Two-Ingredient Crepes",
    "servings": "4",
    "prep_time": "10 min",
    "cook_time": "20 min",
    "ingredients": [
        {
            "quantity": "1",
            "unit": "cup",
            "name": "flour",
            "prep": None,
            "raw_text": "1 cup flour",
        },
        {
            "quantity": "2",
            "unit": None,
            "name": "eggs",
            "prep": None,
            "raw_text": "2 eggs",
        },
    ],
    "steps": [
        {"position": 1, "instruction": "Combine flour and eggs."},
        {"position": 2, "instruction": "Cook on medium heat until set."},
    ],
    "confidence": 0.9,
}

# Short prose used for Riff sync responses. Intentionally contains no
# ```recipe-json``` fenced block — keeps `extract_recipe_block` returning
# None on the sync path, matching the typical "no full-recipe rewrite"
# Riff turn shape for a load-test run.
_DETERMINISTIC_RIFF_TEXT = (
    "Sub butter for olive oil and reduce heat by 25°F to keep the fat "
    "from smoking."
)

# Streaming deltas — multiple non-empty fragments so the call site
# exercises `delta_count > 0` and yields multiple `text_delta` events.
_DETERMINISTIC_RIFF_DELTAS: tuple[str, ...] = (
    "Sub butter for ",
    "olive oil and ",
    "reduce heat by 25°F.",
)


def _read_stub_mode() -> str:
    """Read + normalize `ANTHROPIC_STUB_MODE`.

    Defends against Railway empty-string semantics by collapsing both
    `None` and `""` to `""`, then stripping + lowercasing. Mirrors the
    14.2A pattern (`os.getenv(X) or "default"`) in spirit but returns
    an empty string for the "real SDK" default branch.
    """
    raw = os.getenv("ANTHROPIC_STUB_MODE") or ""
    return raw.strip().lower()


def get_anthropic_client() -> Any:
    """Return either a real `anthropic.Anthropic` client or a deterministic stub.

    Production default is the real SDK. `ANTHROPIC_STUB_MODE=deterministic`
    swaps in an in-process stub for isolated load testing.

    Raises:
        ValueError: if `ANTHROPIC_STUB_MODE` is set to an unknown value.
            Fail-fast so that a misconfigured load target cannot
            silently fall through to the real SDK and incur cost or
            quota usage.
    """
    mode = _read_stub_mode()

    if mode in ("", _STUB_MODE_OFF):
        # Default production path — bit-identical to pre-14.2D behavior.
        settings = get_settings()
        return anthropic.Anthropic(api_key=settings.anthropic_api_key)

    if mode == _STUB_MODE_DETERMINISTIC:
        # Single INFO line emits the mode token only — never the API key.
        # Operational signal that a load-target run has activated the stub.
        logger.info("Anthropic client: deterministic stub active")
        return _DeterministicAnthropic()

    raise ValueError(
        "Invalid ANTHROPIC_STUB_MODE: expected unset, '', 'off', or "
        f"'deterministic'; got {mode!r}"
    )


# -----------------------------------------------------------------------------
# Deterministic stub — narrowest possible mimic of the SDK surface.
# Only the four call patterns used by parser / url_extractor / riff are
# supported. Anything outside that surface is intentionally undefined.
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class _StubTextBlock:
    """Mimics `anthropic.types.TextBlock` — provides only `.text`."""

    text: str


@dataclass(frozen=True)
class _StubMessage:
    """Mimics `anthropic.types.Message` — provides only `.content` of text blocks."""

    content: list[_StubTextBlock]


class _StubStream:
    """Mimics the stream object yielded by `client.messages.stream()`."""

    def __init__(self, deltas: tuple[str, ...]) -> None:
        self._deltas = deltas

    @property
    def text_stream(self) -> Iterator[str]:
        for delta in self._deltas:
            yield delta


class _StubStreamCtx:
    """Context manager wrapping `_StubStream`, matching the SDK's `with` pattern."""

    def __init__(self, deltas: tuple[str, ...]) -> None:
        self._stream = _StubStream(deltas)

    def __enter__(self) -> _StubStream:
        return self._stream

    def __exit__(
        self, exc_type: object, exc_val: object, exc_tb: object
    ) -> None:
        return None


class _StubMessages:
    """Mimics `client.messages` — exposes `.create` and `.stream`."""

    def create(self, **kwargs: Any) -> _StubMessage:
        text = _dispatch_create(kwargs)
        return _StubMessage(content=[_StubTextBlock(text=text)])

    def stream(self, **kwargs: Any) -> _StubStreamCtx:
        return _StubStreamCtx(_DETERMINISTIC_RIFF_DELTAS)


class _DeterministicAnthropic:
    """Deterministic in-process stand-in for `anthropic.Anthropic`."""

    def __init__(self) -> None:
        self.messages = _StubMessages()

    def with_options(self, **kwargs: Any) -> "_DeterministicAnthropic":
        """Mimic the SDK's per-call options copy (Issue 3 bounded edit call).

        The stub is in-process and never retries or blocks on a network,
        so timeout/max_retries are accepted and ignored.
        """
        del kwargs
        return self


# -----------------------------------------------------------------------------
# Pure dispatch — selects a canned response based on call args alone.
# -----------------------------------------------------------------------------


def _dispatch_create(kwargs: dict[str, Any]) -> str:
    """Return the canned text body for a `messages.create` call.

    Dispatch order (first match wins):
      1. `system` kwarg set         -> Riff sync           -> short prose
      2. user content has an image  -> parser image        -> recipe JSON
      3. mapper-marker present      -> step mapper         -> JSON array
                                                              (one per step)
      4. ingredient-marker present  -> ingredient struct.  -> JSON array
                                                              (count == input)
      5. anything else              -> parser text         -> recipe JSON
    """
    if kwargs.get("system"):
        return _DETERMINISTIC_RIFF_TEXT

    messages = kwargs.get("messages") or []
    if not messages:
        return _DETERMINISTIC_RIFF_TEXT

    first_content = messages[0].get("content")

    if isinstance(first_content, list):
        for block in first_content:
            if isinstance(block, dict) and block.get("type") == "image":
                return json.dumps(_DETERMINISTIC_RECIPE_JSON)
        # List-shaped content but no image block — treat as parser text path.
        return json.dumps(_DETERMINISTIC_RECIPE_JSON)

    if isinstance(first_content, str):
        if _STEP_MAPPING_MARKER in first_content:
            return _build_step_mapping_response(first_content)
        if _INGREDIENT_STRUCTURING_MARKER in first_content:
            return _build_ingredient_structuring_response(first_content)
        return json.dumps(_DETERMINISTIC_RECIPE_JSON)

    return json.dumps(_DETERMINISTIC_RECIPE_JSON)


def _build_ingredient_structuring_response(prompt_text: str) -> str:
    """Build a JSON-array response whose length matches the input ingredient count.

    `structure_ingredients_with_claude` (api.core.url_extractor) enforces
    `len(parsed) == len(raw_ingredients)` and validates each entry via
    `ParsedIngredient.model_validate`. The caller builds the prompt as:

        f"{INGREDIENT_STRUCTURING_PROMPT}\\n\\nIngredients:\\n{numbered}"

    where `numbered = "1. <raw>\\n2. <raw>\\n..."`. We parse the numbered
    list back out, emit one ParsedIngredient-compatible dict per line,
    and assign the raw text as the `name` (the caller overwrites
    `raw_text` post-validation anyway).
    """
    idx = prompt_text.find(_INGREDIENT_LIST_MARKER)
    if idx < 0:
        return json.dumps([])

    block = prompt_text[idx + len(_INGREDIENT_LIST_MARKER) :]
    raw_lines = [line for line in block.split("\n") if line.strip()]

    items: list[dict[str, Any]] = []
    for line in raw_lines:
        stripped = line.lstrip()
        # Strip leading "N. " numbering — caller numbered the input as
        # `f"{i + 1}. {ing}"`.
        if "." in stripped:
            _, _, rest = stripped.partition(".")
            ing_text = rest.strip()
        else:
            ing_text = stripped
        items.append(
            {
                "quantity": None,
                "unit": None,
                "name": ing_text or "ingredient",
                "prep": None,
                "raw_text": ing_text,
            }
        )
    return json.dumps(items)


def _build_step_mapping_response(prompt_text: str) -> str:
    """Build a JSON-array mapper response with one record per input step.

    `map_ingredients_to_steps` (api.core.step_mapping) numbers its steps as
    `f"{i + 1}. {instruction}"` after a "Steps:\\n" marker. Emit one
    `{"step": N, "ingredients": []}` record per numbered line: shape-valid,
    authoritative-empty for every step, fully deterministic.
    """
    idx = prompt_text.find(_STEP_LIST_MARKER)
    if idx < 0:
        return json.dumps([])

    block = prompt_text[idx + len(_STEP_LIST_MARKER) :]
    step_count = len([line for line in block.split("\n") if line.strip()])
    return json.dumps(
        [{"step": i + 1, "ingredients": []} for i in range(step_count)]
    )
