"""Minimal deterministic API tests for Tastelog.

These tests verify basic endpoint behavior without hitting external services.
Fixtures (client, authed_client) are provided by conftest.py.
"""


def test_health_returns_ok(client):
    """Health endpoint returns exact expected payload."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_search_requires_query_param(authed_client):
    """Search endpoint requires q parameter (auth required to reach validator)."""
    resp = authed_client.get("/api/recipes/search")
    assert resp.status_code == 422


def test_get_recipe_invalid_uuid_returns_422(authed_client):
    """Get recipe with invalid UUID returns validation error."""
    resp = authed_client.get("/api/recipes/not-a-uuid")
    assert resp.status_code == 422


def test_get_grocery_list_invalid_uuid_returns_422(authed_client):
    """Get grocery list with invalid UUID returns validation error."""
    resp = authed_client.get("/api/grocery/lists/not-a-uuid")
    assert resp.status_code == 422


def test_get_recipe_returns_source_url():
    """11.C / Issue 3: get_recipe returns source_url via the snapshot RPC."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.recipes import get_recipe

    sb = MagicMock()
    sb.rpc.return_value.execute.return_value.data = {
        "recipe": {
            "source_url": "https://example.com/r",
            "content_rev": 1,
            "last_content_mutation_id": None,
        },
        "ingredients": [],
        "steps": [],
        "associations": [],
        "tags": [],
    }

    result = get_recipe(
        UUID("00000000-0000-0000-0000-000000000002"),
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        supabase=sb,
    )
    assert result["source_url"] == "https://example.com/r"
    # Issue 3: the read path is the coherent get_recipe_snapshot RPC.
    assert sb.rpc.call_args.args[0] == "get_recipe_snapshot"
    assert sb.rpc.call_args.args[1] == {
        "p_recipe_id": "00000000-0000-0000-0000-000000000002",
        "p_user_id": "00000000-0000-0000-0000-000000000001",
    }


def test_list_recipes_returns_source_url():
    """11.C: list_recipes selects and returns source_url from the recipes table."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.search import list_recipes

    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.order.return_value.range.return_value.execute.return_value.data = [
        {"id": "00000000-0000-0000-0000-000000000002", "source_url": "https://example.com/r"}
    ]
    sb.table.return_value.select.return_value.in_.return_value.order.return_value.execute.return_value.data = []

    result = list_recipes(user_id=UUID("00000000-0000-0000-0000-000000000001"), supabase=sb)
    assert result[0]["source_url"] == "https://example.com/r"
    assert any("source_url" in c.args[0] and "confidence_score" in c.args[0] for c in sb.table.return_value.select.call_args_list)


def test_search_recipes_fts_returns_all_required_fields():
    """11.C.2: FTS RPC wrapper must return all fields RecipeSearchResult requires."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.search import search_recipes_fts
    import logging

    sb = MagicMock()
    sb.rpc.return_value.execute.return_value.data = [
        {"id": "00000000-0000-0000-0000-000000000002", "title": "T",
         "source_url": "https://example.com/r", "servings": None,
         "prep_time": None, "cook_time": None, "confidence_score": 0.9,
         "favorite": False, "created_at": "2025-01-01T00:00:00+00:00",
         "updated_at": "2025-01-01T00:00:00+00:00"}
    ]
    sb.table.return_value.select.return_value.in_.return_value.order.return_value.execute.return_value.data = []

    result = search_recipes_fts("test", user_id=UUID("00000000-0000-0000-0000-000000000001"), supabase=sb, logger=logging.getLogger())
    row = result[0]
    for field in ("id", "title", "source_url", "favorite", "created_at", "updated_at"):
        assert field in row


# =============================================================================
# Phase 13.6.4-FU — Saved Riff Lineage projection in read paths
#
# Migration 018 added recipes.parent_recipe_id / riff_session_id / riff_label.
# Migration 020 (this ticket) extends the materialized view + FTS RPC to
# include them. The Python read paths must select them from the recipes
# table (or pass the RPC dict through unchanged for FTS) so the mobile
# Riff indicator behaves identically across detail, list, simple search,
# and FTS.
# =============================================================================


