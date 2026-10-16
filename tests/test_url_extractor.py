"""Tests for api.core.url_extractor — pure functions + stubbed-client structuring
(no network, no real Claude)."""

import json
import logging
from unittest.mock import patch

import anthropic
import httpx
import pytest

from api.core.anthropic_client import (
    DEFAULT_CLAUDE_MODEL,
    PROVIDER_BAD_RESPONSE,
    PROVIDER_UNAVAILABLE,
)
from api.core.exceptions import ProviderError, URLFetchError
from api.core.parser import get_default_config
from api.core.url_extractor import (
    extract_recipe_from_url,
    fetch_url,
    normalize_url,
    parse_iso_duration,
    normalize_instructions,
    extract_jsonld_recipe,
    extract_recipe_text,
    structure_ingredients_with_claude,
    _dedup_prep_from_name,
)

_TEST_LOGGER = logging.getLogger("test.url_extractor")


class _StubBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class _StubMessage:
    def __init__(self, text: str) -> None:
        self.content = [_StubBlock(text)]


class _StubMessages:
    def __init__(self, *, text: str | None = None, exc: Exception | None = None):
        self._text = text
        self._exc = exc

    def create(self, **kwargs):
        if self._exc is not None:
            raise self._exc
        return _StubMessage(self._text or "")


class _StubClient:
    def __init__(self, *, text: str | None = None, exc: Exception | None = None):
        self.messages = _StubMessages(text=text, exc=exc)


def _not_found_error() -> anthropic.NotFoundError:
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx.Response(404, request=req, json={"type": "error"})
    return anthropic.NotFoundError("model not found", response=resp, body=None)


# =============================================================================
# normalize_url
# =============================================================================


class TestNormalizeUrl:
    def test_lowercases_host(self):
        assert normalize_url("https://AllRecipes.COM/recipe/123") == "https://allrecipes.com/recipe/123"

    def test_strips_www(self):
        assert normalize_url("https://www.example.com/recipe") == "https://example.com/recipe"

    def test_strips_trailing_slash(self):
        assert normalize_url("https://example.com/recipe/") == "https://example.com/recipe"

    def test_preserves_root_path(self):
        assert normalize_url("https://example.com/") == "https://example.com/"
        assert normalize_url("https://example.com") == "https://example.com/"

    def test_strips_fragment(self):
        assert normalize_url("https://example.com/recipe#comments") == "https://example.com/recipe"

    def test_strips_tracking_params(self):
        result = normalize_url("https://example.com/recipe?utm_source=fb&utm_medium=social&id=123")
        assert "utm_source" not in result
        assert "utm_medium" not in result
        assert "id=123" in result

    def test_strips_fbclid(self):
        result = normalize_url("https://example.com/recipe?fbclid=abc&page=2")
        assert "fbclid" not in result
        assert "page=2" in result

    def test_preserves_non_tracking_params(self):
        result = normalize_url("https://example.com/recipe?id=456&page=2")
        assert "id=456" in result
        assert "page=2" in result

    def test_sorts_remaining_params(self):
        result = normalize_url("https://example.com/recipe?z=1&a=2")
        assert result.endswith("?a=2&z=1")

    def test_combined_normalization(self):
        result = normalize_url("https://www.AllRecipes.COM/recipe/123/?utm_source=fb&id=456#top")
        assert result == "https://allrecipes.com/recipe/123?id=456"


# =============================================================================
# parse_iso_duration
# =============================================================================


class TestParseIsoDuration:
    def test_minutes_only(self):
        assert parse_iso_duration("PT30M") == "30 min"

    def test_hours_only(self):
        assert parse_iso_duration("PT2H") == "2 hr"

    def test_hours_and_minutes(self):
        assert parse_iso_duration("PT1H15M") == "1 hr 15 min"

    def test_zero_hours(self):
        assert parse_iso_duration("PT0H45M") == "45 min"

    def test_with_seconds(self):
        # Seconds are ignored in display
        assert parse_iso_duration("PT30M15S") == "30 min"

    def test_none_input(self):
        assert parse_iso_duration(None) is None

    def test_empty_string(self):
        assert parse_iso_duration("") is None

    def test_invalid_string(self):
        assert parse_iso_duration("30 minutes") is None

    def test_bare_p_rejected(self):
        # "P" alone is not valid (need PT prefix)
        assert parse_iso_duration("P") is None

    def test_case_insensitive(self):
        assert parse_iso_duration("pt1h30m") == "1 hr 30 min"

    def test_zero_duration(self):
        assert parse_iso_duration("PT0H0M") is None


