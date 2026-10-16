"""Deterministic tests for the migration drift guard (15.2.4-CF-MD1).

No network: the Supabase client is replaced with fakes via client_factory.
Environment is controlled per-test via monkeypatch.
"""

from __future__ import annotations

import base64
import concurrent.futures
import threading
import time
from pathlib import Path

import httpx
import pytest
from postgrest.exceptions import APIError

from api.core.migration_guard import (
    BASELINE_ANCHOR_NAME,
    BASELINE_ANCHOR_VERSION,
    BASELINE_MIGRATION_STEMS,
    COLUMN_PROBES,
    LEDGER_NAME_ALIASES,
    MIGRATIONS_DIR,
    READINESS_WAIT_BUDGET_SECONDS,
    MigrationCheckResult,
    _SingleFlight,
    check_migration_compatibility,
)

SENTINEL_URL = "https://sentinel-project.supabase.co"
SENTINEL_KEY = "sentinel-service-key-value-never-printed"

ANCHOR_ROW = {"version": BASELINE_ANCHOR_VERSION, "name": BASELINE_ANCHOR_NAME}


def _repo_full_ledger() -> list[dict]:
    """A fake ledger that satisfies the REAL repository inventory."""
    rows = [ANCHOR_ROW.copy()]
    version = 20260500000000
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        stem = path.name[: -len(".sql")]
        if stem in BASELINE_MIGRATION_STEMS or stem == BASELINE_ANCHOR_NAME:
            continue
        version += 1
        rows.append(
            {"version": str(version), "name": LEDGER_NAME_ALIASES.get(stem, stem)}
        )
    return rows


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeClient:
    """Minimal stand-in for the supabase client surface the guard touches."""

    def __init__(self, ledger=None, rpc_error=None, probe_errors=None):
        self.ledger = ledger
        self.rpc_error = rpc_error
        self.probe_errors = probe_errors or {}
        self.rpc_calls = 0
        self.probe_calls: list[str] = []

    def rpc(self, fn_name, params):
        assert fn_name == "migration_ledger"
        client = self

        class _Rpc:
            def execute(self_inner):
                client.rpc_calls += 1
                if client.rpc_error is not None:
                    raise client.rpc_error
                return FakeResponse(client.ledger)

        return _Rpc()

    def table(self, table_name):
        client = self

        class _Query:
            def select(self_inner, column):
                self_inner.key = f"{table_name}.{column}"
                return self_inner

            def limit(self_inner, n):
                return self_inner

            def execute(self_inner):
                client.probe_calls.append(self_inner.key)
                err = client.probe_errors.get(self_inner.key)
                if err is not None:
                    raise err
                return FakeResponse([])

        return _Query()


@pytest.fixture()
def guard_env(monkeypatch):
    """Baseline env: non-strict, config present (values are sentinels)."""
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("SUPABASE_URL", SENTINEL_URL)
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", SENTINEL_KEY)
    return monkeypatch


def check(client=None, factory_error=None, migrations_dir=None):
    if factory_error is not None:

        def factory():
            raise factory_error

    else:

        def factory():
            return client

    return check_migration_compatibility(
        migrations_dir=migrations_dir, client_factory=factory
    )


def write_migrations(tmp_path: Path, names: list[str]) -> Path:
    d = tmp_path / "migrations"
    d.mkdir()
    for n in names:
        (d / n).write_text("-- test migration\n")
    return d


# ---------------------------------------------------------------------------
# Inventory + identity
# ---------------------------------------------------------------------------


def test_real_inventory_full_ledger_is_compatible(guard_env):
    result = check(FakeClient(ledger=_repo_full_ledger()))
    assert (result.status, result.code) == ("ready", "compatible")
    assert result.migrations == ()


def test_baseline_set_matches_repository(guard_env):
    """The frozen 14-file baseline must exactly match the repo's 003-015 files."""
    on_disk = {
        p.name[:-4]
        for p in MIGRATIONS_DIR.glob("*.sql")
        if p.name[:3].isdigit() and 3 <= int(p.name[:3]) <= 15
    }
    assert on_disk == set(BASELINE_MIGRATION_STEMS)
    assert len(BASELINE_MIGRATION_STEMS) == 14


