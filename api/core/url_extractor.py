"""
Tastelog: URL recipe extraction pipeline.

Fetches a URL, extracts recipe data via JSON-LD (fast path) or Claude text
fallback (slow path). JSON-LD ingredients are structured via a separate Claude
call to maintain parity with photo-captured recipes.

Pure functions — no global state, explicit dependencies.
"""

from __future__ import annotations

import dataclasses
import ipaddress
import json
import logging
import re
import socket
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse
from uuid import UUID

import anthropic
import httpx
from bs4 import BeautifulSoup, Tag
from pydantic import ValidationError

from api.core.anthropic_client import (
    PROVIDER_BAD_RESPONSE,
    provider_error_from_exception,
)
from api.core.exceptions import (
    ParsingError,
    ProviderError,
    StorageError,
    TastelogError,
    URLFetchError,
)
from api.core.parser import ParsedIngredient, ParserConfig, parse_recipe_from_text
from api.core.step_mapping import (
    STEP_MAPPING_KEY,
    canonicalize_parsed_recipe,
    map_ingredients_to_steps,
)


# =============================================================================
# Exceptions
# =============================================================================


class DuplicateURLError(TastelogError):
    """User already has a recipe or pending draft from this URL."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        match_type: str,  # "recipe" or "draft"
        match_id: str,
        match_title: str,
    ):
        super().__init__(message, code=code)
        self.match_type = match_type
        self.match_id = match_id
        self.match_title = match_title


# =============================================================================
# URL Normalization
# =============================================================================

# Tracking params to strip (case-insensitive match on param name)
_TRACKING_PARAMS = frozenset({
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "ref",
    "source",
    "mc_cid",
    "mc_eid",
})


def normalize_url(url: str) -> str:
    """Normalize a URL for storage and duplicate comparison.

    - Lowercase scheme + host
    - Strip ``www.`` prefix from host
    - Strip trailing ``/`` from path
    - Drop fragment
    - Strip known tracking params only (preserve recipe-identity params)
    - Sort remaining query params for deterministic comparison
    """
    parsed = urlparse(url)

    scheme = parsed.scheme.lower()
    host = parsed.hostname or ""
    if host.startswith("www."):
        host = host[4:]

    # Preserve port if non-standard
    port = parsed.port
    netloc = host
    if port and not (scheme == "http" and port == 80) and not (scheme == "https" and port == 443):
        netloc = f"{host}:{port}"

    path = parsed.path.rstrip("/") or "/"

    # Strip tracking params, preserve everything else
    query_params = parse_qs(parsed.query, keep_blank_values=True)
    filtered = {
        k: v
        for k, v in query_params.items()
        if k.lower() not in _TRACKING_PARAMS
    }
    # Sort for deterministic comparison
    sorted_params = sorted(filtered.items())
    query_string = urlencode(sorted_params, doseq=True) if sorted_params else ""

    return urlunparse((scheme, netloc, path, "", query_string, ""))


# =============================================================================
# URL Fetching
# =============================================================================


_MAX_REDIRECTS = 5
_MAX_BODY_BYTES = 5 * 1024 * 1024
_FETCH_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
_FETCH_HEADERS = {
    "User-Agent": "Tastelog/1.0 (recipe parser)",
    "Accept": "text/html",
}


def _resolve_host(host: str) -> list[str]:
    """Resolve a hostname to every address DNS returns. Separate so tests can stub it."""
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise URLFetchError("DNS resolution failed", code="DNS_ERROR")
    return sorted({info[4][0] for info in infos})


def _is_public_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def _pin_to_public_address(url: str) -> tuple[httpx.URL, dict[str, str], dict[str, Any]]:
    """Validate ``url`` for server-side fetching and pin it to one public address.

    SSRF guard: every address the hostname resolves to must be public, and
    the request is sent to that exact address (so a second DNS lookup by the
    HTTP client cannot be rebound to a private one). The hostname is kept for
    the Host header and, over https, for SNI and certificate verification.

    Returns (url_to_request, extra_headers, request_extensions).
    """
    parsed = urlparse(url)
    host = parsed.hostname
    if parsed.scheme not in ("http", "https") or not host:
        raise URLFetchError("Invalid URL", code="INVALID_URL")

    try:
        ipaddress.ip_address(host)
        addresses = [host]
    except ValueError:
        addresses = _resolve_host(host)
    if not all(_is_public_address(a) for a in addresses):
        raise URLFetchError("URL points to a non-public address", code="BLOCKED_ADDRESS")

    address = addresses[0]
    netloc = f"[{address}]" if ":" in address else address
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    pinned = urlunparse((parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, ""))

    host_header = host if parsed.port is None else f"{host}:{parsed.port}"
    extensions: dict[str, Any] = {"sni_hostname": host} if parsed.scheme == "https" else {}
    return httpx.URL(pinned), {"Host": host_header}, extensions


def fetch_url(url: str, *, transport: httpx.BaseTransport | None = None) -> str:
    """Fetch URL content as HTML string.

    Follows at most 5 redirects, re-validating every hop against the SSRF
    guard, and reads at most 5 MiB of body.

    Raises URLFetchError with specific codes on failure.
    """
    try:
        with httpx.Client(timeout=_FETCH_TIMEOUT, follow_redirects=False, transport=transport) as client:
            current = url
            for _ in range(_MAX_REDIRECTS + 1):
                pinned, headers, extensions = _pin_to_public_address(current)
                with client.stream(
                    "GET", pinned, headers={**_FETCH_HEADERS, **headers}, extensions=extensions
                ) as response:
                    location = response.headers.get("location")
                    if response.is_redirect and location:
                        current = urljoin(current, location)
                        continue

                    if response.status_code != 200:
                        raise URLFetchError(
                            f"Page returned HTTP {response.status_code}",
                            code="NON_200",
                        )

                    content_type = response.headers.get("content-type", "")
                    if "text/html" not in content_type and "application/xhtml" not in content_type:
                        raise URLFetchError(
                            f"Not an HTML page: {content_type}",
                            code="NON_HTML",
                        )

                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > _MAX_BODY_BYTES:
                            raise URLFetchError("Page too large", code="TOO_LARGE")
                    return bytes(body).decode(response.charset_encoding or "utf-8", errors="replace")

            raise URLFetchError("Too many redirects", code="REDIRECT_LOOP")
    except httpx.TimeoutException:
        raise URLFetchError("Page took too long to load", code="TIMEOUT")
    except httpx.ConnectError as e:
        msg = str(e).lower()
        if "ssl" in msg or "certificate" in msg:
            raise URLFetchError("SSL/TLS error", code="SSL_ERROR")
        raise URLFetchError("Connection failed", code="CONNECTION_ERROR")
    except httpx.HTTPError:
        raise URLFetchError("HTTP request failed", code="CONNECTION_ERROR")


# =============================================================================
# ISO 8601 Duration Parsing
# =============================================================================

_ISO_DURATION_RE = re.compile(
    r"^PT"  # PT prefix (required — ISO 8601 time designator)
    r"(?:(\d+)H)?"  # hours
    r"(?:(\d+)M)?"  # minutes
    r"(?:(\d+)S)?$",  # seconds (ignored in display)
    re.IGNORECASE,
)


def parse_iso_duration(duration: str | None) -> str | None:
    """Convert ISO 8601 duration to human-readable string.

    PT30M → "30 min", PT1H15M → "1 hr 15 min", PT2H → "2 hr"
    Returns None for unparseable input.
    """
    if not duration or not isinstance(duration, str):
        return None

    match = _ISO_DURATION_RE.match(duration.strip())
    if not match:
        return None

    hours = int(match.group(1)) if match.group(1) else 0
    minutes = int(match.group(2)) if match.group(2) else 0

    if hours == 0 and minutes == 0:
        return None

    parts: list[str] = []
    if hours > 0:
        parts.append(f"{hours} hr")
    if minutes > 0:
        parts.append(f"{minutes} min")

    return " ".join(parts)


# =============================================================================
# Instruction Normalization
# =============================================================================


def _strip_html(text: str) -> str:
    """Strip HTML tags from a string."""
    raw = BeautifulSoup(text, "html.parser").get_text(separator=" ")
    # Collapse multiple spaces (nested tags produce extras)
    return re.sub(r" {2,}", " ", raw).strip()


def normalize_instructions(instructions: Any) -> list[dict[str, Any]]:
    """Normalize JSON-LD recipeInstructions into flat step dicts.

    Handles:
    - string[] → [{position, instruction}]
    - HowToStep[] → extract "text" field
    - HowToSection[] → flatten sections, extract steps
    - Single string → wrap in array
    """
    if not instructions:
        return []

    # Single string
    if isinstance(instructions, str):
        text = _strip_html(instructions).strip()
        return [{"position": 1, "instruction": text}] if text else []

    if not isinstance(instructions, list):
        return []

    steps: list[str] = []

    for item in instructions:
        if isinstance(item, str):
            text = _strip_html(item).strip()
            if text:
                steps.append(text)
        elif isinstance(item, dict):
            item_type = item.get("@type", "")

            # HowToStep — only trust "text" when type is explicitly step-like
            if item_type == "HowToStep":
                text = _strip_html(str(item.get("text", ""))).strip()
                if text:
                    steps.append(text)

            # HowToSection — flatten nested steps
            elif item_type == "HowToSection":
                section_items = item.get("itemListElement", [])
                if isinstance(section_items, list):
                    for sub in section_items:
                        if isinstance(sub, dict):
                            text = _strip_html(str(sub.get("text", ""))).strip()
                            if text:
                                steps.append(text)
                        elif isinstance(sub, str):
                            text = _strip_html(sub).strip()
                            if text:
                                steps.append(text)

    return [
        {"position": i + 1, "instruction": step}
        for i, step in enumerate(steps)
    ]


# =============================================================================
# JSON-LD Extraction
# =============================================================================


def _find_recipes_in_jsonld(data: Any) -> list[dict]:
    """Recursively find all Recipe objects in JSON-LD data."""
    recipes: list[dict] = []

    if isinstance(data, dict):
        type_val = data.get("@type", "")
        # @type can be a string or a list
        types = type_val if isinstance(type_val, list) else [type_val]
        if "Recipe" in types:
            recipes.append(data)

        # Check @graph array
        graph = data.get("@graph")
        if isinstance(graph, list):
            for item in graph:
                recipes.extend(_find_recipes_in_jsonld(item))

    elif isinstance(data, list):
        for item in data:
            recipes.extend(_find_recipes_in_jsonld(item))

    return recipes


def extract_jsonld_recipe(html: str) -> dict[str, Any] | None:
    """Extract schema.org/Recipe from JSON-LD in HTML.

    Returns a recipe dict with raw_ingredients (unstructured strings),
    normalized steps, and parsed metadata. Returns None if no Recipe found.
    """
    soup = BeautifulSoup(html, "html.parser")
    scripts = soup.find_all("script", type="application/ld+json")

    all_recipes: list[dict] = []
    for script in scripts:
        if not isinstance(script, Tag) or not script.string:
            continue
        try:
            data = json.loads(script.string)
        except (json.JSONDecodeError, TypeError):
            continue
        all_recipes.extend(_find_recipes_in_jsonld(data))

    if not all_recipes:
        return None

    # Multi-recipe: pick the one with most ingredients, tie-break by most steps
    def _recipe_score(r: dict) -> tuple[int, int]:
        ingredients = r.get("recipeIngredient", [])
        instructions = r.get("recipeInstructions", [])
        return (
            len(ingredients) if isinstance(ingredients, list) else 0,
            len(instructions) if isinstance(instructions, list) else 0,
        )

    recipe = max(all_recipes, key=_recipe_score)

    # Extract raw ingredient strings
    raw_ingredients: list[str] = []
    ingredients_data = recipe.get("recipeIngredient", [])
    if isinstance(ingredients_data, list):
        for ing in ingredients_data:
            if isinstance(ing, str):
                text = ing.strip()
                if text:
                    raw_ingredients.append(text)
            elif isinstance(ing, dict) and "text" in ing:
                text = str(ing["text"]).strip()
                if text:
                    raw_ingredients.append(text)

    # Normalize instructions
    steps = normalize_instructions(recipe.get("recipeInstructions"))

    # Extract servings
    servings_raw = recipe.get("recipeYield")
    servings: str | None = None
    if isinstance(servings_raw, list):
        servings = str(servings_raw[0]) if servings_raw else None
    elif servings_raw is not None:
        servings = str(servings_raw)
    if servings:
        servings = servings.strip() or None

    title = str(recipe.get("name") or "").strip()
    if not title:
        title = "Untitled Recipe"

    return {
        "title": title,
        "raw_ingredients": raw_ingredients,
        "steps": steps,
        "servings": servings,
        "prep_time": parse_iso_duration(recipe.get("prepTime")),
        "cook_time": parse_iso_duration(recipe.get("cookTime")),
    }


# =============================================================================
# HTML Text Extraction (fallback path)
# =============================================================================

_STRIP_TAGS = {"script", "style", "nav", "header", "footer", "aside", "form", "noscript"}
_MAX_TEXT_LENGTH = 8000


def extract_recipe_text(html: str) -> str:
    """Extract main text content from HTML, stripping boilerplate.

    Used as fallback when no JSON-LD is found. Returns cleaned text
    truncated to ~8000 chars for Claude context budget.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Remove boilerplate elements
    for tag_name in _STRIP_TAGS:
        for element in soup.find_all(tag_name):
            element.decompose()

    text = soup.get_text(separator="\n")

    # Collapse whitespace
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)
    # Reduce excessive blank lines (3+ → 2)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text[:_MAX_TEXT_LENGTH]


