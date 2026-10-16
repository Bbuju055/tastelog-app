"""
Tastelog: Recipe parser using Claude Vision.
Pure parsing logic - no global state, explicit dependencies.
"""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

import anthropic
from pydantic import BaseModel, Field, field_validator, model_validator

from api.core.anthropic_client import (
    DEFAULT_CLAUDE_MODEL,
    PROVIDER_BAD_RESPONSE,
    provider_error_from_exception,
)
from api.core.exceptions import ImageProcessingError, ParsingError, ProviderError
from api.core.image_encoding import encode_image


@dataclass(frozen=True)
class ParserConfig:
    """Configuration for recipe parsing - injected, not global."""

    model: str
    max_tokens: int
    prompt: str
    max_image_size: int
    pdf_dpi: int
    jpeg_quality: int


# Default prompt for recipe parsing
DEFAULT_PARSE_PROMPT = """You are a recipe parser. Analyze this image of a recipe and extract structured data.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:

{
  "title": "Recipe name",
  "servings": "4 servings" or null,
  "prep_time": "15 mins" or null,
  "cook_time": "30 mins" or null,
  "ingredients": [
    {
      "quantity": "1",
      "unit": "cup",
      "name": "flour",
      "prep": "sifted",
      "raw_text": "1 cup flour, sifted"
    }
  ],
  "steps": [
    {
      "position": 1,
      "instruction": "Preheat oven to 350°F",
      "ingredient_positions": []
    },
    {
      "position": 2,
      "instruction": "Mix the flour into the wet ingredients",
      "ingredient_positions": [1]
    },
    {
      "position": 3,
      "instruction": "Add the remaining filling ingredients",
      "ingredient_positions": null
    }
  ],
  "confidence": 0.85
}

Rules:
- "quantity" can be "1", "1/2", "2-3", etc. Use null if not specified.
- "unit" can be "cup", "tbsp", "oz", "lb", "g", etc. Use null if not specified (e.g., "2 eggs").
- "prep" is preparation notes like "diced", "minced", "room temperature". Use null if none.
- "raw_text" is the original text for this ingredient line.
- "ingredient_positions" lists, for each step, the 1-based positions (in the "ingredients" array above) of every ingredient physically used or added in that step.
  - Use [] ONLY when you are confident the step uses no ingredients at all (preheating, resting, flipping).
  - Collective references ("the dry ingredients", "the sauce") include EVERY member ingredient.
  - An ingredient can appear in multiple steps if it is used more than once.
  - If you cannot confidently determine the COMPLETE set of ingredients a step uses, set "ingredient_positions" to null for that step. Never guess, and never leave an uncertain ingredient out of an otherwise-listed step: an incomplete list is worse than null.
  - Use only positions that exist in the ingredients array.
- "confidence" is your estimate (0-1) of how well you could read/parse the image.
- If you can't read the image clearly, still try your best and set confidence low.
- Keep step instructions as complete sentences from the original.
"""


MULTI_IMAGE_PARSE_PROMPT = (
    "These images are consecutive pages of the same recipe. "
    "Combine all information into a single complete recipe. "
    "If ingredients appear on one page and instructions on another, merge them. "
    "Deduplicate any content that appears on multiple pages "
    "(e.g., recipe title repeated).\n\n"
) + DEFAULT_PARSE_PROMPT


def get_default_config() -> ParserConfig:
    """Create default parser config for CLI and API usage."""
    return ParserConfig(
        model=DEFAULT_CLAUDE_MODEL,
        max_tokens=4096,
        prompt=DEFAULT_PARSE_PROMPT,
        max_image_size=1568,
        pdf_dpi=150,
        jpeg_quality=95,
    )


class ParsedIngredient(BaseModel):
    """Validated ingredient from Claude response."""

    model_config = {"extra": "forbid"}

    quantity: str | None = None
    unit: str | None = None
    name: str = Field(min_length=1)
    prep: str | None = None
    raw_text: str | None = None

    @field_validator("name", "quantity", "unit", "prep", "raw_text", mode="before")
    @classmethod
    def strip_strings(cls, v: str | None) -> str | None:
        if isinstance(v, str):
            v = v.strip()
            return v if v else None
        return v