def test_alias_020_missing_from_ledger_reports_prefixed_filename(guard_env):
    ledger = [r for r in _repo_full_ledger() if r["name"] != "riff_lineage_in_search"]
    result = check(FakeClient(ledger=ledger))
    assert result.code == "migration_missing"
    assert result.migrations == ("020_riff_lineage_in_search.sql",)


def test_missing_single_migration_lists_exact_filename(guard_env):
    ledger = [r for r in _repo_full_ledger() if r["name"] != "024_grocery_items_note"]
    result = check(FakeClient(ledger=ledger))
    assert result.status == "fail"
    assert result.code == "migration_missing"
    assert result.migrations == ("024_grocery_items_note.sql",)
    assert "docs/migrations.md" in (result.hint or "")


def test_multiple_missing_migrations_sorted(guard_env):
    drop = {"021_riff_usage", "024_grocery_items_note", "017_lockdown_recipe_search_index"}
    ledger = [r for r in _repo_full_ledger() if r["name"] not in drop]
    result = check(FakeClient(ledger=ledger))
    assert result.code == "migration_missing"
    assert result.migrations == (
        "017_lockdown_recipe_search_index.sql",
        "021_riff_usage.sql",
        "024_grocery_items_note.sql",
    )


def test_inventory_dir_missing(guard_env, tmp_path):
    result = check(FakeClient(ledger=[]), migrations_dir=tmp_path / "nope")
    assert (result.status, result.code) == ("fail", "inventory_missing")


def test_inventory_dir_empty(guard_env, tmp_path):
    d = tmp_path / "migrations"
    d.mkdir()
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "inventory_missing")


def test_inventory_checked_before_skip(monkeypatch, tmp_path):
    """Empty inventory + non-strict + no config must fail, never 'skipped'."""
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    d = tmp_path / "migrations"
    d.mkdir()
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "inventory_missing")


def test_malformed_filenames_fail_closed(guard_env, tmp_path):
    d = write_migrations(
        tmp_path, ["026_ok_name.sql", "027_Bad.SQL", "notamigration.sql"]
    )
    (d / "nested").mkdir()
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "malformed_filename")
    assert result.migrations == ("027_Bad.SQL", "nested", "notamigration.sql")


def test_dotfiles_ignored(guard_env, tmp_path):
    d = write_migrations(tmp_path, ["026_ok_name.sql"])
    (d / ".DS_Store").write_text("junk")
    result = check(
        FakeClient(ledger=[{"version": "1", "name": "026_ok_name"}]),
        migrations_dir=d,
    )
    assert (result.status, result.code) == ("ready", "compatible")


def test_duplicate_prefix_non_baseline_fails(guard_env, tmp_path):
    d = write_migrations(tmp_path, ["026_first.sql", "026_second.sql"])
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "duplicate_identity")
    assert result.migrations == ("026_first.sql", "026_second.sql")


def test_duplicate_prefix_in_baseline_range_fails(guard_env, tmp_path):
    """A new file colliding with a baseline prefix is NOT grandfathered."""
    d = write_migrations(tmp_path, ["003_search_index.sql", "003_other.sql"])
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "duplicate_identity")
    assert result.migrations == ("003_other.sql", "003_search_index.sql")


def test_third_004_file_fails_despite_grandfathered_pair(guard_env, tmp_path):
    d = write_migrations(
        tmp_path,
        [
            "004_search_function.sql",
            "004_search_function_v2.sql",
            "004_third_thing.sql",
        ],
    )
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "duplicate_identity")
    assert set(result.migrations) == {
        "004_search_function.sql",
        "004_search_function_v2.sql",
        "004_third_thing.sql",
    }


def test_exact_004_pair_alone_is_allowed(guard_env, tmp_path):
    d = write_migrations(
        tmp_path, ["004_search_function.sql", "004_search_function_v2.sql"]
    )
    ledger = [
        {"version": "1", "name": "004_search_function"},
        {"version": "2", "name": "004_search_function_v2"},
    ]
    result = check(FakeClient(ledger=ledger), migrations_dir=d)
    assert (result.status, result.code) == ("ready", "compatible")