# =============================================================================
# Duplicate Detection
# =============================================================================


def find_existing_by_url(
    normalized_url: str,
    *,
    user_id: UUID,
    supabase: Any,
    logger: logging.Logger,
) -> dict[str, str] | None:
    """Check if user already has a recipe or pending draft from this URL.

    Returns:
        {"type": "recipe", "id": ..., "title": ...} or
        {"type": "draft", "id": ..., "title": ...} or
        None

    Non-fatal: logs and returns None on DB errors rather than blocking capture.
    """
    from datetime import datetime, timezone

    # Check recipes first (confirmed > pending)
    try:
        result = (
            supabase.table("recipes")
            .select("id, title")
            .eq("user_id", str(user_id))
            .eq("source_url", normalized_url)
            .limit(1)
            .execute()
        )
        if result.data:
            row = result.data[0]
            return {
                "type": "recipe",
                "id": str(row["id"]),
                "title": row.get("title", "Untitled"),
            }
    except Exception as e:
        logger.warning(f"Dedup check failed (recipes): {type(e).__name__}: {str(e)[:100]}")

    # Check pending drafts
    try:
        result = (
            supabase.table("recipe_drafts")
            .select("id, title")
            .eq("user_id", str(user_id))
            .eq("source_url", normalized_url)
            .gt("expires_at", datetime.now(timezone.utc).isoformat())
            .limit(1)
            .execute()
        )
        if result.data:
            row = result.data[0]
            return {
                "type": "draft",
                "id": str(row["id"]),
                "title": row.get("title", "Untitled"),
            }
    except Exception as e:
        logger.warning(f"Dedup check failed (drafts): {type(e).__name__}: {str(e)[:100]}")

    return None


