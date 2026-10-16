"""
Phase 14.2C — Deterministic seed fixtures.

Hand-authored templates + index-keyed generators. No randomness.
Re-running the seed against an empty load target produces bit-identical
inputs (modulo Postgres-issued UUIDs).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Pool sizes per ROADMAP §14.2 seed shape.
BASELINE_USER_COUNT = 100
RIFF_CAP_USER_COUNT = 50

# Email pattern: deterministic, scoped to the load-test domain.
PRIMARY_USER_EMAIL = "loadtest-primary@loadtest.tastelog.local"
EMAIL_DOMAIN = "loadtest.tastelog.local"

# Origin mix: 40% manual / 30% URL / 20% photo / 10% riff-saved (per §14.2).
ORIGINS = ("manual", "url", "photo", "riff-saved")
ORIGIN_BUCKETS = (4, 7, 9, 10)  # cumulative thresholds at modulo 10

# Known prefix the operator can pass as LOADTEST_SEARCH_QUERY.
SEARCH_QUERY_PREFIX = "Loadtest"

# Hand-authored templates.
INGREDIENT_TEMPLATES = (
    ("2", "cups", "all-purpose flour"),
    ("1", "tsp", "fine sea salt"),
    ("3", "tbsp", "olive oil"),
    ("1", None, "yellow onion"),
    ("2", "cloves", "garlic"),
    ("1", "lb", "boneless chicken thighs"),
    ("1", "can", "crushed tomatoes"),
    ("1/2", "cup", "fresh basil"),
    ("1", "tsp", "black pepper"),
    ("1", "cup", "chicken stock"),
)

STEP_TEMPLATES = (
    "Heat the olive oil in a large skillet over medium heat.",
    "Add the onion and saute until translucent, about 5 minutes.",
    "Stir in the garlic and cook for 30 seconds.",
    "Add the chicken and brown on all sides.",
    "Pour in the crushed tomatoes and stock, then simmer for 20 minutes.",
    "Stir in the basil, season, and serve.",
)


def primary_user_email() -> str:
    return PRIMARY_USER_EMAIL


def baseline_user_emails() -> list[str]:
    return [f"loadtest-baseline-{i:04d}@{EMAIL_DOMAIN}" for i in range(BASELINE_USER_COUNT)]


def riff_cap_user_emails() -> list[str]:
    return [f"loadtest-riffcap-{i:04d}@{EMAIL_DOMAIN}" for i in range(RIFF_CAP_USER_COUNT)]


def origin_for(recipe_index: int) -> str:
    bucket = recipe_index % 10
    for threshold, name in zip(ORIGIN_BUCKETS, ORIGINS):
        if bucket < threshold:
            return name
    return ORIGINS[-1]


def make_recipe_row(user_id: str, recipe_index: int, *, parent_recipe_id: str | None = None) -> dict:
    origin = origin_for(recipe_index)
    row: dict = {
        "user_id": user_id,
        "title": f"{SEARCH_QUERY_PREFIX} Recipe {recipe_index:04d} ({origin})",
        "servings": "4 servings",
        "prep_time": "15 min",
        "cook_time": "30 min",
        "confidence_score": 1.0,
        "favorite": recipe_index % 7 == 0,
    }
    if origin == "url":
        row["source_url"] = f"https://loadtest.example/recipes/{recipe_index}"
    elif origin == "photo":
        row["image_path"] = f"{user_id}/loadtest-{recipe_index}.jpg"
    elif origin == "riff-saved":
        row["parent_recipe_id"] = parent_recipe_id
        row["riff_label"] = "Loadtest riff"
    return row


def make_recipe_rows_for_user(user_id: str, recipe_offset: int, count: int = 5) -> list[dict]:
    """Return count recipe rows for one user. parent_recipe_id on riff-saved
    rows is None here — the seed orchestrator does a two-pass insert and
    rewrites it after the non-riff recipes have IDs."""
    return [make_recipe_row(user_id, recipe_offset + i) for i in range(count)]


def make_ingredient_rows(recipe_id: str, recipe_index: int) -> list[dict]:
    count = 3 + (recipe_index % 4)  # 3..6
    return [
        {
            "recipe_id": recipe_id,
            "position": i + 1,
            "quantity": qty,
            "unit": unit,
            "name": name,
        }
        for i, (qty, unit, name) in enumerate(INGREDIENT_TEMPLATES[:count])
    ]


def make_step_rows(recipe_id: str, recipe_index: int) -> list[dict]:
    count = 3 + (recipe_index % 4)  # 3..6
    return [
        {"recipe_id": recipe_id, "position": i + 1, "instruction": instruction}
        for i, instruction in enumerate(STEP_TEMPLATES[:count])
    ]


def make_grocery_list_rows(user_id: str, list_offset: int, count: int = 2) -> list[dict]:
    """grocery_lists requires `name` (auto-computed display name); `user_name`
    is the optional user override. We set BOTH equally for deterministic
    display behavior."""
    return [
        {
            "user_id": user_id,
            "name": f"{SEARCH_QUERY_PREFIX} List {list_offset + i:04d}",
            "user_name": f"{SEARCH_QUERY_PREFIX} List {list_offset + i:04d}",
        }
        for i in range(count)
    ]


def make_grocery_item_rows(list_id: str, recipe_id: str | None, list_index: int) -> list[dict]:
    """grocery_items has NO recipe_title column — the recipe title is
    embedded in source_recipes JSONB as `[{id, title}, ...]`. Mirrors
    `_make_source()` in api/core/grocery.py."""
    count = 3 + (list_index % 3)  # 3..5
    source_recipes: list[dict] | None = (
        [{"id": recipe_id, "title": f"{SEARCH_QUERY_PREFIX} Recipe (loadtest)"}]
        if recipe_id is not None
        else None
    )
    rows: list[dict] = []
    for i, (qty, unit, name) in enumerate(INGREDIENT_TEMPLATES[:count]):
        row: dict = {
            "list_id": list_id,
            "position": i + 1,
            "name": name,
            "quantity": qty,
            "unit": unit,
            "checked": False,
        }
        if recipe_id is not None:
            row["recipe_id"] = recipe_id
            row["source_recipes"] = source_recipes
        rows.append(row)
    return rows


def make_cook_event_rows(user_id: str, recipe_ids: list[str], user_index: int) -> list[dict]:
    """1-3 cook events per user, deterministic by user_index.

    cook_events.scale is TEXT (not numeric) — must be a string.
    cooked_at is in the past (UTC) to stay well under the API's 5-min
    future tolerance.
    """
    count = 1 + (user_index % 3)  # 1..3
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        {
            "user_id": user_id,
            "recipe_id": recipe_ids[i % len(recipe_ids)],
            "rating": 3 + (user_index % 3),  # 3..5
            "notes": "Loadtest cook event",
            "scale": "1",
            "cooked_at": (base + timedelta(days=user_index * 3 + i)).isoformat(),
        }
        for i in range(count)
    ]


def make_riff_session_row(user_id: str, source_recipe_id: str) -> dict:
    """riff_sessions anchor column is `source_recipe_id` (migration 018).
    CHECK constraint requires exactly one of source_recipe_id /
    source_draft_id non-null (migration 022); we set source_recipe_id only.
    """
    return {
        "user_id": user_id,
        "source_recipe_id": source_recipe_id,
        "entry_point": "recipe_detail",
    }


def make_riff_messages(session_id: str) -> list[dict]:
    """A short 4-message session: user → assistant → user → assistant.

    riff_messages has no seq column — ordering is by created_at (default
    NOW()). Bulk insert is fine for 14.2C seed purposes; Tier A scenarios
    do not query messages by ordering.
    """
    return [
        {"session_id": session_id, "role": "user", "content": "Loadtest prompt 1"},
        {"session_id": session_id, "role": "assistant", "content": "Loadtest reply 1"},
        {"session_id": session_id, "role": "user", "content": "Loadtest prompt 2"},
        {"session_id": session_id, "role": "assistant", "content": "Loadtest reply 2"},
    ]
