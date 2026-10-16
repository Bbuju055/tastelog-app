"""
Tests for PATCH /api/recipes/{recipe_id}, Issue 3 saved-recipe editing.

Covers the plan section 11 matrix at the API layer:
  - auth, TL404 both cases, typed 409, narrow idempotent replay
  - the binding operation-validation invariants (section 6.8) including
    malformed combinations, every violation is 422 with ZERO mutation
    (the update RPC is never called)
  - the genuine no-op rule: no provider call, no mutation, no rev advance
  - tri-state scalar fields via model_fields_set
  - the legacy-row proof (untouched rows never serialized; sibling edits
    and reorders leave them out of the wire payload entirely)
  - invalidation-scope classification per the section 8.2 table
  - the optimistic two-phase lifecycle: snapshot read and RPC commit are
    separate calls AROUND the mapper (no DB lock during provider work);
    a revision that moves during Phase B discards the computed mapping
    (typed 409, zero mutation)
  - the bounded mapper call (with_options(timeout=5.0, max_retries=0)),
    mapper success / timeout-soft-fail / partial results
  - no str(e) leakage; full response including content_rev

The Supabase client is mocked at the get_db dependency; the mapper and the
anthropic client factory are stubbed autouse so no test can ever reach the
live provider (.env carries a real key).
"""

import copy
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from api.dependencies import get_current_user_id, get_db, get_user_db
from tests.conftest import FAKE_USER_ID

RECIPE_ID = "00000000-0000-0000-0000-00000000ed01"
URL = f"/api/recipes/{RECIPE_ID}"

ING1 = "00000000-0000-0000-0000-0000000000a1"  # legacy raw_text row
ING2 = "00000000-0000-0000-0000-0000000000a2"
ING3 = "00000000-0000-0000-0000-0000000000a3"  # unreferenced by any step
STEP1 = "00000000-0000-0000-0000-0000000000b1"
STEP2 = "00000000-0000-0000-0000-0000000000b2"

PREV_MUTATION = "00000000-0000-0000-0000-0000000000f0"
NOW = "2026-01-01T00:00:00+00:00"


def _snapshot(content_rev: int = 3) -> dict:
    return {
        "recipe": {
            "id": RECIPE_ID,
            "user_id": str(FAKE_USER_ID),
            "title": "Carbonara",
            "image_path": None,
            "source_url": None,
            "servings": "4",
            "prep_time": "10 min",
            "cook_time": "20 min",
            "confidence_score": 0.9,
            "favorite": False,
            "created_at": NOW,
            "updated_at": NOW,
            "parent_recipe_id": None,
            "riff_session_id": None,
            "riff_label": None,
            "content_rev": content_rev,
            "last_content_mutation_id": PREV_MUTATION,
        },
        "ingredients": [
            {
                "id": ING1,
                "recipe_id": RECIPE_ID,
                "position": 1,
                "quantity": "2",
                "unit": "cups",
                "name": "flour",
                "prep": "sifted",
                "raw_text": "2 cups flour, sifted",
            },
            {
                "id": ING2,
                "recipe_id": RECIPE_ID,
                "position": 2,
                "quantity": None,
                "unit": None,
                "name": "salt",
                "prep": None,
                "raw_text": None,
            },
            {
                "id": ING3,
                "recipe_id": RECIPE_ID,
                "position": 3,
                "quantity": None,
                "unit": None,
                "name": "pepper",
                "prep": None,
                "raw_text": None,
            },
        ],
        "steps": [
            {
                "id": STEP1,
                "recipe_id": RECIPE_ID,
                "position": 1,
                "instruction": "Mix flour and salt.",
                "ingredient_mapping_version": 1,
            },
            {
                "id": STEP2,
                "recipe_id": RECIPE_ID,
                "position": 2,
                "instruction": "Rest the dough.",
                "ingredient_mapping_version": 1,
            },
        ],
        "associations": [
            {"step_id": STEP1, "ingredient_id": ING1},
            {"step_id": STEP1, "ingredient_id": ING2},
        ],
        "tags": [],
    }


