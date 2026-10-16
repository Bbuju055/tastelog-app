"""
Tastelog: migration drift guard (15.2.4-CF-MD1).

Compares the packaged repository migration inventory (migrations/*.sql)
against the production migration ledger (supabase_migrations.schema_migrations,
read through the restricted public.migration_ledger() RPC installed by
migration 025) and probes selected hot-path columns. Strictly read-only:
never executes DDL, never writes anything.

Configuration contract (deliberately minimal): the guard and its dedicated
service-role client depend ONLY on SUPABASE_URL and SUPABASE_SERVICE_KEY.
They must not require ANTHROPIC_API_KEY or SUPABASE_ANON_KEY, so the
drift-check CLI can run with just those two variables. The guard therefore
reads os.environ directly instead of api.core.config.Settings (which
requires ANTHROPIC_API_KEY to construct).

Output-safety contract: public results carry only stable codes, migration
filenames, and safe remediation hints. log_detail carries exception CLASS
NAMES and PostgREST error codes only — never raw exception text, never
env-var values.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

import httpx
from postgrest.exceptions import APIError

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"

MIGRATION_FILENAME_RE = re.compile(r"^\d{3}_[a-z0-9_]+\.sql$")

# Historical exception: migration 020 was applied to production under a
# ledger name without its numeric prefix. The ONLY sanctioned alias.
LEDGER_NAME_ALIASES: dict[str, str] = {
    "020_riff_lineage_in_search": "riff_lineage_in_search",
}

# Migrations 003-015 predate the production ledger (applied before Supabase
# MCP migration tracking existed). They are exempt from ledger comparison
# ONLY when the baseline anchor row below is present. A fresh database has
# no anchor, so these files are required there like any other.
BASELINE_MIGRATION_STEMS = frozenset(
    {
        "003_search_index",
        "004_search_function",
        "004_search_function_v2",
        "005_recipe_drafts",
        "006_confirm_recipe_draft_rpc",
        "007_capture_tokens",
        "008_grocery_lists_updated_at",
        "009_recipes_favorite",
        "010_recipe_tags",
        "011_grocery_consolidated",
        "012_grocery_lists_user_name",
        "013_multi_image_drafts",
        "014_source_url",
        "015_cook_events",
    }
)

# Strict pair: BOTH must match the production ledger row for migration 016
# (the first ledgered migration) before the baseline exemption applies.
BASELINE_ANCHOR_VERSION = "20260412015417"
BASELINE_ANCHOR_NAME = "016_search_fts_rpc_v3"

# Secondary column probes. Each runs only when the guard already considers
# the owning migration applied (ledger entry or baseline exemption); a probe
# failure then means the ledger claims something the schema does not honor.
# 024 is the incident this gate exists for; 008/009 are baseline sentinels
# that catch a damaged baseline hiding behind a copied anchor row.
COLUMN_PROBES: tuple[tuple[str, str, str], ...] = (
    ("008_grocery_lists_updated_at", "grocery_lists", "updated_at"),
    ("009_recipes_favorite", "recipes", "favorite"),
    ("024_grocery_items_note", "grocery_items", "note"),
    ("026_step_ingredient_mapping", "recipe_steps", "ingredient_mapping_version"),
    ("026_step_ingredient_mapping", "recipe_step_ingredients", "recipe_id"),
    ("027_recipe_content_editing", "recipes", "content_rev"),
)

# The historical 004 pair is the ONLY tolerated duplicate numeric prefix.
ALLOWED_DUPLICATE_PREFIX_GROUPS = frozenset(
    {("004_search_function", "004_search_function_v2")}
)

# Per-database-call deadline (enforced at the HTTP client level), a total
# budget for one complete check (the leader aborts between calls once
# exceeded; worst case = budget + one in-flight call), and the bound a
# readiness caller waits before receiving a guaranteed failure response.
DATABASE_DEADLINE_SECONDS = 5
CHECK_TOTAL_BUDGET_SECONDS = 10
READINESS_WAIT_BUDGET_SECONDS = (
    CHECK_TOTAL_BUDGET_SECONDS + DATABASE_DEADLINE_SECONDS + 1
)

CODE_COMPATIBLE = "compatible"
CODE_SCHEMA_CHECK_SKIPPED = "schema_check_skipped"
CODE_CONFIG_MISSING = "config_missing"
CODE_LEDGER_RPC_UNAVAILABLE = "ledger_rpc_unavailable"
CODE_MIGRATION_MISSING = "migration_missing"
CODE_COLUMN_MISSING = "column_missing"
CODE_DB_UNAVAILABLE = "db_unavailable"
CODE_LEDGER_MALFORMED = "ledger_malformed"
CODE_INVENTORY_MISSING = "inventory_missing"
CODE_MALFORMED_FILENAME = "malformed_filename"
CODE_DUPLICATE_IDENTITY = "duplicate_identity"
CODE_INTERNAL_ERROR = "internal_error"

# PostgREST codes that mean "the guard RPC cannot be called": function not
# found in the schema cache (PGRST202), undefined function (42883), or
# EXECUTE denied (42501). All resolve to the same remediation.
_RPC_UNAVAILABLE_CODES = frozenset({"PGRST202", "42883", "42501"})
# Probe-context codes meaning the probed column/table is not usable despite
# a ledger entry: SQL undefined column/table (42703/42P01) or the PostgREST
# schema-cache equivalents (PGRST204 column / PGRST205 table — raised when
# the cache has not learned the object, e.g. right after a migration without
# a cache reload). Same incident class, same remediation surface.
_PROBE_FAILURE_CODES = frozenset({"42703", "PGRST204", "42P01", "PGRST205"})

HINT_LEDGER_RPC_UNAVAILABLE = (
    "migration-ledger guard is not installed or the PostgREST schema cache is "
    "stale; apply migrations/025_migration_ledger_rpc.sql if absent, otherwise "
    "reload the schema cache and retry"
)
HINT_MIGRATION_MISSING = (
    "apply the listed migration file(s) to the database via the canonical "
    "workflow in docs/migrations.md, then redeploy"
)
HINT_CONFIG_MISSING = (
    "SUPABASE_URL and SUPABASE_SERVICE_KEY must be configured for the "
    "schema readiness check"
)
HINT_DB_UNAVAILABLE = "database unreachable or timed out; transient — retry or redeploy"
HINT_SKIPPED = (
    "Supabase configuration absent in a non-strict context; schema "
    "compatibility was NOT verified"
)


@dataclass(frozen=True)
class MigrationCheckResult:
    """Outcome of one drift check. Public fields only, plus log-safe detail."""

    status: Literal["ready", "skipped", "fail"]
    code: str
    migrations: tuple[str, ...] = field(default_factory=tuple)
    hint: str | None = None
    # Server-log only. Must contain exception class names / PostgREST codes /
    # ledger bookkeeping only — never raw exception text or env values.
    log_detail: str | None = None


def _clean_env(name: str) -> str | None:
    value = os.environ.get(name)
    if isinstance(value, str):
        value = value.strip()
    return value or None


def is_strict_context() -> bool:
    """Production/Railway contexts where a skipped schema check is forbidden.

    RAILWAY_ENVIRONMENT_NAME is injected by Railway on every deploy
    (production and previews) and cannot be forgotten by an operator.
    Key MEMBERSHIP triggers strictness — Railway may materialize deleted
    variables as empty strings, and an empty value still means "on Railway".
    ENVIRONMENT=production is honored as a second, explicit trigger.
    """
    if "RAILWAY_ENVIRONMENT_NAME" in os.environ:
        return True
    return _clean_env("ENVIRONMENT") == "production"


def has_guard_config() -> bool:
    return bool(_clean_env("SUPABASE_URL") and _clean_env("SUPABASE_SERVICE_KEY"))


def _scan_inventory(
    migrations_dir: Path,
) -> tuple[dict[str, str], MigrationCheckResult | None]:
    """Validate the packaged migration inventory.

    Returns (stem -> expected ledger name, None) on success, or
    ({}, failure result) on any inventory problem. Runs BEFORE every
    configuration/skip decision so an empty or corrupt inventory can never
    read as zero drift.
    """
    if not migrations_dir.is_dir():
        return {}, MigrationCheckResult(
            status="fail",
            code=CODE_INVENTORY_MISSING,
            hint="packaged migrations directory is absent",
        )

    malformed: list[str] = []
    stems: list[str] = []
    for entry in sorted(migrations_dir.iterdir(), key=lambda p: p.name):
        if entry.name.startswith("."):
            continue  # editor/OS droppings; never migration content
        if (
            entry.is_symlink()
            or not entry.is_file()
            or not MIGRATION_FILENAME_RE.match(entry.name)
        ):
            malformed.append(entry.name)
            continue
        stems.append(entry.name[: -len(".sql")])

    if malformed:
        return {}, MigrationCheckResult(
            status="fail",
            code=CODE_MALFORMED_FILENAME,
            migrations=tuple(sorted(malformed)),
            hint="unexpected entries in migrations/ do not match NNN_name.sql",
        )
    if not stems:
        return {}, MigrationCheckResult(
            status="fail",
            code=CODE_INVENTORY_MISSING,
            hint="packaged migrations directory is empty",
        )

    expected: dict[str, str] = {
        stem: LEDGER_NAME_ALIASES.get(stem, stem) for stem in stems
    }

    duplicates: set[str] = set()
    prefix_groups: dict[str, list[str]] = {}
    for stem in stems:
        prefix_groups.setdefault(stem[:3], []).append(stem)
    for group in prefix_groups.values():
        # Every prefix group must be a single file; the sole exception is the
        # exact historical 004 pair. A third 004_* file, or any duplicate in
        # the baseline range, fails closed like any other duplicate.
        if len(group) > 1 and tuple(sorted(group)) not in ALLOWED_DUPLICATE_PREFIX_GROUPS:
            duplicates.update(f"{stem}.sql" for stem in group)
    names_seen: dict[str, str] = {}
    for stem, name in expected.items():
        if name in names_seen:
            duplicates.add(f"{names_seen[name]}.sql")
            duplicates.add(f"{stem}.sql")
        names_seen[name] = stem
    if duplicates:
        return {}, MigrationCheckResult(
            status="fail",
            code=CODE_DUPLICATE_IDENTITY,
            migrations=tuple(sorted(duplicates)),
            hint="duplicate migration identities in migrations/",
        )

    return expected, None


def _default_client_factory():
    # Imported lazily so importing this module never constructs a client.
    from api.core.supabase_client import get_migration_guard_client

    return get_migration_guard_client(timeout_seconds=DATABASE_DEADLINE_SECONDS)


def _classify_api_error(exc: APIError, *, probing: str | None) -> MigrationCheckResult:
    code = getattr(exc, "code", None)
    if code in _RPC_UNAVAILABLE_CODES and probing is None:
        return MigrationCheckResult(
            status="fail",
            code=CODE_LEDGER_RPC_UNAVAILABLE,
            hint=HINT_LEDGER_RPC_UNAVAILABLE,
            log_detail=f"postgrest_code={code}",
        )
    if probing is not None and code in _PROBE_FAILURE_CODES:
        stem, table, column = next(p for p in COLUMN_PROBES if p[0] == probing)
        return MigrationCheckResult(
            status="fail",
            code=CODE_COLUMN_MISSING,
            migrations=(f"{stem}.sql",),
            hint=(
                f"ledger reports {stem} applied but {table}.{column} is not "
                "usable (missing, or the PostgREST schema cache is stale — "
                "reload the cache and retry)"
            ),
            log_detail=f"postgrest_code={code} probe={table}.{column}",
        )
    return MigrationCheckResult(
        status="fail",
        code=CODE_INTERNAL_ERROR,
        log_detail=f"APIError postgrest_code={code} probing={probing or 'ledger'}",
    )


def check_migration_compatibility(
    *,
    migrations_dir: Path | None = None,
    client_factory: Callable[[], object] | None = None,
    total_budget_seconds: float | None = CHECK_TOTAL_BUDGET_SECONDS,
) -> MigrationCheckResult:
    """Run one complete drift check. Never raises; never caches.

    total_budget_seconds bounds the WHOLE check: the leader aborts between
    database calls once the budget is spent (worst case: budget plus one
    in-flight call, which the client-level deadline bounds at
    DATABASE_DEADLINE_SECONDS).
    """
    deadline = (
        time.monotonic() + total_budget_seconds
        if total_budget_seconds is not None
        else None
    )
    try:
        return _check(
            migrations_dir=migrations_dir or MIGRATIONS_DIR,
            client_factory=client_factory or _default_client_factory,
            deadline=deadline,
        )
    except Exception as exc:  # hard boundary — class name only, no text
        return MigrationCheckResult(
            status="fail",
            code=CODE_INTERNAL_ERROR,
            log_detail=f"unhandled={type(exc).__name__}",
        )


def _deadline_exceeded(deadline: float | None) -> bool:
    return deadline is not None and time.monotonic() >= deadline


def _check(
    *,
    migrations_dir: Path,
    client_factory: Callable[[], object],
    deadline: float | None,
) -> MigrationCheckResult:
    expected, inventory_error = _scan_inventory(migrations_dir)
    if inventory_error is not None:
        return inventory_error

    if not has_guard_config():
        if is_strict_context():
            return MigrationCheckResult(
                status="fail", code=CODE_CONFIG_MISSING, hint=HINT_CONFIG_MISSING
            )
        return MigrationCheckResult(
            status="skipped", code=CODE_SCHEMA_CHECK_SKIPPED, hint=HINT_SKIPPED
        )

    if _deadline_exceeded(deadline):
        return MigrationCheckResult(
            status="fail",
            code=CODE_DB_UNAVAILABLE,
            hint=HINT_DB_UNAVAILABLE,
            log_detail="check_total_budget_exceeded",
        )

    try:
        client = client_factory()
    except RuntimeError as exc:
        # Factory guards: missing vars or a non-service-role key.
        return MigrationCheckResult(
            status="fail",
            code=CODE_CONFIG_MISSING,
            hint=HINT_CONFIG_MISSING,
            log_detail=f"factory={type(exc).__name__}",
        )

    try:
        response = client.rpc("migration_ledger", {}).execute()
    except APIError as exc:
        return _classify_api_error(exc, probing=None)
    except (httpx.TimeoutException, httpx.TransportError, ConnectionError) as exc:
        return MigrationCheckResult(
            status="fail",
            code=CODE_DB_UNAVAILABLE,
            hint=HINT_DB_UNAVAILABLE,
            log_detail=f"transport={type(exc).__name__}",
        )

    rows = getattr(response, "data", None)
    if not isinstance(rows, list):
        return MigrationCheckResult(status="fail", code=CODE_LEDGER_MALFORMED)
    ledger_names: set[str] = set()
    ledger_has_anchor = False
    for row in rows:
        if not isinstance(row, dict):
            return MigrationCheckResult(status="fail", code=CODE_LEDGER_MALFORMED)
        version = row.get("version")
        name = row.get("name")
        if not isinstance(version, str) or not version:
            return MigrationCheckResult(status="fail", code=CODE_LEDGER_MALFORMED)
        if name is not None and not isinstance(name, str):
            return MigrationCheckResult(status="fail", code=CODE_LEDGER_MALFORMED)
        if isinstance(name, str) and name:
            ledger_names.add(name)
        if version == BASELINE_ANCHOR_VERSION and name == BASELINE_ANCHOR_NAME:
            ledger_has_anchor = True

    missing: list[str] = []
    satisfied_stems: set[str] = set()
    for stem, expected_name in expected.items():
        if expected_name in ledger_names:
            satisfied_stems.add(stem)
        elif stem in BASELINE_MIGRATION_STEMS and ledger_has_anchor:
            satisfied_stems.add(stem)
        else:
            missing.append(f"{stem}.sql")
    if missing:
        return MigrationCheckResult(
            status="fail",
            code=CODE_MIGRATION_MISSING,
            migrations=tuple(sorted(missing)),
            hint=HINT_MIGRATION_MISSING,
        )

    for stem, table, column in COLUMN_PROBES:
        if stem not in satisfied_stems:
            continue
        if _deadline_exceeded(deadline):
            return MigrationCheckResult(
                status="fail",
                code=CODE_DB_UNAVAILABLE,
                hint=HINT_DB_UNAVAILABLE,
                log_detail="check_total_budget_exceeded",
            )
        try:
            client.table(table).select(column).limit(1).execute()
        except APIError as exc:
            return _classify_api_error(exc, probing=stem)
        except (httpx.TimeoutException, httpx.TransportError, ConnectionError) as exc:
            return MigrationCheckResult(
                status="fail",
                code=CODE_DB_UNAVAILABLE,
                hint=HINT_DB_UNAVAILABLE,
                log_detail=f"transport={type(exc).__name__} probe={table}.{column}",
            )

    expected_names = set(expected.values())
    ledger_ahead = ledger_names - expected_names
    log_detail = None
    if ledger_ahead:
        # Ledger entries the packaged inventory does not know. NOT a failure:
        # rolling code back after an additive migration must stay deployable
        # (apply-before-deploy is the canonical order). Only the COUNT is
        # logged — ledger name strings are database-controlled text and must
        # never flow into logs verbatim.
        log_detail = f"ledger_ahead_count={len(ledger_ahead)}"

    return MigrationCheckResult(
        status="ready", code=CODE_COMPATIBLE, log_detail=log_detail
    )


class _SingleFlight:
    """Share one in-flight check among concurrent callers.

    The leader runs the check; concurrent followers wait (bounded) on the
    same future instead of issuing their own database calls. The in-flight
    slot is cleared before the result is published, so the next caller after
    completion always starts a fresh check — results are never cached.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._inflight: concurrent.futures.Future | None = None

    def run(
        self,
        fn: Callable[[], MigrationCheckResult],
        *,
        wait_seconds: float,
    ) -> MigrationCheckResult:
        with self._lock:
            future = self._inflight
            leader = future is None
            if leader:
                future = concurrent.futures.Future()
                self._inflight = future
        assert future is not None
        if leader:
            # The slot is cleared BEFORE the result is published — deliberate:
            # a caller arriving after the check completed must become a fresh
            # leader (no-cache freshness), never attach to a finished future.
            # Followers cannot hang: they captured this future object under
            # the lock while it was still the in-flight slot, and the leader
            # unconditionally publishes to that same object below.
            try:
                result = fn()
            except BaseException as exc:
                with self._lock:
                    self._inflight = None
                future.set_exception(exc)
                raise
            with self._lock:
                self._inflight = None
            future.set_result(result)
            return result
        return future.result(timeout=wait_seconds)


_readiness_single_flight = _SingleFlight()


def run_readiness_check_single_flight() -> MigrationCheckResult:
    """Entry point for the readiness route: single-flight, bounded wait."""
    return _readiness_single_flight.run(
        check_migration_compatibility,
        wait_seconds=READINESS_WAIT_BUDGET_SECONDS,
    )