# =============================================================================
# URL-Specific Text Parse Prompt
# =============================================================================

URL_TEXT_PARSE_PROMPT = """You are a recipe parser. Extract recipe data from the text of a web page.

Web pages often contain blog narrative, author introductions, ads, "related recipes" sections, newsletter signup prompts, and other non-recipe content. IGNORE all of that. Focus ONLY on the actual recipe content — typically found after a "Jump to Recipe" link or near the bottom of the page.

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
- Extract ONLY the recipe itself — not blog stories, tips sections, or "you might also like" content.
- "quantity" can be "1", "1/2", "2-3", etc. Use null if not specified.
- "unit" can be "cup", "tbsp", "oz", "lb", "g", etc. Use null if not specified (e.g., "2 eggs").
- "prep" is preparation notes like "diced", "minced", "room temperature". Use null if none.
- "raw_text" is the original text for this ingredient line as it appears on the page.
- "ingredient_positions" lists, for each step, the 1-based positions (in the "ingredients" array above) of every ingredient physically used or added in that step.
  - Use [] ONLY when you are confident the step uses no ingredients at all (preheating, resting, flipping).
  - Collective references ("the dry ingredients", "the sauce") include EVERY member ingredient.
  - An ingredient can appear in multiple steps if it is used more than once.
  - If you cannot confidently determine the COMPLETE set of ingredients a step uses, set "ingredient_positions" to null for that step. Never guess, and never leave an uncertain ingredient out of an otherwise-listed step: an incomplete list is worse than null.
  - Use only positions that exist in the ingredients array.
- "confidence" is your estimate (0-1) of how cleanly you could identify and extract the recipe from the page noise.
- If the page does not contain a recipe, return {"title": null, "confidence": 0}.
- Keep step instructions as complete sentences from the original recipe.
"""