def _make_db(
    snapshots: list | None = None,
    *,
    update_result: dict | None = None,
    update_exc: Exception | None = None,
    log: list | None = None,
) -> MagicMock:
    """Mock Supabase client dispatching by RPC name.

    snapshots are served per get_recipe_snapshot call in order (the last
    entry is reused). update_recipe_content returns update_result or
    raises update_exc.
    """
    snapshots = snapshots if snapshots is not None else [_snapshot()]
    state = {"snap_calls": 0}
    db = MagicMock()

    def _rpc(name, params):
        holder = MagicMock()
        if name == "get_recipe_snapshot":
            if log is not None:
                log.append("snapshot")
            index = min(state["snap_calls"], len(snapshots) - 1)
            state["snap_calls"] += 1
            holder.execute.return_value = SimpleNamespace(
                data=copy.deepcopy(snapshots[index])
            )
        elif name == "update_recipe_content":
            if log is not None:
                log.append("commit")
            if update_exc is not None:
                holder.execute.side_effect = update_exc
            else:
                holder.execute.return_value = SimpleNamespace(
                    data=update_result
                    or {
                        "status": "updated",
                        "recipe_id": RECIPE_ID,
                        "content_rev": 4,
                    }
                )
        else:
            raise AssertionError(f"Unexpected RPC: {name}")
        return holder

    db.rpc.side_effect = _rpc
    return db


def _update_rpc_calls(db: MagicMock) -> list:
    return [
        c for c in db.rpc.call_args_list if c.args[0] == "update_recipe_content"
    ]


def _body(**overrides) -> dict:
    """Build a request body; a None override REMOVES the key entirely
    (explicitly-null sections are a fail-closed 422 by contract and are
    tested separately with raw dicts)."""
    body = {
        "expected_content_rev": 3,
        "mutation_id": str(uuid4()),
        "fields": {"title": "Better Carbonara"},
    }
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not None}


@pytest.fixture(autouse=True)
def _stub_edit_mapper():
    """No test in this module may ever reach the live provider (.env holds
    a real key). Default mapper result: None (soft-fail)."""
    fake_client = MagicMock()
    with patch(
        "api.core.anthropic_client.get_anthropic_client",
        return_value=fake_client,
    ) as factory, patch(
        "api.core.recipes.map_ingredients_to_steps", return_value=None
    ) as mapper:
        yield SimpleNamespace(mapper=mapper, factory=factory, client=fake_client)


@pytest.fixture()
def edit_client(authed_client):
    yield authed_client
    authed_client.app.dependency_overrides.pop(get_db, None)
    authed_client.app.dependency_overrides.pop(get_user_db, None)


def _install_db(client, db) -> None:
    client.app.dependency_overrides[get_db] = lambda: db
    client.app.dependency_overrides[get_user_db] = lambda: MagicMock()


# =============================================================================
# Auth / not-found / conflict basics
# =============================================================================


def test_unauthenticated_returns_401(client):
    resp = client.patch(URL, json=_body())
    assert resp.status_code == 401


def test_recipe_not_found_at_snapshot_returns_404(edit_client):
    db = MagicMock()
    db.rpc.return_value.execute.return_value = SimpleNamespace(data=None)
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=_body())
    assert resp.status_code == 404


def test_recipe_deleted_between_snapshot_and_commit_returns_404(edit_client):
    """TL404 raised by the RPC (delete won the race) maps to 404."""
    db = _make_db(
        update_exc=RuntimeError(
            "Recipe not found or not owned by user (TL404)"
        )
    )
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=_body())
    assert resp.status_code == 404


def test_stale_rev_fails_fast_before_any_provider_cost(
    edit_client, _stub_edit_mapper
):
    """Phase A CAS pre-check: typed 409, no mapper, no commit RPC."""
    db = _make_db([_snapshot(content_rev=5)])
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            }
        ),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "EDIT_CONFLICT"}
    _stub_edit_mapper.mapper.assert_not_called()
    assert _update_rpc_calls(db) == []