def test_symlink_entry_rejected(guard_env, tmp_path):
    d = write_migrations(tmp_path, ["026_ok_name.sql"])
    (d / "027_sneaky_link.sql").symlink_to(d / "026_ok_name.sql")
    result = check(FakeClient(ledger=[]), migrations_dir=d)
    assert (result.status, result.code) == ("fail", "malformed_filename")
    assert result.migrations == ("027_sneaky_link.sql",)


# ---------------------------------------------------------------------------
# Config / strictness
# ---------------------------------------------------------------------------


def test_strict_railway_env_missing_config_fails(monkeypatch):
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    result = check(FakeClient(ledger=[]))
    assert (result.status, result.code) == ("fail", "config_missing")


def test_strict_railway_env_present_but_blank_still_strict(monkeypatch):
    """Railway materializes deleted vars as ''. Key presence = on Railway."""
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    result = check(FakeClient(ledger=[]))
    assert (result.status, result.code) == ("fail", "config_missing")


def test_strict_environment_production_missing_config_fails(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    result = check(FakeClient(ledger=[]))
    assert (result.status, result.code) == ("fail", "config_missing")


def test_non_strict_missing_config_skips_never_compatible(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    result = check(FakeClient(ledger=[]))
    assert (result.status, result.code) == ("skipped", "schema_check_skipped")
    assert result.code != "compatible"


def test_factory_runtime_error_maps_to_config_missing(guard_env):
    result = check(factory_error=RuntimeError("key has role 'anon'"))
    assert (result.status, result.code) == ("fail", "config_missing")
    assert "anon" not in (result.hint or "")


# ---------------------------------------------------------------------------
# Ledger fetch classification
# ---------------------------------------------------------------------------


def test_pgrst202_maps_to_ledger_rpc_unavailable(guard_env):
    err = APIError({"code": "PGRST202", "message": "not found"})
    result = check(FakeClient(rpc_error=err))
    assert (result.status, result.code) == ("fail", "ledger_rpc_unavailable")
    assert "025_migration_ledger_rpc.sql" in (result.hint or "")


def test_permission_denied_maps_to_ledger_rpc_unavailable(guard_env):
    err = APIError({"code": "42501", "message": "permission denied"})
    result = check(FakeClient(rpc_error=err))
    assert result.code == "ledger_rpc_unavailable"


def test_undefined_function_maps_to_ledger_rpc_unavailable(guard_env):
    err = APIError({"code": "42883", "message": "function does not exist"})
    result = check(FakeClient(rpc_error=err))
    assert result.code == "ledger_rpc_unavailable"


def test_total_budget_exceeded_before_any_db_call(guard_env):
    client = FakeClient(ledger=_repo_full_ledger())
    result = check_migration_compatibility(
        client_factory=lambda: client, total_budget_seconds=0
    )
    assert (result.status, result.code) == ("fail", "db_unavailable")
    assert result.log_detail == "check_total_budget_exceeded"
    assert client.rpc_calls == 0  # aborted before touching the database


def test_connection_error_maps_to_db_unavailable(guard_env):
    result = check(FakeClient(rpc_error=httpx.ConnectError("boom")))
    assert (result.status, result.code) == ("fail", "db_unavailable")


def test_timeout_maps_to_db_unavailable(guard_env):
    result = check(FakeClient(rpc_error=httpx.ReadTimeout("slow")))
    assert (result.status, result.code) == ("fail", "db_unavailable")


@pytest.mark.parametrize(
    "ledger",
    [
        None,
        {"not": "a list"},
        ["not-a-dict"],
        [{"name": "x"}],  # missing version
        [{"version": "", "name": "x"}],  # empty version
        [{"version": "1", "name": 42}],  # non-str name
    ],
)
def test_malformed_ledger_shapes(guard_env, ledger):
    result = check(FakeClient(ledger=ledger))
    assert (result.status, result.code) == ("fail", "ledger_malformed")


def test_null_ledger_name_tolerated(guard_env):
    ledger = _repo_full_ledger() + [{"version": "9", "name": None}]
    result = check(FakeClient(ledger=ledger))
    assert result.code == "compatible"


def test_ledger_ahead_is_compatible_count_only_in_log(guard_env):
    ledger = _repo_full_ledger() + [
        {"version": "99999", "name": "999_future_thing"},
        {"version": "99998", "name": "evil\nname with spaces"},
    ]
    result = check(FakeClient(ledger=ledger))
    assert (result.status, result.code) == ("ready", "compatible")
    # DB-controlled name strings must never reach logs verbatim — count only.
    assert result.log_detail == "ledger_ahead_count=2"


# ---------------------------------------------------------------------------
# Baseline anchor
# ---------------------------------------------------------------------------


def test_fresh_db_no_anchor_requires_baseline(guard_env):
    result = check(FakeClient(ledger=[]))
    assert result.code == "migration_missing"
    missing = set(result.migrations)
    assert "003_search_index.sql" in missing
    assert "004_search_function.sql" in missing
    assert "004_search_function_v2.sql" in missing
    assert "024_grocery_items_note.sql" in missing


def test_anchor_wrong_version_not_exempt(guard_env):
    ledger = _repo_full_ledger()
    ledger[0] = {"version": "20990101000000", "name": BASELINE_ANCHOR_NAME}
    result = check(FakeClient(ledger=ledger))
    assert result.code == "migration_missing"
    assert "003_search_index.sql" in result.migrations
    # 016 itself is satisfied by name regardless of version
    assert "016_search_fts_rpc_v3.sql" not in result.migrations


def test_anchor_wrong_name_not_exempt(guard_env):
    ledger = _repo_full_ledger()
    ledger[0] = {"version": BASELINE_ANCHOR_VERSION, "name": "something_else"}
    result = check(FakeClient(ledger=ledger))
    assert result.code == "migration_missing"
    assert "003_search_index.sql" in result.migrations


# ---------------------------------------------------------------------------
# Column probes
# ---------------------------------------------------------------------------


def test_probe_missing_column_despite_ledger(guard_env):
    err = APIError({"code": "42703", "message": "column does not exist"})
    client = FakeClient(
        ledger=_repo_full_ledger(), probe_errors={"grocery_items.note": err}
    )
    result = check(client)
    assert (result.status, result.code) == ("fail", "column_missing")
    assert result.migrations == ("024_grocery_items_note.sql",)
    assert "grocery_items.note" in (result.hint or "")


@pytest.mark.parametrize("code", ["42703", "PGRST204", "42P01", "PGRST205"])
def test_probe_failure_codes_all_map_to_column_missing(guard_env, code):
    """SQL undefined column/table AND their PostgREST stale-schema-cache
    equivalents classify as column_missing (proven live in the ephemeral
    gate: a fresh column yields PGRST204 until the cache reloads)."""
    err = APIError({"code": code, "message": "probe failed"})
    client = FakeClient(
        ledger=_repo_full_ledger(), probe_errors={"grocery_items.note": err}
    )
    result = check(client)
    assert (result.status, result.code) == ("fail", "column_missing")
    assert result.migrations == ("024_grocery_items_note.sql",)
    assert "schema cache" in (result.hint or "")


def test_probes_run_for_baseline_sentinels(guard_env):
    client = FakeClient(ledger=_repo_full_ledger())
    check(client)
    assert set(client.probe_calls) == {
        f"{table}.{column}" for _, table, column in COLUMN_PROBES
    }


def test_probe_skipped_when_migration_missing(guard_env):
    ledger = [r for r in _repo_full_ledger() if r["name"] != "024_grocery_items_note"]
    client = FakeClient(ledger=ledger)
    result = check(client)
    assert result.code == "migration_missing"
    assert client.probe_calls == []


def test_probe_transport_error_maps_to_db_unavailable(guard_env):
    client = FakeClient(
        ledger=_repo_full_ledger(),
        probe_errors={"grocery_lists.updated_at": httpx.ConnectError("x")},
    )
    result = check(client)
    assert result.code == "db_unavailable"


# ---------------------------------------------------------------------------
# Boundary safety / freshness
# ---------------------------------------------------------------------------


def test_unexpected_exception_internal_error_class_name_only(guard_env):
    err = ValueError(f"exploded with {SENTINEL_KEY}")
    result = check(FakeClient(rpc_error=err))
    assert (result.status, result.code) == ("fail", "internal_error")
    for text in (result.hint or "", result.log_detail or "", " ".join(result.migrations)):
        assert SENTINEL_KEY not in text
        assert SENTINEL_URL not in text


def test_no_secret_values_in_any_public_field(guard_env):
    for client in (
        FakeClient(rpc_error=APIError({"code": "PGRST202", "message": SENTINEL_KEY})),
        FakeClient(rpc_error=httpx.ConnectError(SENTINEL_KEY)),
        FakeClient(ledger=[]),
    ):
        result = check(client)
        blob = " ".join(
            [result.status, result.code, result.hint or "", result.log_detail or ""]
            + list(result.migrations)
        )
        assert SENTINEL_KEY not in blob
        assert SENTINEL_URL not in blob


def test_repeated_checks_are_fresh_no_cache(guard_env):
    client = FakeClient(ledger=_repo_full_ledger())
    assert check(client).code == "compatible"
    assert check(client).code == "compatible"
    assert client.rpc_calls == 2

    # A failure followed by a fixed ledger returns compatible (no poisoning).
    failing = FakeClient(rpc_error=APIError({"code": "PGRST202", "message": "x"}))
    assert check(failing).code == "ledger_rpc_unavailable"
    assert check(FakeClient(ledger=_repo_full_ledger())).code == "compatible"


# ---------------------------------------------------------------------------
# Single-flight
# ---------------------------------------------------------------------------


def test_single_flight_shares_one_check_across_concurrent_callers():
    sf = _SingleFlight()
    calls = []
    release = threading.Event()

    def slow_check():
        calls.append(1)
        release.wait(timeout=5)
        return MigrationCheckResult(status="ready", code="compatible")

    results = []
    threads = [
        threading.Thread(
            target=lambda: results.append(sf.run(slow_check, wait_seconds=10))
        )
        for _ in range(6)
    ]
    for t in threads:
        t.start()
    time.sleep(0.3)  # let all callers join the in-flight future
    release.set()
    for t in threads:
        t.join(timeout=10)

    assert len(results) == 6
    assert all(r.code == "compatible" for r in results)
    assert len(calls) == 1  # exactly one database check


def test_single_flight_failure_releases_and_next_is_fresh():
    sf = _SingleFlight()
    calls = []

    def failing():
        calls.append(1)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        sf.run(failing, wait_seconds=5)
    assert sf._inflight is None  # released

    def ok():
        calls.append(1)
        return MigrationCheckResult(status="ready", code="compatible")

    assert sf.run(ok, wait_seconds=5).code == "compatible"
    assert len(calls) == 2  # fresh check, no cached failure or success


def test_single_flight_sequential_calls_each_run_fresh():
    sf = _SingleFlight()
    calls = []

    def fn():
        calls.append(1)
        return MigrationCheckResult(status="ready", code="compatible")

    sf.run(fn, wait_seconds=5)
    sf.run(fn, wait_seconds=5)
    assert len(calls) == 2  # no persistent compatibility cache


def test_single_flight_follower_wait_is_bounded():
    sf = _SingleFlight()
    started = threading.Event()
    release = threading.Event()

    def hung():
        started.set()
        release.wait(timeout=30)
        return MigrationCheckResult(status="ready", code="compatible")

    leader = threading.Thread(target=lambda: sf.run(hung, wait_seconds=1))
    leader.start()
    assert started.wait(timeout=5)

    t0 = time.monotonic()
    with pytest.raises(concurrent.futures.TimeoutError):
        sf.run(lambda: MigrationCheckResult(status="ready", code="compatible"), wait_seconds=0.5)
    assert time.monotonic() - t0 < READINESS_WAIT_BUDGET_SECONDS

    release.set()
    leader.join(timeout=10)


def test_single_flight_caller_after_completion_never_gets_stale_result():
    """The slot clears before publication so a post-completion caller is a
    fresh leader, never a reader of the finished future."""
    sf = _SingleFlight()
    results = iter(
        [
            MigrationCheckResult(status="ready", code="compatible"),
            MigrationCheckResult(
                status="fail",
                code="migration_missing",
                migrations=("026_future.sql",),
            ),
        ]
    )
    calls = []

    def fn():
        calls.append(1)
        return next(results)

    first = sf.run(fn, wait_seconds=5)
    second = sf.run(fn, wait_seconds=5)
    assert first.code == "compatible"
    assert second.code == "migration_missing"  # fresh check, not the cached green
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# Dedicated client factory (api/core/supabase_client.py)
# ---------------------------------------------------------------------------


def _fake_jwt(payload_json: bytes) -> str:
    seg = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    return f"{seg(b'{}')}.{seg(payload_json)}.{seg(b'sig')}"


def test_factory_constructs_client_with_service_role_key(monkeypatch):
    from api.core.supabase_client import get_migration_guard_client

    monkeypatch.setenv("SUPABASE_URL", "https://example-project.supabase.co")
    monkeypatch.setenv(
        "SUPABASE_SERVICE_KEY", _fake_jwt(b'{"role": "service_role"}')
    )
    client = get_migration_guard_client(timeout_seconds=5)
    assert client is not None  # constructed offline, no network at build time


def test_factory_rejects_non_object_jwt_payload(monkeypatch):
    """A JWT whose payload is valid JSON but not an object must raise
    RuntimeError (not AttributeError) so the guard maps it to config_missing."""
    from api.core.supabase_client import get_migration_guard_client

    monkeypatch.setenv("SUPABASE_URL", "https://example-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", _fake_jwt(b'[1, 2, 3]'))
    with pytest.raises(RuntimeError):
        get_migration_guard_client(timeout_seconds=5)

    result = check_migration_compatibility(total_budget_seconds=None)
    assert (result.status, result.code) == ("fail", "config_missing")


def test_factory_rejects_anon_role_key_end_to_end(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", _fake_jwt(b'{"role": "anon"}'))
    result = check_migration_compatibility(total_budget_seconds=None)
    assert (result.status, result.code) == ("fail", "config_missing")


def test_factory_missing_env_raises(monkeypatch):
    from api.core.supabase_client import get_migration_guard_client

    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    with pytest.raises(RuntimeError):
        get_migration_guard_client(timeout_seconds=5)


# ---------------------------------------------------------------------------
# Drift-check CLI
# ---------------------------------------------------------------------------


def _load_cli_module():
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "scripts" / "check_migration_drift.py"
    spec = importlib.util.spec_from_file_location("check_migration_drift", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "result,argv,expected_exit",
    [
        (MigrationCheckResult(status="ready", code="compatible"), [], 0),
        (MigrationCheckResult(status="skipped", code="schema_check_skipped"), [], 1),
        (
            MigrationCheckResult(status="skipped", code="schema_check_skipped"),
            ["--allow-skipped"],
            0,
        ),
        (
            MigrationCheckResult(
                status="fail",
                code="migration_missing",
                migrations=("024_grocery_items_note.sql",),
            ),
            [],
            1,
        ),
    ],
)
def test_cli_exit_codes_and_public_output(
    monkeypatch, capsys, result, argv, expected_exit
):
    cli = _load_cli_module()
    monkeypatch.setattr(
        "api.core.migration_guard.check_migration_compatibility", lambda: result
    )
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr("sys.argv", ["check_migration_drift.py", *argv])
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", SENTINEL_KEY)

    exit_code = cli.main()
    captured = capsys.readouterr()

    assert exit_code == expected_exit
    assert f"code: {result.code}" in captured.out
    for filename in result.migrations:
        assert f"migration: {filename}" in captured.out
    assert SENTINEL_KEY not in captured.out
    assert SENTINEL_KEY not in captured.err
    if result.log_detail:
        assert result.log_detail not in captured.out