# =============================================================================
# normalize_instructions
# =============================================================================


class TestNormalizeInstructions:
    def test_string_array(self):
        result = normalize_instructions(["Step 1", "Step 2"])
        assert result == [
            {"position": 1, "instruction": "Step 1"},
            {"position": 2, "instruction": "Step 2"},
        ]

    def test_howto_step_array(self):
        result = normalize_instructions([
            {"@type": "HowToStep", "text": "Preheat oven"},
            {"@type": "HowToStep", "text": "Mix ingredients"},
        ])
        assert len(result) == 2
        assert result[0]["instruction"] == "Preheat oven"

    def test_howto_section_array(self):
        result = normalize_instructions([
            {
                "@type": "HowToSection",
                "itemListElement": [
                    {"@type": "HowToStep", "text": "Step A"},
                    {"@type": "HowToStep", "text": "Step B"},
                ],
            },
            {
                "@type": "HowToSection",
                "itemListElement": [
                    {"@type": "HowToStep", "text": "Step C"},
                ],
            },
        ])
        assert len(result) == 3
        assert result[0]["instruction"] == "Step A"
        assert result[2]["instruction"] == "Step C"
        # Positions are sequential across sections
        assert [r["position"] for r in result] == [1, 2, 3]

    def test_single_string(self):
        result = normalize_instructions("Just one step")
        assert result == [{"position": 1, "instruction": "Just one step"}]

    def test_none(self):
        assert normalize_instructions(None) == []

    def test_empty_list(self):
        assert normalize_instructions([]) == []

    def test_strips_html_from_steps(self):
        result = normalize_instructions(["<p>Mix <strong>well</strong></p>"])
        assert result[0]["instruction"] == "Mix well"

    def test_skips_empty_strings(self):
        result = normalize_instructions(["Step 1", "", "  ", "Step 2"])
        assert len(result) == 2

    def test_non_step_objects_ignored(self):
        """Objects without HowToStep type and without text should be skipped."""
        result = normalize_instructions([
            {"@type": "HowToStep", "text": "Real step"},
            {"@type": "ImageObject", "url": "http://example.com/img.jpg"},
        ])
        assert len(result) == 1


# =============================================================================
# extract_jsonld_recipe
# =============================================================================