def test_rev_moved_during_phase_b_discards_mapping_and_returns_409(
    edit_client, _stub_edit_mapper
):
    """A concurrent edit wins while provider work runs: the in-RPC CAS
    raises TL409; the computed mapping is discarded, nothing mutates."""
    _stub_edit_mapper.mapper.return_value = [[1], [], None]
    db = _make_db(
        update_exc=RuntimeError("Recipe content revision conflict (TL409)")
    )
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            }
        ),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "EDIT_CONFLICT"}
    _stub_edit_mapper.mapper.assert_called_once()


def test_rpc_validation_refusal_maps_to_422(edit_client):
    db = _make_db(update_exc=RuntimeError("Unknown operations key (TL422)"))
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=_body())
    assert resp.status_code == 422


def test_infra_failure_returns_fixed_copy_without_leak(edit_client):
    secret = "postgres://user:hunter2@db.internal/prod"
    db = _make_db(update_exc=RuntimeError(f"connect failed {secret}"))
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=_body())
    assert resp.status_code == 500
    assert secret not in resp.text
    assert resp.json()["detail"] == "Failed to update recipe"


# =============================================================================
# Narrow idempotent replay (plan section 6.2)
# =============================================================================


def test_replay_of_current_mutation_returns_success_without_provider_or_commit(
    edit_client, _stub_edit_mapper
):
    db = _make_db([_snapshot()])
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            mutation_id=PREV_MUTATION,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    assert resp.json()["content_rev"] == 3
    _stub_edit_mapper.mapper.assert_not_called()
    assert _update_rpc_calls(db) == []


def test_old_mutation_after_a_later_edit_conflicts_truthfully(edit_client):
    """After another edit commits, an old retry is NOT a historical replay:
    it receives the typed 409 against the now-current revision."""
    old_mutation = str(uuid4())
    later = _snapshot(content_rev=4)
    later["recipe"]["last_content_mutation_id"] = str(uuid4())
    db = _make_db([later])
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(expected_content_rev=3, mutation_id=old_mutation),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "EDIT_CONFLICT"}
    assert _update_rpc_calls(db) == []


# =============================================================================
# Binding operation-validation invariants (plan section 6.8): every
# violation is 422 and the update RPC is never called (zero mutation).
# =============================================================================