# =============================================================================
# Claude Ingredient Structuring
# =============================================================================

INGREDIENT_STRUCTURING_PROMPT = """Parse each ingredient string into structured components.

Return ONLY a valid JSON array (no markdown, no explanation):

[
  {"quantity": "1", "unit": "cup", "name": "flour", "prep": "sifted", "raw_text": "1 cup flour, sifted"},
  ...
]

Rules:
- "quantity": numeric amount ("1", "1/2", "2-3"). null if not specified.
- "unit": measurement ("cup", "tbsp", "oz", "lb", "g"). null if not specified (e.g., "2 eggs").
  - For packaged items, include the container as the unit: "1 (14-ounce) can tomatoes" → quantity: "1", unit: "(14-ounce) can", name: "tomatoes".
  - "cloves" is a unit when counting: "6 cloves garlic" → quantity: "6", unit: "cloves", name: "garlic".
- "name": the ingredient itself, WITHOUT preparation notes or parenthetical descriptions. Always required.
- "prep": preparation notes ("diced", "minced", "at room temperature"). null if none.
  - "to taste" is prep: "salt and pepper to taste" → name: "salt and pepper", prep: "to taste".
- IMPORTANT: Do NOT duplicate information. If you extract prep from the name, remove it from the name.
  Example: "1 carrot (large, sliced 1/2-inch thick)" → name: "carrot", prep: "large, sliced 1/2-inch thick"
  NOT → name: "carrot (large, sliced 1/2-inch thick)", prep: "large, sliced 1/2-inch thick"
- "raw_text": the original input string, unchanged.
- Return one object per input string, in the same order.
- If unclear, extract what you can and set uncertain fields to null.

Examples:
1. "6 cloves garlic" → {"quantity": "6", "unit": "cloves", "name": "garlic", "prep": null}
2. "1 (14-ounce) can diced tomatoes" → {"quantity": "1", "unit": "(14-ounce) can", "name": "diced tomatoes", "prep": null}
3. "salt and pepper to taste" → {"quantity": null, "unit": null, "name": "salt and pepper", "prep": "to taste"}
4. "2 tablespoons olive oil, plus more for drizzling" → {"quantity": "2", "unit": "tablespoons", "name": "olive oil", "prep": "plus more for drizzling"}
5. "1 large egg, at room temperature" → {"quantity": "1", "unit": null, "name": "large egg", "prep": "at room temperature"}"""