class ParsedStep(BaseModel):
    """Validated step from Claude response."""

    model_config = {"extra": "forbid"}

    position: int = Field(ge=1)
    instruction: str = Field(min_length=1)
    # Issue 1 step-ingredient mapping. 1-based positions into the recipe's
    # ingredients array. Four-state contract (per-step):
    #   None  -> unknown (absent, null, or malformed model output)
    #   []    -> authoritative: this step uses no ingredients
    #   [i..] -> authoritative ingredient references
    # Malformed values (non-list, booleans, non-integers, zero/negative)
    # degrade the WHOLE field to None. They are never sanitized into a
    # smaller valid list: [1, 99] must not become [1]. Range checking
    # against the ingredient count happens at the ParsedRecipe level.
    ingredient_positions: list[int] | None = None

    @field_validator("instruction", mode="before")
    @classmethod
    def strip_instruction(cls, v: str | None) -> str | None:
        if isinstance(v, str):
            return v.strip()
        return v

    @field_validator("ingredient_positions", mode="before")
    @classmethod
    def validate_ingredient_positions(cls, v: object) -> list[int] | None:
        if v is None:
            return None
        if not isinstance(v, list):
            return None
        deduped: list[int] = []
        for item in v:
            # bool is an int subclass in Python: reject it explicitly.
            if isinstance(item, bool) or not isinstance(item, int):
                return None
            if item < 1:
                return None
            if item not in deduped:
                deduped.append(item)
        return deduped


class ParsedRecipe(BaseModel):
    """Validated recipe structure from Claude response."""

    model_config = {"extra": "forbid"}

    title: str = Field(min_length=1)
    servings: str | None = None
    prep_time: str | None = None
    cook_time: str | None = None
    ingredients: list[ParsedIngredient] = Field(default_factory=list)
    steps: list[ParsedStep] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("title", "servings", "prep_time", "cook_time", mode="before")
    @classmethod
    def strip_strings(cls, v: str | None) -> str | None:
        if isinstance(v, str):
            v = v.strip()
            return v if v else None
        return v

    @field_validator("steps", mode="after")
    @classmethod
    def normalize_step_positions(cls, v: list[ParsedStep]) -> list[ParsedStep]:
        """Re-index step positions to ensure consecutive ordering (no mutation).

        Preserves Claude's response order; reindexes positions sequentially.
        Carries ingredient_positions through the rebuild (Issue 1: dropping
        it here would silently discard every mapping).
        """
        return [
            ParsedStep(
                position=i,
                instruction=step.instruction,
                ingredient_positions=step.ingredient_positions,
            )
            for i, step in enumerate(v, start=1)
        ]

    @model_validator(mode="after")
    def range_check_ingredient_positions(self) -> "ParsedRecipe":
        """Degrade any step whose mapping references a nonexistent ingredient.

        Out-of-range references make the WHOLE step's mapping unknown (None),
        never a sanitized subset: [1, 99] with 3 ingredients becomes None,
        not [1]; [99] becomes None, not []. Valid steps keep their mapping.
        """
        count = len(self.ingredients)
        for step in self.steps:
            positions = step.ingredient_positions
            if positions is None:
                continue
            if any(p > count for p in positions):
                step.ingredient_positions = None
        return self


def _extract_text_from_response(message: anthropic.types.Message) -> str:
    """Safely extract and concatenate all text content from Anthropic message."""
    texts: list[str] = []
    for block in message.content:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            texts.append(text)
    if not texts:
        # PROVIDER-S1: empty provider output is a provider defect.
        raise ProviderError(
            "Provider response contained no text content",
            code=PROVIDER_BAD_RESPONSE,
        )
    return "\n".join(texts)


def _extract_json_from_text(response_text: str) -> dict[str, object]:
    """Extract JSON from Claude response, handling markdown code blocks."""
    # Try direct JSON parse first
    try:
        return json.loads(response_text)
    except json.JSONDecodeError:
        pass

    # Try to extract JSON from markdown code blocks
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", response_text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError as e:
            # PROVIDER-S1: unusable provider output — safe message only
            # (never echo the response body into diagnostics).
            raise ProviderError(
                "Provider response contained invalid JSON",
                code=PROVIDER_BAD_RESPONSE,
                provider_error_type=type(e).__name__,
            ) from e

    raise ProviderError(
        "Provider response was not parseable as JSON",
        code=PROVIDER_BAD_RESPONSE,
    )


def parse_recipe_image(
    image_path: str,
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> dict[str, object]:
    """Send image to Claude Vision, return validated parsed recipe data.

    Args:
        image_path: Path to recipe image or PDF
        client: Anthropic client (injected)
        config: Parser configuration (injected)
        logger: Logger instance (injected)

    Returns:
        Validated recipe data dict

    Raises:
        ImageProcessingError: If image cannot be processed
        ParsingError: If Claude response cannot be parsed or validated
    """
    filename = Path(image_path).name
    logger.info(f"Parsing recipe from: {filename}")

    image_data, media_type = encode_image(
        image_path,
        max_size=config.max_image_size,
        pdf_dpi=config.pdf_dpi,
        jpeg_quality=config.jpeg_quality,
    )

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": config.prompt,
                        },
                    ],
                }
            ],
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        # PROVIDER-S1: typed classification at the SDK boundary while the
        # original exception is in hand. (APITimeoutError subclasses
        # APIConnectionError and RateLimitError subclasses APIStatusError,
        # so this tuple covers all four provider classes.) Unexpected
        # non-SDK exceptions intentionally bubble to the route's generic
        # 500 handler — never relabeled as provider or user failures.
        raise provider_error_from_exception(e) from e

    response_text = _extract_text_from_response(message)
    raw_parsed = _extract_json_from_text(response_text)

    # Validate with Pydantic model
    try:
        validated = ParsedRecipe.model_validate(raw_parsed)
    except Exception as e:
        # PROVIDER-S1: the provider answered but its output doesn't match
        # the recipe schema — a provider-output defect, never blamed on
        # the user's content. Message stays safe (no response body).
        raise ProviderError(
            "Provider response failed recipe schema validation",
            code=PROVIDER_BAD_RESPONSE,
            provider_error_type=type(e).__name__,
        ) from e

    logger.info(f"Parsed recipe: {validated.title}")
    return validated.model_dump()