INVALID_BODIES = [
    # unknown keys at every nesting level
    ("unknown top-level key", _body(bogus=1)),
    (
        "unknown fields key",
        _body(fields={"title": "T", "image_path": "hack"}),
    ),
    (
        "unknown ingredient update field",
        _body(
            fields=None,
            ingredients={
                "update": [{"id": ING1, "fields": {"raw_text": "x"}}]
            },
        ),
    ),
    (
        "unknown step update field",
        _body(
            fields=None,
            steps={"update": [{"id": STEP1, "fields": {"name": "x"}}]},
        ),
    ),
    (
        "unknown create key",
        _body(
            fields=None,
            ingredients={
                "create": [
                    {"temp_id": str(uuid4()), "name": "basil", "position": 9}
                ],
                "order": [ING1, ING2, ING3],
            },
        ),
    ),
    (
        "unknown section op",
        _body(fields=None, ingredients={"upsert": [{"id": ING1}]}),
    ),
    # bad types
    ("non-string title", _body(fields={"title": 5})),
    ("null title", _body(fields={"title": None})),
    ("blank title", _body(fields={"title": "   "})),
    ("blank nullable scalar", _body(fields={"servings": "  "})),
    (
        "non-uuid id",
        _body(
            fields=None,
            ingredients={"update": [{"id": "nope", "fields": {"name": "x"}}]},
        ),
    ),
    # empty objects / arrays
    ("empty request", {"expected_content_rev": 3, "mutation_id": str(uuid4())}),
    ("empty fields object", _body(fields={})),
    ("empty section object", _body(fields=None, ingredients={})),
    (
        "empty update fields object",
        _body(fields=None, ingredients={"update": [{"id": ING1, "fields": {}}]}),
    ),
    (
        "empty op array",
        _body(fields=None, ingredients={"update": []}),
    ),
    # membership / combination violations
    (
        "same id updated AND deleted",
        _body(
            fields=None,
            ingredients={
                "update": [{"id": ING1, "fields": {"name": "x"}}],
                "delete": [ING1],
                "order": [ING2, ING3],
            },
        ),
    ),
    (
        "duplicate id across update ops",
        _body(
            fields=None,
            ingredients={
                "update": [
                    {"id": ING1, "fields": {"name": "x"}},
                    {"id": ING1, "fields": {"unit": "g"}},
                ]
            },
        ),
    ),
    (
        "duplicate delete ids",
        _body(
            fields=None,
            ingredients={"delete": [ING1, ING1], "order": [ING2, ING3]},
        ),
    ),
    (
        "duplicate temp_ids",
        _body(
            fields=None,
            steps={
                "create": [
                    {
                        "temp_id": "00000000-0000-0000-0000-0000000000dd",
                        "instruction": "A",
                    },
                    {
                        "temp_id": "00000000-0000-0000-0000-0000000000dd",
                        "instruction": "B",
                    },
                ],
                "order": [
                    STEP1,
                    STEP2,
                    "00000000-0000-0000-0000-0000000000dd",
                ],
            },
        ),
    ),
    (
        "missing order with create",
        _body(
            fields=None,
            ingredients={"create": [{"temp_id": str(uuid4()), "name": "basil"}]},
        ),
    ),
    (
        "missing order with delete",
        _body(fields=None, ingredients={"delete": [ING3]}),
    ),
    (
        "order contains deleted row",
        _body(
            fields=None,
            ingredients={"delete": [ING3], "order": [ING1, ING2, ING3]},
        ),
    ),
    (
        "order with duplicate entry",
        _body(fields=None, ingredients={"order": [ING1, ING1, ING2]}),
    ),
    (
        "order missing a created temp_id",
        _body(
            fields=None,
            ingredients={
                "create": [{"temp_id": str(uuid4()), "name": "basil"}],
                "order": [ING1, ING2, ING3],
            },
        ),
    ),
    # content emptiness
    (
        "null ingredient name",
        _body(
            fields=None,
            ingredients={"update": [{"id": ING1, "fields": {"name": None}}]},
        ),
    ),
    (
        "blank ingredient name",
        _body(
            fields=None,
            ingredients={"update": [{"id": ING1, "fields": {"name": " "}}]},
        ),
    ),
    (
        "blank create name",
        _body(
            fields=None,
            ingredients={
                "create": [{"temp_id": str(uuid4()), "name": "  "}],
                "order": [ING1, ING2, ING3],
            },
        ),
    ),
    (
        "blank step instruction",
        _body(
            fields=None,
            steps={"update": [{"id": STEP1, "fields": {"instruction": ""}}]},
        ),
    ),
]


@pytest.mark.parametrize(
    "label,body", INVALID_BODIES, ids=[c[0] for c in INVALID_BODIES]
)
def test_invalid_ops_are_422_with_zero_mutation(
    edit_client, _stub_edit_mapper, label, body
):
    body = {k: v for k, v in body.items() if v is not None}
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=body)
    assert resp.status_code == 422, label
    assert _update_rpc_calls(db) == [], label
    _stub_edit_mapper.mapper.assert_not_called()


def test_oversized_expected_content_rev_is_rejected_before_any_work(
    edit_client, _stub_edit_mapper
):
    """A revision that cannot be represented by the PostgreSQL INTEGER
    column fails request validation (422): no snapshot read, no provider
    call, no commit RPC, so it can never surface as an RPC coercion
    error."""
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL, json=_body(expected_content_rev=2_147_483_648)
    )
    assert resp.status_code == 422
    db.rpc.assert_not_called()
    _stub_edit_mapper.mapper.assert_not_called()
    # The boundary itself (INTEGER max) is still a valid revision value.
    resp = edit_client.patch(
        URL, json=_body(expected_content_rev=2_147_483_647)
    )
    # Valid wire value; it simply conflicts with the current revision.
    assert resp.status_code == 409