_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")

# Punctuation stripped at boundaries only for normalized comparison
_BOUNDARY_PUNCT_RE = re.compile(r"^[.,;:\s]+|[.,;:\s]+$")


def _normalize_for_comparison(text: str) -> str:
    """Lowercase, strip whitespace and boundary punctuation for dedup comparison."""
    return _BOUNDARY_PUNCT_RE.sub("", text.lower())


def _dedup_prep_from_name(ingredient: dict[str, Any]) -> dict[str, Any]:
    """Strip trailing parenthetical from name if it duplicates the prep field.

    Handles the common LLM failure mode where:
      name: "carrot (large, sliced 1/2-inch thick)"
      prep: "large, sliced 1/2-inch thick"
    Should become:
      name: "carrot"
      prep: "large, sliced 1/2-inch thick"

    Uses normalized comparison (lowercase, boundary punctuation stripped)
    to catch near-duplicates while preserving legitimate parentheticals.
    """
    name = ingredient.get("name")
    prep = ingredient.get("prep")
    if not name or not prep:
        return ingredient

    # Check for trailing parenthetical that matches prep
    match = _TRAILING_PAREN_RE.search(name)
    if not match:
        return ingredient

    paren_content = match.group(0).strip()
    # Strip outer parens to compare inner text
    inner = paren_content[1:-1].strip()
    if _normalize_for_comparison(inner) == _normalize_for_comparison(prep):
        cleaned_name = name[:match.start()].strip()
        if cleaned_name:  # Don't produce empty name
            return {**ingredient, "name": cleaned_name}

    return ingredient