def parse_recipe_images(
    image_paths: list[str],
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> dict[str, object]:
    """Send one or more images to Claude Vision, return validated parsed recipe.

    For a single image, behaviour is identical to parse_recipe_image() — same
    prompt, same content structure, same validation.  For multiple images the
    multi-page prompt is prepended so Claude merges all pages into one recipe.

    Args:
        image_paths: Ordered list of image/PDF paths (1-5).
        client: Anthropic client (injected).
        config: Parser configuration (injected).
        logger: Logger instance (injected).

    Returns:
        Validated recipe data dict.

    Raises:
        ImageProcessingError: If any image cannot be processed.
        ParsingError: If Claude response cannot be parsed or validated.
    """
    if not image_paths:
        raise ImageProcessingError(
            "No images provided for parsing", code="NO_IMAGES"
        )

    logger.info(f"Parsing recipe from {len(image_paths)} image(s)")

    # Build content blocks — one image block per file, text prompt last.
    content: list[dict[str, object]] = []
    for path in image_paths:
        image_data, media_type = encode_image(
            path,
            max_size=config.max_image_size,
            pdf_dpi=config.pdf_dpi,
            jpeg_quality=config.jpeg_quality,
        )
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": image_data,
            },
        })

    prompt = MULTI_IMAGE_PARSE_PROMPT if len(image_paths) > 1 else config.prompt
    content.append({"type": "text", "text": prompt})

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            messages=[{"role": "user", "content": content}],
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        # PROVIDER-S1: typed classification at the SDK boundary while the
        # original exception is in hand. (APITimeoutError subclasses
        # APIConnectionError and RateLimitError subclasses APIStatusError,
        # so this tuple covers all four provider classes.) Unexpected
        # non-SDK exceptions intentionally bubble to the route's generic
        # 500 handler — never relabeled as provider or user failures.
        raise provider_error_from_exception(e) from e

    response_text = _extract_text_from_response(message)
    raw_parsed = _extract_json_from_text(response_text)

    try:
        validated = ParsedRecipe.model_validate(raw_parsed)
    except Exception as e:
        # PROVIDER-S1: the provider answered but its output doesn't match
        # the recipe schema — a provider-output defect, never blamed on
        # the user's content. Message stays safe (no response body).
        raise ProviderError(
            "Provider response failed recipe schema validation",
            code=PROVIDER_BAD_RESPONSE,
            provider_error_type=type(e).__name__,
        ) from e

    logger.info(f"Parsed recipe: {validated.title}")
    return validated.model_dump()


def parse_recipe_from_text(
    ocr_text: str,
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> dict[str, object]:
    """Parse recipe from raw text (if OCR done separately).

    Args:
        ocr_text: Raw recipe text
        client: Anthropic client (injected)
        config: Parser configuration (injected)
        logger: Logger instance (injected)

    Returns:
        Validated recipe data dict

    Raises:
        ParsingError: If Claude response cannot be parsed or validated
    """
    logger.info("Parsing recipe from text input")

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            messages=[
                {
                    "role": "user",
                    "content": f"{config.prompt}\n\nRecipe text:\n{ocr_text}",
                }
            ],
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        # PROVIDER-S1: typed classification at the SDK boundary while the
        # original exception is in hand. (APITimeoutError subclasses
        # APIConnectionError and RateLimitError subclasses APIStatusError,
        # so this tuple covers all four provider classes.) Unexpected
        # non-SDK exceptions intentionally bubble to the route's generic
        # 500 handler — never relabeled as provider or user failures.
        raise provider_error_from_exception(e) from e

    response_text = _extract_text_from_response(message)
    raw_parsed = _extract_json_from_text(response_text)

    try:
        validated = ParsedRecipe.model_validate(raw_parsed)
    except Exception as e:
        # PROVIDER-S1: the provider answered but its output doesn't match
        # the recipe schema — a provider-output defect, never blamed on
        # the user's content. Message stays safe (no response body).
        raise ProviderError(
            "Provider response failed recipe schema validation",
            code=PROVIDER_BAD_RESPONSE,
            provider_error_type=type(e).__name__,
        ) from e

    logger.info(f"Parsed recipe: {validated.title}")
    return validated.model_dump()