def test_explicitly_null_sections_are_rejected(edit_client, _stub_edit_mapper):
    """A key that is PRESENT must carry a real payload: explicit null is a
    422, never silently treated as an omitted section (fail-closed)."""
    db = _make_db()
    _install_db(edit_client, db)
    for null_key in ("fields", "ingredients", "steps"):
        body = {
            "expected_content_rev": 3,
            "mutation_id": str(uuid4()),
            "fields": {"title": "Better"},
            null_key: None,
        }
        if null_key == "fields":
            body["ingredients"] = {
                "update": [{"id": ING2, "fields": {"name": "x"}}]
            }
        resp = edit_client.patch(URL, json=body)
        assert resp.status_code == 422, null_key
        assert _update_rpc_calls(db) == [], null_key
    _stub_edit_mapper.mapper.assert_not_called()


SNAPSHOT_DEPENDENT_INVALID = [
    (
        "unknown/cross-recipe id in update",
        _body(
            fields=None,
            ingredients={
                "update": [{"id": str(uuid4()), "fields": {"name": "x"}}]
            },
        ),
    ),
    (
        "unknown id in delete",
        _body(
            fields=None,
            ingredients={"delete": [str(uuid4())], "order": [ING1, ING2, ING3]},
        ),
    ),
    (
        "order missing a surviving row",
        _body(fields=None, ingredients={"order": [ING1, ING2]}),
    ),
    (
        "order with foreign id",
        _body(
            fields=None,
            ingredients={"order": [ING1, ING2, str(uuid4())]},
        ),
    ),
    (
        "temp_id collides with existing row id",
        _body(
            fields=None,
            ingredients={
                "create": [{"temp_id": ING1, "name": "basil"}],
                "order": [ING1, ING2, ING3],
            },
        ),
    ),
]


@pytest.mark.parametrize(
    "label,body",
    SNAPSHOT_DEPENDENT_INVALID,
    ids=[c[0] for c in SNAPSHOT_DEPENDENT_INVALID],
)
def test_snapshot_dependent_invalid_ops_are_422_with_zero_mutation(
    edit_client, _stub_edit_mapper, label, body
):
    body = {k: v for k, v in body.items() if v is not None}
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=body)
    assert resp.status_code == 422, label
    assert _update_rpc_calls(db) == [], label
    _stub_edit_mapper.mapper.assert_not_called()


# =============================================================================
# The genuine no-op rule
# =============================================================================


def test_noop_ops_return_success_without_provider_or_commit(
    edit_client, _stub_edit_mapper
):
    """Ops producing no effective change: success, current state, no
    provider work, no mutation, no content_rev advance."""
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields={"title": "Carbonara"},  # equal to current
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "salt"}}],
                "order": [ING1, ING2, ING3],  # equal to current order
            },
        ),
    )
    assert resp.status_code == 200
    assert resp.json()["content_rev"] == 3
    _stub_edit_mapper.mapper.assert_not_called()
    assert _update_rpc_calls(db) == []


# =============================================================================
# Tri-state scalar fields
# =============================================================================


def test_tri_state_scalar_patch_serializes_exactly_the_set_keys(edit_client):
    """Present null = intentional clear; absent = untouched; the wire
    payload to the RPC carries exactly the intentional keys."""
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(fields={"title": "Better", "servings": None}),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    ops = call.args[1]["p_ops"]
    assert ops == {"fields": {"title": "Better", "servings": None}}


# =============================================================================
# Legacy-row proof + invalidation-scope classification (plan section 8.2)
# =============================================================================


