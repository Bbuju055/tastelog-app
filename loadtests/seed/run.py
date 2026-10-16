#!/usr/bin/env python3
"""
Phase 14.2C — Load-target seed CLI.

Operator runs this against the isolated load-target Supabase project. NOT
executed in Phase 14.2C. Execution belongs to Phase 14.2E.

Flow:
  1. Guards (loadtests.lib.guards via supabase_admin factory).
  2. Idempotently ensure primary + baseline + Riff-cap users via
     auth.admin.create_user; fall back to auth.admin.list_users one-page
     scan on already-exists.
  3. Insert recipes / ingredients / steps / grocery / cook / riff data
     via service-role table writes.
  4. Sign in as the primary user → mint a Supabase JWT.
  5. Write loadtests/output/loadtest-jwt.txt (mode 0600) and
     loadtests/output/seed-ids.json (mode 0600). Both gitignored.
  6. Print env-var NAMES to export. NEVER print values.

Required env vars (NAMES; values never echoed):
  LOADTEST_SUPABASE_URL
  LOADTEST_SUPABASE_SERVICE_KEY
  LOADTEST_SUPABASE_ANON_KEY
  LOADTEST_PROD_REF_REFUSE_FRAGMENT
  LOADTEST_SEED_USER_PASSWORD
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from loadtests.lib.guards import ENV_SEED_USER_PASSWORD, TargetGuardError, require_env
from loadtests.lib.supabase_admin import (
    get_load_target_admin_client,
    get_load_target_anon_client,
)
from loadtests.seed.fixtures import (
    BASELINE_USER_COUNT,
    RIFF_CAP_USER_COUNT,
    SEARCH_QUERY_PREFIX,
    baseline_user_emails,
    make_cook_event_rows,
    make_grocery_item_rows,
    make_grocery_list_rows,
    make_ingredient_rows,
    make_recipe_rows_for_user,
    make_riff_messages,
    make_riff_session_row,
    make_step_rows,
    primary_user_email,
    riff_cap_user_emails,
)

LOG = logging.getLogger("loadtests.seed")

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "output"
JWT_OUTPUT = OUTPUT_DIR / "loadtest-jwt.txt"
SEED_IDS_OUTPUT = OUTPUT_DIR / "seed-ids.json"

# Subset of baseline users that get a riff session (10-25 sessions across pool).
RIFF_SESSION_USER_COUNT = 15


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Seed the load-target Supabase project.")
    p.add_argument("--baseline-users", type=int, default=BASELINE_USER_COUNT)
    p.add_argument("--riff-cap-users", type=int, default=RIFF_CAP_USER_COUNT)
    p.add_argument("--dry-run", action="store_true", help="Run guards only.")
    return p.parse_args()


def _ensure_user(client, email: str, password: str) -> str:
    """Create-or-locate a user by email. Returns the user UUID.

    Idempotency: attempts create_user; on already-exists (or any other
    error), falls back to a one-page auth.admin.list_users scan keyed by
    email.

    TODO(14.2E): replace the broad except with a typed catch once the
    supabase-py + supabase-auth version range is pinned against the
    load target. The defensive getattr() on the list_users result handles
    SDK minor-version shape variance.
    """
    try:
        result = client.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        )
        return result.user.id
    except Exception:  # noqa: BLE001 — see TODO above
        page_result = client.auth.admin.list_users(page=1, per_page=1000)
        users = getattr(page_result, "users", page_result) or []
        for u in users:
            if getattr(u, "email", None) == email:
                return u.id
        raise TargetGuardError(
            "Could not create or locate user for the seeded email pattern. "
            "Operator may need to inspect auth.users manually."
        )


def _insert_user_recipes(client, user_id: str, recipe_offset: int) -> list[dict]:
    """Two-pass insert: non-riff first → riff-saved second with parent_recipe_id."""
    rows = make_recipe_rows_for_user(user_id, recipe_offset)
    non_riff = [r for r in rows if "parent_recipe_id" not in r]
    riff_saved = [r for r in rows if "parent_recipe_id" in r]

    inserted_non_riff = client.table("recipes").insert(non_riff).execute().data or []

    inserted_riff: list[dict] = []
    if riff_saved and inserted_non_riff:
        parent_id = inserted_non_riff[0]["id"]
        for r in riff_saved:
            r["parent_recipe_id"] = parent_id
        inserted_riff = client.table("recipes").insert(riff_saved).execute().data or []

    return inserted_non_riff + inserted_riff


def _insert_recipe_children(client, inserted_recipes: list[dict], recipe_offset: int) -> None:
    all_ingredients: list[dict] = []
    all_steps: list[dict] = []
    for i, recipe in enumerate(inserted_recipes):
        all_ingredients.extend(make_ingredient_rows(recipe["id"], recipe_offset + i))
        all_steps.extend(make_step_rows(recipe["id"], recipe_offset + i))
    if all_ingredients:
        client.table("recipe_ingredients").insert(all_ingredients).execute()
    if all_steps:
        client.table("recipe_steps").insert(all_steps).execute()


def _insert_user_grocery(client, user_id: str, list_offset: int, recipe_id: str | None) -> list[dict]:
    list_rows = make_grocery_list_rows(user_id, list_offset)
    inserted_lists = client.table("grocery_lists").insert(list_rows).execute().data or []
    all_items: list[dict] = []
    for i, lst in enumerate(inserted_lists):
        all_items.extend(make_grocery_item_rows(lst["id"], recipe_id, list_offset + i))
    if all_items:
        client.table("grocery_items").insert(all_items).execute()
    return inserted_lists


def _insert_user_cook_events(client, user_id: str, recipe_ids: list[str], user_index: int) -> None:
    if not recipe_ids:
        return
    rows = make_cook_event_rows(user_id, recipe_ids, user_index)
    if rows:
        client.table("cook_events").insert(rows).execute()


def _insert_riff_session(client, user_id: str, source_recipe_id: str) -> None:
    session_rows = client.table("riff_sessions").insert(
        make_riff_session_row(user_id, source_recipe_id)
    ).execute().data or []
    if not session_rows:
        return
    session_id = session_rows[0]["id"]
    messages = make_riff_messages(session_id)
    if messages:
        client.table("riff_messages").insert(messages).execute()


def _seed_one_baseline_user(client, user_id: str, user_index: int) -> tuple[list[dict], list[dict]]:
    """Returns (inserted_recipes, inserted_grocery_lists) for the user."""
    recipe_offset = user_index * 5
    list_offset = user_index * 2

    inserted_recipes = _insert_user_recipes(client, user_id, recipe_offset)
    _insert_recipe_children(client, inserted_recipes, recipe_offset)

    primary_recipe_id = inserted_recipes[0]["id"] if inserted_recipes else None
    inserted_lists = _insert_user_grocery(client, user_id, list_offset, primary_recipe_id)

    recipe_ids = [r["id"] for r in inserted_recipes]
    _insert_user_cook_events(client, user_id, recipe_ids, user_index)

    if user_index < RIFF_SESSION_USER_COUNT and primary_recipe_id is not None:
        _insert_riff_session(client, user_id, primary_recipe_id)

    return inserted_recipes, inserted_lists


def _seed_one_riff_cap_user(client, user_id: str) -> None:
    """Riff-cap users get ONE minimal recipe so live Riff requests can anchor."""
    minimal_recipe = {
        "user_id": user_id,
        "title": f"{SEARCH_QUERY_PREFIX} Riff-Cap Recipe",
        "confidence_score": 1.0,
    }
    client.table("recipes").insert(minimal_recipe).execute()


def _mint_jwt(anon_client, email: str, password: str) -> str:
    response = anon_client.auth.sign_in_with_password({"email": email, "password": password})
    if response.session is None or not response.session.access_token:
        raise TargetGuardError("sign_in_with_password did not return a session access_token.")
    return response.session.access_token


def _write_outputs(jwt: str, primary_recipe_id: str, primary_list_id: str) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    JWT_OUTPUT.write_text(jwt, encoding="utf-8")
    os.chmod(JWT_OUTPUT, 0o600)
    SEED_IDS_OUTPUT.write_text(
        json.dumps(
            {
                "primary_recipe_id": primary_recipe_id,
                "primary_list_id": primary_list_id,
                "search_query": SEARCH_QUERY_PREFIX,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    os.chmod(SEED_IDS_OUTPUT, 0o600)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _parse_args()

    try:
        admin_client = get_load_target_admin_client()
        anon_client = get_load_target_anon_client()
        password = require_env(ENV_SEED_USER_PASSWORD)
    except TargetGuardError as exc:
        LOG.error("Guard failed: %s", exc)
        return 2

    if args.dry_run:
        LOG.info("Dry run: guards passed. No writes performed.")
        return 0

    primary_email = primary_user_email()
    LOG.info("Ensuring primary load-test user …")
    primary_user_id = _ensure_user(admin_client, primary_email, password)
    LOG.info("Seeding primary user data …")
    primary_recipes, primary_lists = _seed_one_baseline_user(admin_client, primary_user_id, 0)

    LOG.info("Ensuring %d baseline users …", args.baseline_users)
    for i, email in enumerate(baseline_user_emails()[: args.baseline_users]):
        user_id = _ensure_user(admin_client, email, password)
        _seed_one_baseline_user(admin_client, user_id, i + 1)
        if (i + 1) % 10 == 0:
            LOG.info("  baseline progress: %d/%d", i + 1, args.baseline_users)

    LOG.info("Ensuring %d Riff-cap users …", args.riff_cap_users)
    for i, email in enumerate(riff_cap_user_emails()[: args.riff_cap_users]):
        user_id = _ensure_user(admin_client, email, password)
        _seed_one_riff_cap_user(admin_client, user_id)
        if (i + 1) % 10 == 0:
            LOG.info("  riff-cap progress: %d/%d", i + 1, args.riff_cap_users)

    LOG.info("Minting JWT for primary user …")
    jwt = _mint_jwt(anon_client, primary_email, password)

    if not primary_recipes or not primary_lists:
        raise TargetGuardError("Primary user has no recipes or lists; cannot record seed IDs.")
    primary_recipe_id = primary_recipes[0]["id"]
    primary_list_id = primary_lists[0]["id"]
    _write_outputs(jwt, primary_recipe_id, primary_list_id)

    LOG.info("Wrote JWT to %s (mode 0600)", JWT_OUTPUT.relative_to(REPO_ROOT))
    LOG.info("Wrote seed IDs to %s (mode 0600)", SEED_IDS_OUTPUT.relative_to(REPO_ROOT))
    LOG.info("To consume in k6, export (NAMES shown; never print values):")
    LOG.info("  LOADTEST_JWT, LOADTEST_RECIPE_ID, LOADTEST_LIST_ID, LOADTEST_SEARCH_QUERY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
