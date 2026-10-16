"""
Tastelog: Recipe search - CLI wrapper.
Thin wrapper around api.core.search for command-line usage.
"""

import logging
import sys
from uuid import UUID

from api.core.config import get_settings
from api.core.exceptions import TastelogError
from api.core.recipes import get_recipe
from api.core.search import search_recipes
from api.core.supabase_client import get_supabase_client


def display_search_results(results: list[dict[str, object]]) -> None:
    """Pretty print search results."""
    if not results:
        print("No recipes found.")
        return

    print(f"\nFound {len(results)} recipe(s):\n")

    for i, r in enumerate(results, 1):
        meta = []
        if r.get("servings"):
            meta.append(r["servings"])
        if r.get("prep_time"):
            meta.append(f"Prep: {r['prep_time']}")
        if r.get("cook_time"):
            meta.append(f"Cook: {r['cook_time']}")

        meta_str = f" ({', '.join(meta)})" if meta else ""
        print(f"  {i}. {r['title']}{meta_str}")
        print(f"     ID: {r['id']}")


def display_recipe(recipe_data: dict[str, object]) -> None:
    """Pretty print full recipe."""
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
        print("Usage: python search.py <query>", file=sys.stderr)
        print("Example: python search.py birria", file=sys.stderr)
        print("Example: python search.py ramen", file=sys.stderr)
        return 2

    query = " ".join(sys.argv[1:])

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("tastelog.cli.search")

    try:
        settings = get_settings()
        supabase = get_supabase_client()
        user_id = UUID(str(settings.test_user_id))

        print(f"Searching for: '{query}'")

        results = search_recipes(
            query,
            user_id=user_id,
            supabase=supabase,
            logger=logger,
        )

        display_search_results(results)

        # If exactly one result, show full recipe
        if len(results) == 1:
            print("\n--- Full Recipe ---")
            recipe_data = get_recipe(
                UUID(results[0]["id"]),
                user_id=user_id,
                supabase=supabase,
            )
            display_recipe(recipe_data)

        return 0

    except TastelogError as e:
        logger.error(f"{e.code}: {e}" if e.code else str(e))
        return 1
    except Exception as e:
        logger.exception("Unhandled error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