def test_legacy_row_never_serialized_on_sibling_edit_and_reorder(
    edit_client, _stub_edit_mapper
):
    """The 6.1 worked example: editing a sibling step and reordering
    ingredients emits NO update op for the untouched legacy row; its
    raw_text feeds the mapper unchanged; scope is only the edited step."""
    _stub_edit_mapper.mapper.return_value = [None, [1]]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            steps={
                "update": [
                    {"id": STEP2, "fields": {"instruction": "Rest 30 min."}}
                ]
            },
            ingredients={"order": [ING2, ING1, ING3]},
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    params = call.args[1]
    # No ingredient update op exists at all: the legacy row was never
    # transmitted, so the server cannot interpret it as an edit.
    assert "update" not in params["p_ops"]["ingredients"]
    assert params["p_ops"]["ingredients"] == {
        "order": [ING2, ING1, ING3]
    }
    # Scope = only the edited step (post-edit position 2).
    assert params["p_invalidated_scope"] == [2]
    # The legacy row reached the mapper via its stored raw_text, unchanged,
    # in the new order.
    mapper_ingredients = _stub_edit_mapper.mapper.call_args.args[0]
    assert mapper_ingredients[1]["raw_text"] == "2 cups flour, sifted"


def test_pure_reorder_bumps_rev_without_provider(edit_client, _stub_edit_mapper):
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(fields=None, ingredients={"order": [ING3, ING1, ING2]}),
    )
    assert resp.status_code == 200
    _stub_edit_mapper.mapper.assert_not_called()
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == []
    assert call.args[1]["p_mappings"] is None


def test_title_only_edit_has_empty_scope_and_no_provider(
    edit_client, _stub_edit_mapper
):
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(URL, json=_body(fields={"title": "Better"}))
    assert resp.status_code == 200
    _stub_edit_mapper.mapper.assert_not_called()
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == []


def test_ingredient_update_invalidates_whole_recipe(
    edit_client, _stub_edit_mapper
):
    _stub_edit_mapper.mapper.return_value = [[1, 2], []]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == [1, 2]
    _stub_edit_mapper.mapper.assert_called_once()


def test_ingredient_create_invalidates_whole_recipe(
    edit_client, _stub_edit_mapper
):
    temp = str(uuid4())
    _stub_edit_mapper.mapper.return_value = [[1, 4], []]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "create": [{"temp_id": temp, "name": "basil"}],
                "order": [ING1, ING2, ING3, temp],
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == [1, 2]
    _stub_edit_mapper.mapper.assert_called_once()


def test_ingredient_delete_invalidates_only_referencing_steps(
    edit_client, _stub_edit_mapper
):
    """Deleting ING2 (referenced by STEP1 only) demotes step position 1;
    the provider runs for that scope."""
    _stub_edit_mapper.mapper.return_value = [[1], None]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={"delete": [ING2], "order": [ING1, ING3]},
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == [1]
    _stub_edit_mapper.mapper.assert_called_once()


def test_unreferenced_ingredient_delete_has_empty_scope_no_provider(
    edit_client, _stub_edit_mapper
):
    """Deleting ING3 (no step references it): empty scope, no provider."""
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={"delete": [ING3], "order": [ING1, ING2]},
        ),
    )
    assert resp.status_code == 200
    _stub_edit_mapper.mapper.assert_not_called()
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == []
    assert call.args[1]["p_mappings"] is None


