"""
Tastelog: Grocery list generator - CLI wrapper.
Thin wrapper around api.core.grocery for command-line usage.
"""

import logging
import sys
from uuid import UUID

from api.core.config import get_settings
from api.core.exceptions import TastelogError
from api.core.grocery import get_grocery_list, list_grocery_lists, remake_recipe
from api.core.supabase_client import get_supabase_client


def display_grocery_list(list_data: dict[str, object]) -> None:
    """Pretty print a grocery list."""
    lst = list_data["list"]
    items = list_data["items"]

    print("\n" + "=" * 50)
    print(f"  {lst['name']}")
    print("=" * 50)

    for item in items:
        check = "[x]" if item["checked"] else "[ ]"
        qty = item.get("quantity") or ""
        unit = item.get("unit") or ""
        name = item["name"]

        # Show source recipe if available
        source = ""
        if item.get("recipes") and item["recipes"].get("title"):
            source = f" <- {item['recipes']['title']}"

        print(f"  {check} {qty} {unit} {name}{source}".strip())

    print("\n" + "=" * 50)
    print(f"Total items: {len(items)}")


def display_lists(lists: list[dict[str, object]]) -> None:
    """Display list of grocery lists."""
    if not lists:
        print("No grocery lists yet.")
        return

    print("\nRecent grocery lists:\n")
    for lst in lists:
        status = "[x] Done" if lst.get("completed_at") else "[ ] Active"
        print(f"  {status} {lst['name']}")
        print(f"       ID: {lst['id']}")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python grocery.py remake <recipe_id>  - Create list from recipe", file=sys.stderr)
        print("  python grocery.py show <list_id>      - Show a grocery list", file=sys.stderr)
        print("  python grocery.py lists               - Show recent lists", file=sys.stderr)
        return 2

    command = sys.argv[1]

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("tastelog.cli.grocery")

    try:
        settings = get_settings()
        supabase = get_supabase_client()
        user_id = UUID(str(settings.test_user_id))

        if command == "remake":
            if len(sys.argv) < 3:
                print("Error: Need recipe_id", file=sys.stderr)
                print("Usage: python grocery.py remake <recipe_id>", file=sys.stderr)
                return 2

            recipe_id = UUID(sys.argv[2])
            print(f"Creating grocery list from recipe: {recipe_id}")

            result = remake_recipe(
                recipe_id,
                user_id=user_id,
                supabase=supabase,
                logger=logger,
            )

            print(f"Created list: {result['list']['name']}")
            print(f"Added {result['items_added']} items")

            list_data = get_grocery_list(
                UUID(result["list"]["id"]),
                user_id=user_id,
                supabase=supabase,
            )
            display_grocery_list(list_data)

        elif command == "show":
            if len(sys.argv) < 3:
                print("Error: Need list_id", file=sys.stderr)
                print("Usage: python grocery.py show <list_id>", file=sys.stderr)
                return 2

            list_id = UUID(sys.argv[2])
            list_data = get_grocery_list(
                list_id,
                user_id=user_id,
                supabase=supabase,
            )
            display_grocery_list(list_data)

        elif command == "lists":
            lists = list_grocery_lists(
                user_id=user_id,
                supabase=supabase,
            )
            display_lists(lists)

        else:
            print(f"Unknown command: {command}", file=sys.stderr)
            print("Use: remake, show, or lists", file=sys.stderr)
            return 2

        return 0

    except TastelogError as e:
        logger.error(f"{e.code}: {e}" if e.code else str(e))
        return 1
    except Exception as e:
        logger.exception("Unhandled error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
