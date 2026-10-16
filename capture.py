"""
Tastelog: Full capture flow - CLI wrapper.
Thin wrapper around api.core for command-line usage.
"""

import logging
import sys
from uuid import UUID

import anthropic

from api.core.config import get_settings
from api.core.exceptions import TastelogError
from api.core.parser import get_default_config
from api.core.recipes import capture_recipe, get_recipe
from api.core.supabase_client import get_supabase_client


def display_recipe(recipe_data: dict[str, object]) -> None:
    """Pretty print a recipe."""
    r = recipe_data["recipe"]
    ingredients = recipe_data["ingredients"]
    steps = recipe_data["steps"]

    print("\n" + "=" * 50)
    print(f"  {r['title']}")
    print("=" * 50)

    if r.get("servings") or r.get("prep_time") or r.get("cook_time"):
        meta = []
        if r.get("servings"):
            meta.append(r["servings"])
        if r.get("prep_time"):
            meta.append(f"Prep: {r['prep_time']}")
        if r.get("cook_time"):
            meta.append(f"Cook: {r['cook_time']}")
        print(" | ".join(meta))
        print("-" * 50)

    print("\n  INGREDIENTS")
    for ing in ingredients:
        qty = ing.get("quantity") or ""
        unit = ing.get("unit") or ""
        name = ing["name"]
        prep = f", {ing['prep']}" if ing.get("prep") else ""
        print(f"  - {qty} {unit} {name}{prep}".strip())

    print("\n  STEPS")
    for step in steps:
        print(f"  {step['position']}. {step['instruction']}")

    print("\n" + "=" * 50)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python capture.py <image_path>", file=sys.stderr)
        print("Example: python capture.py test_recipe.jpg", file=sys.stderr)
        return 2

    image_path = sys.argv[1]

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("tastelog.cli.capture")

    try:
        settings = get_settings()
        supabase = get_supabase_client()
        anthropic_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        parser_config = get_default_config()

        print(f"Capturing recipe from: {image_path}")

        # Capture recipe (upload, parse, store)
        recipe = capture_recipe(
            image_path,
            user_id=UUID(str(settings.test_user_id)),
            supabase=supabase,
            anthropic_client=anthropic_client,
            parser_config=parser_config,
            logger=logger,
        )

        print(f"Created recipe: {recipe['id']}")

        # Get full recipe with ingredients and steps
        recipe_data = get_recipe(
            UUID(recipe["id"]),
            user_id=UUID(str(settings.test_user_id)),
            supabase=supabase,
        )

        # Display result
        display_recipe(recipe_data)

        print(f"\nRecipe saved! ID: {recipe['id']}")
        return 0

    except TastelogError as e:
        logger.error(f"{e.code}: {e}" if e.code else str(e))
        return 1
    except Exception as e:
        logger.exception("Unhandled error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