def test_get_recipe_returns_riff_lineage():
    """13.6.4-FU / Issue 3: get_recipe returns lineage + content_rev, and the
    internal last_content_mutation_id never leaves the API."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.recipes import get_recipe

    sb = MagicMock()
    sb.rpc.return_value.execute.return_value.data = {
        "recipe": {
            "parent_recipe_id": "00000000-0000-0000-0000-0000000000aa",
            "riff_session_id": "00000000-0000-0000-0000-0000000000bb",
            "riff_label": "Dairy-Free",
            "content_rev": 3,
            "last_content_mutation_id": "00000000-0000-0000-0000-0000000000cc",
        },
        "ingredients": [],
        "steps": [],
        "associations": [],
        "tags": [],
    }

    result = get_recipe(
        UUID("00000000-0000-0000-0000-000000000002"),
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        supabase=sb,
    )
    assert result["parent_recipe_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert result["riff_session_id"] == "00000000-0000-0000-0000-0000000000bb"
    assert result["riff_label"] == "Dairy-Free"
    assert result["content_rev"] == 3
    assert "last_content_mutation_id" not in result


def test_list_recipes_returns_riff_lineage():
    """13.6.4-FU: list_recipes SELECT includes parent_recipe_id / riff_session_id / riff_label."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.search import list_recipes

    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.order.return_value.range.return_value.execute.return_value.data = [
        {
            "id": "00000000-0000-0000-0000-000000000002",
            "parent_recipe_id": "00000000-0000-0000-0000-0000000000aa",
            "riff_session_id": "00000000-0000-0000-0000-0000000000bb",
            "riff_label": "Dairy-Free",
        }
    ]
    sb.table.return_value.select.return_value.in_.return_value.order.return_value.execute.return_value.data = []

    result = list_recipes(user_id=UUID("00000000-0000-0000-0000-000000000001"), supabase=sb)
    assert result[0]["parent_recipe_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert result[0]["riff_session_id"] == "00000000-0000-0000-0000-0000000000bb"
    assert result[0]["riff_label"] == "Dairy-Free"
    assert any(
        "parent_recipe_id" in c.args[0]
        and "riff_session_id" in c.args[0]
        and "riff_label" in c.args[0]
        for c in sb.table.return_value.select.call_args_list
    )


def test_search_recipes_simple_returns_riff_lineage():
    """13.6.4-FU: search_recipes_simple SELECT includes parent_recipe_id / riff_session_id / riff_label."""
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.search import search_recipes_simple

    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.ilike.return_value.limit.return_value.execute.return_value.data = [
        {
            "id": "00000000-0000-0000-0000-000000000002",
            "parent_recipe_id": "00000000-0000-0000-0000-0000000000aa",
            "riff_session_id": "00000000-0000-0000-0000-0000000000bb",
            "riff_label": "Dairy-Free",
        }
    ]
    sb.table.return_value.select.return_value.in_.return_value.order.return_value.execute.return_value.data = []

    result = search_recipes_simple(
        "alfredo",
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        supabase=sb,
    )
    assert result[0]["parent_recipe_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert result[0]["riff_session_id"] == "00000000-0000-0000-0000-0000000000bb"
    assert result[0]["riff_label"] == "Dairy-Free"
    assert any(
        "parent_recipe_id" in c.args[0]
        and "riff_session_id" in c.args[0]
        and "riff_label" in c.args[0]
        for c in sb.table.return_value.select.call_args_list
    )


def test_search_recipes_fts_returns_riff_lineage():
    """13.6.4-FU: FTS RPC pass-through preserves lineage columns when present in RPC return.

    Migration 020 extends the RPC RETURNS TABLE to include the three lineage
    columns. The Python wrapper does no projection, so the row dicts from
    .rpc().execute() flow through to the route layer unchanged.
    """
    from unittest.mock import MagicMock
    from uuid import UUID
    from api.core.search import search_recipes_fts
    import logging

    sb = MagicMock()
    sb.rpc.return_value.execute.return_value.data = [
        {
            "id": "00000000-0000-0000-0000-000000000002",
            "title": "T",
            "source_url": None,
            "servings": None,
            "prep_time": None,
            "cook_time": None,
            "confidence_score": 0.9,
            "favorite": False,
            "created_at": "2025-01-01T00:00:00+00:00",
            "updated_at": "2025-01-01T00:00:00+00:00",
            "parent_recipe_id": "00000000-0000-0000-0000-0000000000aa",
            "riff_session_id": "00000000-0000-0000-0000-0000000000bb",
            "riff_label": "Dairy-Free",
        }
    ]
    sb.table.return_value.select.return_value.in_.return_value.order.return_value.execute.return_value.data = []

    result = search_recipes_fts(
        "test",
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        supabase=sb,
        logger=logging.getLogger(),
    )
    row = result[0]
    assert row["parent_recipe_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert row["riff_session_id"] == "00000000-0000-0000-0000-0000000000bb"
    assert row["riff_label"] == "Dairy-Free"