def structure_ingredients_with_claude(
    raw_ingredients: list[str],
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> list[dict[str, Any]]:
    """Structure raw ingredient strings via Claude.

    PROVIDER-S1: provider-caused failure propagates as a typed
    ProviderError instead of silently degrading to raw-text ingredients.
    The old fallback produced drafts whose scaling and grocery structure
    were unusable while the import still reported success.

    Returns:
        Structured ingredient dicts (one per input, order preserved).

    Raises:
        ProviderError: provider unavailable/rate-limited/timeout, or a
            provider response that is unusable for structuring.
    """
    if not raw_ingredients:
        return []

    # Build numbered list for Claude
    numbered = "\n".join(
        f"{i + 1}. {ing}" for i, ing in enumerate(raw_ingredients)
    )

    try:
        message = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            messages=[
                {
                    "role": "user",
                    "content": f"{INGREDIENT_STRUCTURING_PROMPT}\n\nIngredients:\n{numbered}",
                }
            ],
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        # PROVIDER-S1: typed classification at the SDK boundary. Non-SDK
        # exceptions bubble to the route's generic 500 handler.
        logger.warning(
            f"Ingredient structuring provider call failed: {type(e).__name__}"
        )
        raise provider_error_from_exception(e) from e

    # Parse response
    response_text = ""
    for block in getattr(message, "content", []):
        text = getattr(block, "text", None)
        if isinstance(text, str):
            response_text += text

    # Strip markdown fences if present
    response_text = response_text.strip()
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        # Remove first and last fence lines
        lines = [l for l in lines if not l.strip().startswith("```")]
        response_text = "\n".join(lines).strip()

    try:
        parsed = json.loads(response_text)
    except json.JSONDecodeError as e:
        logger.warning("Ingredient structuring returned invalid JSON")
        raise ProviderError(
            "Provider structuring response contained invalid JSON",
            code=PROVIDER_BAD_RESPONSE,
            provider_error_type=type(e).__name__,
        ) from e

    if not isinstance(parsed, list) or len(parsed) != len(raw_ingredients):
        got = len(parsed) if isinstance(parsed, list) else "non-list"
        logger.warning(
            f"Ingredient structuring count mismatch: expected {len(raw_ingredients)}, got {got}"
        )
        raise ProviderError(
            "Provider structuring response did not match the ingredient count",
            code=PROVIDER_BAD_RESPONSE,
        )

    # Validate each through ParsedIngredient
    structured: list[dict[str, Any]] = []
    for i, (item, raw) in enumerate(zip(parsed, raw_ingredients)):
        if not isinstance(item, dict):
            logger.warning(f"Ingredient {i} is not a dict")
            raise ProviderError(
                "Provider structuring response contained a non-object ingredient",
                code=PROVIDER_BAD_RESPONSE,
            )

        # Ensure raw_text is always the original string
        item["raw_text"] = raw

        try:
            validated = ParsedIngredient.model_validate(item)
            cleaned = _dedup_prep_from_name(validated.model_dump())
            structured.append(cleaned)
        except ValidationError as e:
            logger.warning(f"Ingredient {i} failed validation")
            raise ProviderError(
                "Provider structuring response failed ingredient validation",
                code=PROVIDER_BAD_RESPONSE,
                provider_error_type=type(e).__name__,
            ) from e

    return structured


# =============================================================================
# Top-Level Orchestrator
# =============================================================================


def extract_recipe_from_url(
    url: str,
    *,
    client: anthropic.Anthropic,
    config: ParserConfig,
    logger: logging.Logger,
) -> dict[str, Any]:
    """Extract recipe data from a URL.

    Tries JSON-LD fast path first (with Claude ingredient structuring),
    falls back to full text extraction + Claude parsing.

    Returns a dict compatible with create_draft() expectations.
    Raises URLFetchError or ParsingError on failure.
    """
    start = time.monotonic()
    normalized = normalize_url(url)

    html = fetch_url(url)

    # Fast path: JSON-LD structured data
    jsonld = extract_jsonld_recipe(html)

    if jsonld is not None:
        raw_ingredients = jsonld.get("raw_ingredients", [])

        # Structure ingredients via Claude. PROVIDER-S1: provider-caused
        # structuring failure propagates (no silent raw-text degradation).
        ingredients = structure_ingredients_with_claude(
            raw_ingredients,
            client=client,
            config=config,
            logger=logger,
        )

        confidence = 0.95

        # Issue 1: separate bounded SOFT-FAILURE step mapper. Deliberately
        # NOT folded into the structuring call above: its PROVIDER-S1
        # hard-fail contract (list response, exact count, per-item
        # validation) stays byte-identical, and a mapping failure can never
        # turn a successful ingredient extraction into a failed import.
        steps = jsonld.get("steps", [])
        mapping = map_ingredients_to_steps(
            ingredients,
            steps,
            client=client,
            config=config,
            logger=logger,
        )
        if mapping is None:
            mapping = [None] * len(steps)

        duration_ms = int((time.monotonic() - start) * 1000)
        logger.info(
            "url_capture",
            extra={
                "event": "url_capture",
                "url": url,
                "normalized_url": normalized,
                "has_jsonld": True,
                "path": "jsonld",
                "structuring": "success",
                "duration_ms": duration_ms,
                "title": jsonld.get("title", "unknown"),
                "ingredient_count": len(ingredients),
                "mapped_steps": sum(1 for m in mapping if m is not None),
            },
        )

        return {
            "title": jsonld["title"],
            "ingredients": ingredients,
            "steps": steps,
            "servings": jsonld.get("servings"),
            "prep_time": jsonld.get("prep_time"),
            "cook_time": jsonld.get("cook_time"),
            "confidence": confidence,
            STEP_MAPPING_KEY: mapping,
        }

    # Slow path: extract text, send to Claude with URL-specific prompt
    text = extract_recipe_text(html)
    if not text.strip():
        raise ParsingError("No recipe content found on page", code="NO_CONTENT")

    url_config = dataclasses.replace(config, prompt=URL_TEXT_PARSE_PROMPT)
    result = parse_recipe_from_text(text, client=client, config=url_config, logger=logger)

    duration_ms = int((time.monotonic() - start) * 1000)
    logger.info(
        "url_capture",
        extra={
            "event": "url_capture",
            "url": url,
            "normalized_url": normalized,
            "has_jsonld": False,
            "path": "fallback",
            "duration_ms": duration_ms,
            "title": result.get("title", "unknown"),
        },
    )

    # Issue 1: move per-step mapping out of the steps into the canonical
    # top-level key so recipe_drafts.steps keeps its rollback-safe shape.
    return canonicalize_parsed_recipe(result)