def test_step_update_invalidates_only_that_step(edit_client, _stub_edit_mapper):
    _stub_edit_mapper.mapper.return_value = [[1], []]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            steps={
                "update": [
                    {"id": STEP1, "fields": {"instruction": "Whisk hard."}}
                ]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == [1]


def test_step_create_invalidates_only_the_new_step(
    edit_client, _stub_edit_mapper
):
    temp = str(uuid4())
    _stub_edit_mapper.mapper.return_value = [None, None, [2]]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            steps={
                "create": [{"temp_id": temp, "instruction": "Serve warm."}],
                "order": [STEP1, STEP2, temp],
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == [3]


def test_step_delete_has_empty_scope_no_provider(edit_client, _stub_edit_mapper):
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(fields=None, steps={"delete": [STEP2], "order": [STEP1]}),
    )
    assert resp.status_code == 200
    _stub_edit_mapper.mapper.assert_not_called()
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_invalidated_scope"] == []


# =============================================================================
# Two-phase lifecycle + bounded mapper (plan sections 6.1, 8.4)
# =============================================================================


def test_two_phase_ordering_snapshot_then_mapper_then_commit(
    edit_client, _stub_edit_mapper
):
    """The mapper runs BETWEEN the snapshot read and the commit RPC: no DB
    row lock or transaction is open during provider work."""
    log: list = []

    def _mapper(*args, **kwargs):
        log.append("mapper")
        return [[1], []]

    _stub_edit_mapper.mapper.side_effect = _mapper
    db = _make_db(log=log)
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    assert log == ["snapshot", "mapper", "commit", "snapshot"]


def test_mapper_uses_the_bounded_client(edit_client, _stub_edit_mapper):
    """5s hard timeout, zero automatic retries, applied via with_options at
    the edit call site (plan section 8.4)."""
    _stub_edit_mapper.mapper.return_value = [[1], []]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    _stub_edit_mapper.client.with_options.assert_called_once_with(
        timeout=5.0, max_retries=0
    )
    assert (
        _stub_edit_mapper.mapper.call_args.kwargs["client"]
        is _stub_edit_mapper.client.with_options.return_value
    )


def test_mapper_success_promotes_scope_entries(edit_client, _stub_edit_mapper):
    _stub_edit_mapper.mapper.return_value = [[1, 2], []]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_mappings"] == [
        {"step_position": 1, "ingredient_positions": [1, 2]},
        {"step_position": 2, "ingredient_positions": []},
    ]


def test_mapper_timeout_soft_fails_and_the_edit_still_commits(
    edit_client, _stub_edit_mapper
):
    """Timeout/failure: the valid edit commits; the scope stays truthfully
    demoted (p_mappings null); the response is a normal success."""
    _stub_edit_mapper.mapper.return_value = None
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_mappings"] is None
    assert call.args[1]["p_invalidated_scope"] == [1, 2]


def test_mapper_partial_result_promotes_only_proven_steps(
    edit_client, _stub_edit_mapper
):
    """Demote-first, promote-proven: an in-scope step the mapper could not
    prove is omitted from p_mappings (it stays demoted, never stale)."""
    _stub_edit_mapper.mapper.return_value = [[1], None]
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_mappings"] == [
        {"step_position": 1, "ingredient_positions": [1]}
    ]


def test_mapper_setup_failure_soft_fails(edit_client, _stub_edit_mapper):
    """A provider-setup failure degrades to p_mappings null, never a save
    failure."""
    _stub_edit_mapper.factory.side_effect = RuntimeError("no key")
    db = _make_db()
    _install_db(edit_client, db)
    resp = edit_client.patch(
        URL,
        json=_body(
            fields=None,
            ingredients={
                "update": [{"id": ING2, "fields": {"name": "sea salt"}}]
            },
        ),
    )
    assert resp.status_code == 200
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_mappings"] is None


# =============================================================================
# Response shape + RPC parameter completeness
# =============================================================================


def test_success_returns_full_detail_including_new_content_rev(edit_client):
    after = _snapshot(content_rev=4)
    after["recipe"]["title"] = "Better Carbonara"
    db = _make_db([_snapshot(), after])
    _install_db(edit_client, db)
    body = _body()
    resp = edit_client.patch(URL, json=body)
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["content_rev"] == 4
    assert payload["title"] == "Better Carbonara"
    assert "last_content_mutation_id" not in payload
    # The commit RPC received the complete typed parameter set.
    (call,) = _update_rpc_calls(db)
    assert call.args[1]["p_recipe_id"] == RECIPE_ID
    assert call.args[1]["p_user_id"] == str(FAKE_USER_ID)
    assert call.args[1]["p_expected_content_rev"] == 3
    assert call.args[1]["p_mutation_id"] == body["mutation_id"]