class TestExtractJsonldRecipe:
    def _wrap_html(self, jsonld_data) -> str:
        """Wrap JSON-LD data in a minimal HTML page."""
        return f"""
        <html><head>
        <script type="application/ld+json">{json.dumps(jsonld_data)}</script>
        </head><body></body></html>
        """

    def test_simple_recipe(self):
        data = {
            "@type": "Recipe",
            "name": "Chocolate Cake",
            "recipeIngredient": ["2 cups flour", "1 cup sugar"],
            "recipeInstructions": [
                {"@type": "HowToStep", "text": "Mix dry ingredients"},
            ],
            "recipeYield": "8 servings",
            "prepTime": "PT15M",
            "cookTime": "PT30M",
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["title"] == "Chocolate Cake"
        assert result["raw_ingredients"] == ["2 cups flour", "1 cup sugar"]
        assert len(result["steps"]) == 1
        assert result["servings"] == "8 servings"
        assert result["prep_time"] == "15 min"
        assert result["cook_time"] == "30 min"

    def test_graph_wrapper(self):
        data = {
            "@graph": [
                {"@type": "WebPage", "name": "Blog Post"},
                {
                    "@type": "Recipe",
                    "name": "Pasta",
                    "recipeIngredient": ["pasta", "sauce"],
                    "recipeInstructions": ["Cook pasta"],
                },
            ]
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["title"] == "Pasta"

    def test_type_array(self):
        """Some sites use @type as an array."""
        data = {
            "@type": ["Recipe", "CreativeWork"],
            "name": "Soup",
            "recipeIngredient": ["water"],
            "recipeInstructions": ["Boil"],
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["title"] == "Soup"

    def test_no_recipe_returns_none(self):
        data = {"@type": "Article", "name": "Blog Post"}
        assert extract_jsonld_recipe(self._wrap_html(data)) is None

    def test_empty_html(self):
        assert extract_jsonld_recipe("<html><body></body></html>") is None

    def test_malformed_json_skipped(self):
        html = '<html><head><script type="application/ld+json">{invalid json</script></head></html>'
        assert extract_jsonld_recipe(html) is None

    def test_multi_recipe_picks_most_ingredients(self):
        data = [
            {
                "@type": "Recipe",
                "name": "Simple",
                "recipeIngredient": ["a"],
                "recipeInstructions": ["step"],
            },
            {
                "@type": "Recipe",
                "name": "Complex",
                "recipeIngredient": ["a", "b", "c"],
                "recipeInstructions": ["step"],
            },
        ]
        html = f"""
        <html><head>
        <script type="application/ld+json">{json.dumps(data[0])}</script>
        <script type="application/ld+json">{json.dumps(data[1])}</script>
        </head></html>
        """
        result = extract_jsonld_recipe(html)
        assert result is not None
        assert result["title"] == "Complex"

    def test_howto_ingredient_objects(self):
        """Handle ingredient objects with 'text' field."""
        data = {
            "@type": "Recipe",
            "name": "Test",
            "recipeIngredient": [
                "2 cups flour",
                {"@type": "HowToIngredient", "text": "1 cup sugar"},
            ],
            "recipeInstructions": ["Mix"],
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["raw_ingredients"] == ["2 cups flour", "1 cup sugar"]

    def test_empty_title_fallback(self):
        data = {
            "@type": "Recipe",
            "name": "",
            "recipeIngredient": ["flour"],
            "recipeInstructions": ["Mix"],
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["title"] == "Untitled Recipe"

    def test_recipe_yield_as_list(self):
        data = {
            "@type": "Recipe",
            "name": "Test",
            "recipeYield": ["4", "4 servings"],
            "recipeIngredient": ["flour"],
            "recipeInstructions": ["Mix"],
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["servings"] == "4"

    def test_broken_jsonld_missing_key_fields(self):
        """JSON-LD has Recipe type but missing ingredients and instructions.

        Real-world sites sometimes have incomplete structured data.
        Should still return a result (with empty lists), not crash.
        """
        data = {
            "@type": "Recipe",
            "name": "Broken Recipe",
            # No recipeIngredient, no recipeInstructions
        }
        result = extract_jsonld_recipe(self._wrap_html(data))
        assert result is not None
        assert result["title"] == "Broken Recipe"
        assert result["raw_ingredients"] == []
        assert result["steps"] == []
        assert result["servings"] is None
        assert result["prep_time"] is None
        assert result["cook_time"] is None


# =============================================================================
# extract_recipe_text
# =============================================================================


class TestExtractRecipeText:
    def test_strips_script_and_style(self):
        html = """
        <html><body>
        <script>var x = 1;</script>
        <style>.foo { color: red; }</style>
        <p>Recipe content here</p>
        </body></html>
        """
        result = extract_recipe_text(html)
        assert "var x" not in result
        assert "color: red" not in result
        assert "Recipe content here" in result

    def test_strips_nav_and_footer(self):
        html = """
        <html><body>
        <nav>Home | About</nav>
        <main><p>Recipe content</p></main>
        <footer>Copyright 2024</footer>
        </body></html>
        """
        result = extract_recipe_text(html)
        assert "Home | About" not in result
        assert "Copyright" not in result
        assert "Recipe content" in result

    def test_truncates_long_text(self):
        html = f"<html><body><p>{'x' * 10000}</p></body></html>"
        result = extract_recipe_text(html)
        assert len(result) <= 8000

    def test_collapses_whitespace(self):
        html = "<html><body><p>A</p>\n\n\n\n\n<p>B</p></body></html>"
        result = extract_recipe_text(html)
        assert "\n\n\n" not in result


class TestDedupPrepFromName:
    def test_strips_duplicated_parenthetical(self):
        result = _dedup_prep_from_name({
            "quantity": "1",
            "unit": None,
            "name": "carrot (large, sliced 1/2-inch thick)",
            "prep": "large, sliced 1/2-inch thick",
            "raw_text": "1 carrot (large, sliced 1/2-inch thick)",
        })
        assert result["name"] == "carrot"
        assert result["prep"] == "large, sliced 1/2-inch thick"

    def test_case_insensitive_match(self):
        result = _dedup_prep_from_name({
            "quantity": "1",
            "unit": None,
            "name": "onion (Diced)",
            "prep": "diced",
            "raw_text": "1 onion (diced)",
        })
        assert result["name"] == "onion"

    def test_no_prep_unchanged(self):
        ing = {"quantity": "2", "unit": "cups", "name": "flour", "prep": None, "raw_text": "2 cups flour"}
        assert _dedup_prep_from_name(ing) == ing

    def test_no_parenthetical_unchanged(self):
        ing = {"quantity": "1", "unit": None, "name": "garlic", "prep": "minced", "raw_text": "1 garlic, minced"}
        assert _dedup_prep_from_name(ing) == ing

    def test_non_matching_parenthetical_unchanged(self):
        """Parenthetical that doesn't match prep should be preserved."""
        ing = {
            "quantity": "1",
            "unit": None,
            "name": "cheese (sharp cheddar)",
            "prep": "shredded",
            "raw_text": "1 cheese (sharp cheddar), shredded",
        }
        result = _dedup_prep_from_name(ing)
        assert result["name"] == "cheese (sharp cheddar)"

    def test_wont_produce_empty_name(self):
        """If stripping would empty the name, leave it alone."""
        ing = {
            "quantity": None,
            "unit": None,
            "name": "(diced)",
            "prep": "diced",
            "raw_text": "(diced)",
        }
        result = _dedup_prep_from_name(ing)
        assert result["name"] == "(diced)"


class TestDedupPrepFromNameFixtures:
    """Fixture-based regression suite for _dedup_prep_from_name.

    Each fixture is (input_dict, expected_name, expected_prep) — covering
    real-world ingredient patterns from popular recipe sites.
    """

    # --- Should dedup: parenthetical matches prep ---

    @pytest.mark.parametrize("name,prep,expected_name", [
        # Exact match
        ("carrot (large, sliced)", "large, sliced", "carrot"),
        # Case difference
        ("onion (Diced)", "diced", "onion"),
        ("bell pepper (Finely Chopped)", "finely chopped", "bell pepper"),
        # Extra whitespace inside parens
        ("garlic ( minced )", "minced", "garlic"),
        ("ginger (  peeled and grated  )", "peeled and grated", "ginger"),
        # Trailing whitespace on name before parens
        ("celery  (sliced thin)", "sliced thin", "celery"),
        # Mixed case + whitespace
        ("Jalapeño ( Seeded And Minced )", "seeded and minced", "Jalapeño"),
        # Punctuation inside parens that matches prep
        ("chicken thighs (boneless, skinless)", "boneless, skinless", "chicken thighs"),
        ("tomatoes (drained, chopped)", "drained, chopped", "tomatoes"),
    ])
    def test_dedup_matching_parenthetical(self, name: str, prep: str, expected_name: str):
        result = _dedup_prep_from_name({
            "quantity": "1", "unit": None, "name": name, "prep": prep, "raw_text": f"1 {name}",
        })
        assert result["name"] == expected_name
        assert result["prep"] == prep  # prep unchanged

    # --- Should NOT dedup: parenthetical is meaningful, not a prep duplicate ---

    @pytest.mark.parametrize("name,prep", [
        # Parenthetical is package size, not prep
        ("tomatoes (14-ounce can)", "drained"),
        ("coconut milk (full-fat)", "well shaken"),
        ("broth (low-sodium)", "warmed"),
        # Parenthetical is variety/type, not prep
        ("cheese (sharp cheddar)", "shredded"),
        ("rice (basmati)", "rinsed"),
        ("chocolate (70% cacao)", "chopped"),
        ("beans (black)", "drained and rinsed"),
        ("pepper (cayenne)", None),
        # Parenthetical is a size descriptor, prep is different
        ("zucchini (medium)", "spiralized"),
        ("avocado (ripe)", "mashed"),
        # No parenthetical at all
        ("garlic", "minced"),
        ("flour", "sifted"),
        ("butter", "softened"),
        # Parenthetical content doesn't match prep at all
        ("sugar (granulated)", "measured"),
        ("oil (extra virgin)", None),
    ])
    def test_preserves_meaningful_parenthetical(self, name: str, prep: str | None):
        ing = {"quantity": "1", "unit": None, "name": name, "prep": prep, "raw_text": f"1 {name}"}
        result = _dedup_prep_from_name(ing)
        assert result["name"] == name  # name unchanged

    # --- Edge cases ---

    @pytest.mark.parametrize("name,prep,expected_name", [
        # No prep → nothing to dedup
        ("carrot (large)", None, "carrot (large)"),
        # No name → return unchanged
        ("", "diced", ""),
        # Empty parens
        ("onion ()", "", "onion ()"),
        # Name is just the parenthetical
        ("(minced)", "minced", "(minced)"),
    ])
    def test_edge_cases(self, name: str, prep: str | None, expected_name: str):
        ing = {"quantity": None, "unit": None, "name": name, "prep": prep, "raw_text": name}
        result = _dedup_prep_from_name(ing)
        assert result["name"] == expected_name

    # --- No quantity / no unit patterns ---

    @pytest.mark.parametrize("raw_text,name,prep,expected_name", [
        ("salt and pepper to taste", "salt and pepper", "to taste", "salt and pepper"),
        ("fresh basil leaves (torn)", "fresh basil leaves (torn)", "torn", "fresh basil leaves"),
        ("parsley (roughly chopped)", "parsley (roughly chopped)", "roughly chopped", "parsley"),
        ("cilantro (chopped, for garnish)", "cilantro (chopped, for garnish)", "chopped, for garnish", "cilantro"),
    ])
    def test_no_quantity_patterns(self, raw_text: str, name: str, prep: str, expected_name: str):
        result = _dedup_prep_from_name({
            "quantity": None, "unit": None, "name": name, "prep": prep, "raw_text": raw_text,
        })
        assert result["name"] == expected_name

    # --- Complex real-world patterns ---

    @pytest.mark.parametrize("name,prep,should_dedup", [
        # Double parenthetical — only trailing one matters
        ("cream cheese (Philadelphia) (softened)", "softened", True),
        # Nested parens — regex won't match, should be left alone
        ("stock (chicken (or vegetable))", "chicken (or vegetable)", False),
    ])
    def test_complex_patterns(self, name: str, prep: str, should_dedup: bool):
        result = _dedup_prep_from_name({
            "quantity": "1", "unit": None, "name": name, "prep": prep, "raw_text": f"1 {name}",
        })
        if should_dedup:
            assert "(" not in result["name"] or result["name"].count("(") < name.count("(")
        else:
            assert result["name"] == name

    # --- Boundary punctuation normalization (targeted) ---

    @pytest.mark.parametrize("name,prep,expected_name", [
        # Trailing period in parens
        ("onion (diced.)", "diced", "onion"),
        # Trailing comma in parens
        ("garlic (minced,)", "minced", "garlic"),
        # Trailing semicolon in prep
        ("ginger (peeled and grated)", "peeled and grated;", "ginger"),
        # Leading/trailing whitespace + punctuation combo
        ("carrot ( sliced. )", "sliced", "carrot"),
    ])
    def test_boundary_punctuation_normalization(self, name: str, prep: str, expected_name: str):
        result = _dedup_prep_from_name({
            "quantity": "1", "unit": None, "name": name, "prep": prep, "raw_text": f"1 {name}",
        })
        assert result["name"] == expected_name
        assert result["prep"] == prep  # prep unchanged


class TestStructuredIngredientExpected:
    """Pin expected structured outputs for common ingredient patterns.

    These represent what we expect Claude to produce AND what _dedup_prep_from_name
    should preserve (i.e. these should pass through dedup unchanged).
    """

    @pytest.mark.parametrize("ingredient,expected", [
        # Cloves as unit
        (
            {"quantity": "6", "unit": "cloves", "name": "garlic", "prep": None, "raw_text": "6 cloves garlic"},
            {"quantity": "6", "unit": "cloves", "name": "garlic", "prep": None},
        ),
        # Parenthetical package unit
        (
            {"quantity": "1", "unit": "(14-ounce) can", "name": "diced tomatoes", "prep": None, "raw_text": "1 (14-ounce) can diced tomatoes"},
            {"quantity": "1", "unit": "(14-ounce) can", "name": "diced tomatoes", "prep": None},
        ),
        # "to taste" as prep
        (
            {"quantity": None, "unit": None, "name": "salt and pepper", "prep": "to taste", "raw_text": "salt and pepper to taste"},
            {"quantity": None, "unit": None, "name": "salt and pepper", "prep": "to taste"},
        ),
        # Trailing modifier as prep
        (
            {"quantity": "2", "unit": "tablespoons", "name": "olive oil", "prep": "plus more for drizzling", "raw_text": "2 tablespoons olive oil, plus more for drizzling"},
            {"quantity": "2", "unit": "tablespoons", "name": "olive oil", "prep": "plus more for drizzling"},
        ),
        # Comma-separated prep
        (
            {"quantity": "1", "unit": None, "name": "large egg", "prep": "at room temperature", "raw_text": "1 large egg, at room temperature"},
            {"quantity": "1", "unit": None, "name": "large egg", "prep": "at room temperature"},
        ),
        # No quantity, no unit, no prep
        (
            {"quantity": None, "unit": None, "name": "fresh basil leaves", "prep": None, "raw_text": "fresh basil leaves"},
            {"quantity": None, "unit": None, "name": "fresh basil leaves", "prep": None},
        ),
        # Range quantity
        (
            {"quantity": "2-3", "unit": None, "name": "green onions", "prep": "thinly sliced", "raw_text": "2-3 green onions, thinly sliced"},
            {"quantity": "2-3", "unit": None, "name": "green onions", "prep": "thinly sliced"},
        ),
        # Fraction quantity
        (
            {"quantity": "1/2", "unit": "cup", "name": "heavy cream", "prep": None, "raw_text": "1/2 cup heavy cream"},
            {"quantity": "1/2", "unit": "cup", "name": "heavy cream", "prep": None},
        ),
        # Parenthetical variety (should NOT be stripped by dedup)
        (
            {"quantity": "1", "unit": "cup", "name": "rice (basmati)", "prep": "rinsed", "raw_text": "1 cup rice (basmati), rinsed"},
            {"quantity": "1", "unit": "cup", "name": "rice (basmati)", "prep": "rinsed"},
        ),
        # Multiple package size
        (
            {"quantity": "2", "unit": "(15-ounce) cans", "name": "chickpeas", "prep": "drained and rinsed", "raw_text": "2 (15-ounce) cans chickpeas, drained and rinsed"},
            {"quantity": "2", "unit": "(15-ounce) cans", "name": "chickpeas", "prep": "drained and rinsed"},
        ),
    ])
    def test_expected_structure_survives_dedup(self, ingredient: dict, expected: dict):
        """Verify that correctly structured ingredients pass through dedup unchanged."""
        result = _dedup_prep_from_name(ingredient)
        assert result["quantity"] == expected["quantity"]
        assert result["unit"] == expected["unit"]
        assert result["name"] == expected["name"]
        assert result["prep"] == expected["prep"]
        assert result["raw_text"] == ingredient["raw_text"]


# =============================================================================
# structure_ingredients_with_claude — PROVIDER-S1 fail-honest contract.
# Provider-caused failure propagates as a typed ProviderError; the old
# silent raw-text fallback is gone (it created degraded drafts that the
# import still reported as full success).
# =============================================================================


class TestStructureIngredientsProviderContract:
    def _call(self, client, raw=None):
        return structure_ingredients_with_claude(
            raw if raw is not None else ["2 cups flour", "1 egg"],
            client=client,
            config=get_default_config(),
            logger=_TEST_LOGGER,
        )

    def test_provider_status_error_propagates_typed(self):
        exc = _not_found_error()
        with pytest.raises(ProviderError) as ei:
            self._call(_StubClient(exc=exc))
        assert ei.value.code == PROVIDER_UNAVAILABLE
        assert ei.value.provider_status == 404
        assert ei.value.__cause__ is exc

    def test_invalid_json_response_is_bad_response(self):
        with pytest.raises(ProviderError) as ei:
            self._call(_StubClient(text="this is not json"))
        assert ei.value.code == PROVIDER_BAD_RESPONSE
        # Safe diagnostics: never echo the provider response body.
        assert "this is not json" not in str(ei.value)

    def test_count_mismatch_is_bad_response(self):
        one_item = json.dumps([
            {"quantity": "2", "unit": "cups", "name": "flour", "prep": None, "raw_text": "x"}
        ])
        with pytest.raises(ProviderError) as ei:
            self._call(_StubClient(text=one_item))
        assert ei.value.code == PROVIDER_BAD_RESPONSE

    def test_unexpected_exception_bubbles_unwrapped(self):
        with pytest.raises(ValueError):
            self._call(_StubClient(exc=ValueError("boom")))

    def test_success_returns_structured_with_original_raw_text(self):
        payload = json.dumps([
            {"quantity": "2", "unit": "cups", "name": "flour", "prep": None, "raw_text": "ignored"},
            {"quantity": "1", "unit": None, "name": "egg", "prep": None, "raw_text": "ignored"},
        ])
        result = self._call(_StubClient(text=payload))
        assert [r["name"] for r in result] == ["flour", "egg"]
        # raw_text is always the original input line, not Claude's echo.
        assert [r["raw_text"] for r in result] == ["2 cups flour", "1 egg"]

    def test_empty_input_returns_empty_without_provider_call(self):
        class _ExplodingClient:
            @property
            def messages(self):  # pragma: no cover - would fail the test
                raise AssertionError("provider must not be called for empty input")

        assert self._call(_ExplodingClient(), raw=[]) == []

    def test_parser_default_config_uses_shared_model_constant(self):
        assert get_default_config().model == DEFAULT_CLAUDE_MODEL
        assert DEFAULT_CLAUDE_MODEL == "claude-sonnet-4-6"


# =============================================================================
# Issue 1: JSON-LD mapping isolation (extract_recipe_from_url)
# =============================================================================


class _SequencedMessages:
    """Return scripted responses (or raise scripted exceptions) per call."""

    def __init__(self, script: list):
        self._script = list(script)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return _StubMessage(item)


class _SequencedClient:
    def __init__(self, script: list):
        self.messages = _SequencedMessages(script)


_JSONLD_HTML = (
    "<html><head><script type=\"application/ld+json\">"
    + json.dumps(
        {
            "@type": "Recipe",
            "name": "Test Pasta",
            "recipeIngredient": ["2 cups flour", "1 tsp salt"],
            "recipeInstructions": [
                "Preheat the oven.",
                "Mix everything together.",
            ],
        }
    )
    + "</script></head><body></body></html>"
)

_STRUCTURING_RESPONSE = json.dumps(
    [
        {"quantity": "2", "unit": "cups", "name": "flour", "prep": None},
        {"quantity": "1", "unit": "tsp", "name": "salt", "prep": None},
    ]
)


class TestJsonLdMappingIsolation:
    """The hardened structuring call is untouched; the mapper is a separate
    soft-failure call whose degradation can never fail the import."""

    def _extract(self, script: list) -> dict:
        client = _SequencedClient(script)
        with patch(
            "api.core.url_extractor.fetch_url", return_value=_JSONLD_HTML
        ):
            result = extract_recipe_from_url(
                "https://example.com/pasta",
                client=client,
                config=get_default_config(),
                logger=logging.getLogger("test"),
            )
        return result, client

    def test_valid_mapper_populates_canonical_key(self):
        mapper_response = json.dumps(
            [
                {"step": 1, "ingredients": []},
                {"step": 2, "ingredients": [1, 2]},
            ]
        )
        result, client = self._extract(
            [_STRUCTURING_RESPONSE, mapper_response]
        )
        assert result["step_ingredient_positions"] == [[], [1, 2]]
        # Public steps shape stays clean (rollback safety).
        for step in result["steps"]:
            assert set(step.keys()) == {"position", "instruction"}
        assert len(client.messages.calls) == 2

    def test_mapper_garbage_degrades_to_unknown_but_import_succeeds(self):
        result, _ = self._extract([_STRUCTURING_RESPONSE, "not json"])
        assert result["title"] == "Test Pasta"
        assert len(result["ingredients"]) == 2
        assert result["step_ingredient_positions"] == [None, None]

    def test_mapper_exception_degrades_to_unknown_but_import_succeeds(self):
        result, _ = self._extract(
            [_STRUCTURING_RESPONSE, _not_found_error()]
        )
        assert result["title"] == "Test Pasta"
        assert result["step_ingredient_positions"] == [None, None]

    def test_structuring_failure_still_hard_fails_and_mapper_never_runs(self):
        client = _SequencedClient([_not_found_error()])
        with patch(
            "api.core.url_extractor.fetch_url", return_value=_JSONLD_HTML
        ):
            with pytest.raises(ProviderError):
                extract_recipe_from_url(
                    "https://example.com/pasta",
                    client=client,
                    config=get_default_config(),
                    logger=logging.getLogger("test"),
                )
        # Only the structuring call happened; isolation holds both ways.
        assert len(client.messages.calls) == 1


class TestTextFallbackCanonicalization:
    def test_fallback_result_is_canonicalized(self):
        recipe_json = json.dumps(
            {
                "title": "Fallback Soup",
                "servings": None,
                "prep_time": None,
                "cook_time": None,
                "confidence": 0.8,
                "ingredients": [
                    {"quantity": "1", "unit": "cup", "name": "lentils"}
                ],
                "steps": [
                    {
                        "position": 1,
                        "instruction": "Simmer the lentils.",
                        "ingredient_positions": [1],
                    }
                ],
            }
        )
        client = _StubClient(text=recipe_json)
        with patch(
            "api.core.url_extractor.fetch_url",
            return_value="<html><body><p>Recipe text here</p></body></html>",
        ):
            result = extract_recipe_from_url(
                "https://example.com/soup",
                client=client,
                config=get_default_config(),
                logger=logging.getLogger("test"),
            )
        assert result["step_ingredient_positions"] == [[1]]
        assert result["steps"] == [
            {"position": 1, "instruction": "Simmer the lentils."}
        ]


# =============================================================================
# fetch_url: SSRF guard
# =============================================================================

_PUBLIC_IP = "93.184.216.34"
_HTML_HEADERS = {"content-type": "text/html; charset=utf-8"}


def _resolver(table: dict[str, list[str]]):
    """Stub DNS: hostname -> addresses. Unknown names raise like gaierror would."""

    def resolve(host: str) -> list[str]:
        if host not in table:
            raise URLFetchError("DNS resolution failed", code="DNS_ERROR")
        return table[host]

    return resolve


class TestFetchUrlSsrfGuard:
    def _fetch(self, url: str, handler, table: dict[str, list[str]]) -> str:
        with patch("api.core.url_extractor._resolve_host", side_effect=_resolver(table)):
            return fetch_url(url, transport=httpx.MockTransport(handler))

    def test_direct_private_ip_is_blocked_before_any_request(self):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, headers=_HTML_HEADERS, text="<html></html>")

        with pytest.raises(URLFetchError) as exc:
            self._fetch("http://10.0.0.1/recipe", handler, {})
        assert exc.value.code == "BLOCKED_ADDRESS"
        assert calls == []

    @pytest.mark.parametrize(
        "address",
        ["127.0.0.1", "169.254.169.254", "192.168.1.10", "172.16.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"],
    )
    def test_hostname_resolving_to_non_public_address_is_blocked(self, address: str):
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("must not connect")

        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://evil.test/", handler, {"evil.test": [address]})
        assert exc.value.code == "BLOCKED_ADDRESS"

    def test_mixed_public_and_private_answer_is_blocked(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("must not connect")

        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://evil.test/", handler, {"evil.test": [_PUBLIC_IP, "10.0.0.5"]})
        assert exc.value.code == "BLOCKED_ADDRESS"

    def test_connection_is_pinned_to_validated_address_with_hostname_tls(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, headers=_HTML_HEADERS, text="<html>ok</html>")

        html = self._fetch("https://example.com/recipe?x=1", handler, {"example.com": [_PUBLIC_IP]})
        assert html == "<html>ok</html>"
        assert len(seen) == 1
        req = seen[0]
        assert req.url.host == _PUBLIC_IP
        assert req.url.path == "/recipe" and req.url.query == b"x=1"
        assert req.headers["host"] == "example.com"
        assert req.extensions["sni_hostname"] == "example.com"

    def test_redirect_from_public_to_private_is_blocked(self):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers["host"])
            return httpx.Response(302, headers={"location": "http://10.0.0.1/internal"})

        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://example.com/", handler, {"example.com": [_PUBLIC_IP]})
        assert exc.value.code == "BLOCKED_ADDRESS"
        assert seen == ["example.com"]

    def test_redirect_to_hostname_resolving_privately_is_blocked(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"location": "https://internal.test/"})

        table = {"example.com": [_PUBLIC_IP], "internal.test": ["10.1.2.3"]}
        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://example.com/", handler, table)
        assert exc.value.code == "BLOCKED_ADDRESS"

    def test_relative_redirect_is_followed_against_current_hostname(self):
        seen: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((request.headers["host"], request.url.path))
            if request.url.path == "/a":
                return httpx.Response(301, headers={"location": "/b"})
            return httpx.Response(200, headers=_HTML_HEADERS, text="<html>b</html>")

        html = self._fetch("https://example.com/a", handler, {"example.com": [_PUBLIC_IP]})
        assert html == "<html>b</html>"
        assert seen == [("example.com", "/a"), ("example.com", "/b")]

    def test_redirect_cap(self):
        hops: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            hops.append(request.url.path)
            return httpx.Response(302, headers={"location": f"/{len(hops)}"})

        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://example.com/0", handler, {"example.com": [_PUBLIC_IP]})
        assert exc.value.code == "REDIRECT_LOOP"
        assert len(hops) == 6  # initial request + 5 redirects, then stop

    def test_oversize_body_is_rejected_without_buffering_everything(self):
        def body():
            for _ in range(8):
                yield b"x" * (1024 * 1024)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers=_HTML_HEADERS, stream=httpx.ByteStream(b"".join(body())))

        with pytest.raises(URLFetchError) as exc:
            self._fetch("https://example.com/", handler, {"example.com": [_PUBLIC_IP]})
        assert exc.value.code == "TOO_LARGE"

    def test_unsupported_scheme_is_rejected(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("must not connect")

        with pytest.raises(URLFetchError) as exc:
            self._fetch("ftp://example.com/", handler, {"example.com": [_PUBLIC_IP]})
        assert exc.value.code == "INVALID_URL"
