"""Route-level tests for GET /health/ready (migration drift guard, 15.2.4-CF-MD1).

The checker is patched at the route seam (run_readiness_check_single_flight /
check_migration_compatibility); no network.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from api.core.migration_guard import MigrationCheckResult

SENTINEL = "sentinel-secret-value-never-shown"


def _patch_result(monkeypatch, result):
    monkeypatch.setattr(
        "api.routes.health.run_readiness_check_single_flight", lambda: result
    )


def test_health_liveness_unchanged(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_ready_compatible_200(monkeypatch, client):
    _patch_result(
        monkeypatch, MigrationCheckResult(status="ready", code="compatible")
    )
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ready", "code": "compatible"}


def test_ready_skipped_200(monkeypatch, client):
    _patch_result(
        monkeypatch,
        MigrationCheckResult(
            status="skipped", code="schema_check_skipped", hint="not verified"
        ),
    )
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "skipped"
    assert body["code"] == "schema_check_skipped"


def test_ready_migration_missing_503_payload(monkeypatch, client):
    _patch_result(
        monkeypatch,
        MigrationCheckResult(
            status="fail",
            code="migration_missing",
            migrations=("024_grocery_items_note.sql",),
            hint="apply the listed migration file(s)",
            log_detail="server-only-diagnostic",
        ),
    )
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "fail"
    assert body["code"] == "migration_missing"
    assert body["migrations"] == ["024_grocery_items_note.sql"]
    assert "apply" in body["hint"]
    # log_detail is server-log only, never public
    assert set(body.keys()) <= {"status", "code", "migrations", "hint"}
    assert "server-only-diagnostic" not in resp.text


def test_ready_ledger_rpc_unavailable_503(monkeypatch, client):
    _patch_result(
        monkeypatch,
        MigrationCheckResult(
            status="fail",
            code="ledger_rpc_unavailable",
            hint="apply migrations/025_migration_ledger_rpc.sql if absent",
        ),
    )
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["code"] == "ledger_rpc_unavailable"


def test_ready_route_boundary_hides_exception_text(monkeypatch, client):
    def exploding():
        raise ValueError(f"contains {SENTINEL}")

    monkeypatch.setattr(
        "api.routes.health.run_readiness_check_single_flight", exploding
    )
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    body = resp.json()
    assert body["code"] == "internal_error"
    assert SENTINEL not in resp.text


def test_ready_no_secret_leakage_in_body(monkeypatch, client):
    _patch_result(
        monkeypatch,
        MigrationCheckResult(
            status="fail", code="db_unavailable", hint="transient", log_detail=None
        ),
    )
    resp = client.get("/health/ready")
    assert SENTINEL not in resp.text
    assert resp.status_code == 503


def test_ready_route_single_flight_one_check_for_concurrent_callers(
    monkeypatch, client
):
    """Concurrent requests share one database check and all get bounded 200s."""
    import api.core.migration_guard as guard_module

    calls = []
    release = threading.Event()

    def slow_check(**kwargs):
        calls.append(1)
        release.wait(timeout=5)
        return MigrationCheckResult(status="ready", code="compatible")

    # Patch the inner checker; the real single-flight wrapper stays in play.
    monkeypatch.setattr(guard_module, "check_migration_compatibility", slow_check)
    monkeypatch.setattr(
        "api.routes.health.run_readiness_check_single_flight",
        guard_module.run_readiness_check_single_flight,
    )

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(client.get, "/health/ready") for _ in range(5)]
        # Give all requests time to join the same in-flight check.
        threading.Event().wait(0.4)
        release.set()
        responses = [f.result(timeout=15) for f in futures]

    assert all(r.status_code == 200 for r in responses)
    assert all(r.json()["code"] == "compatible" for r in responses)
    assert len(calls) == 1


def test_ready_next_request_after_completion_is_fresh(monkeypatch, client):
    """No persistent compatibility cache: each request re-evaluates."""
    import api.core.migration_guard as guard_module

    results = [
        MigrationCheckResult(status="ready", code="compatible"),
        MigrationCheckResult(
            status="fail",
            code="migration_missing",
            migrations=("026_future.sql",),
        ),
    ]
    calls = []

    def sequential_check(**kwargs):
        calls.append(1)
        return results[len(calls) - 1]

    monkeypatch.setattr(
        guard_module, "check_migration_compatibility", sequential_check
    )
    monkeypatch.setattr(
        "api.routes.health.run_readiness_check_single_flight",
        guard_module.run_readiness_check_single_flight,
    )

    first = client.get("/health/ready")
    second = client.get("/health/ready")
    assert first.status_code == 200
    assert second.status_code == 503  # later drift is NOT hidden by the earlier green
    assert second.json()["migrations"] == ["026_future.sql"]
    assert len(calls) == 2
