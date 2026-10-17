# Migrations — Canonical Workflow

> **This document is the single source of truth for authoring, applying, and
> verifying database migrations.** The old `run_migration.py` script is
> deleted (it required a `public.exec_sql` RPC that does not exist in
> production, and its statement splitting corrupted `$$` function bodies).

## Why the drift guard exists

Migration `024_grocery_items_note.sql` existed in the repository and deployed
Grocery code depended on it, but production had not applied it. Railway
deployed successfully, static `/health` returned 200, backend tests passed
against mocked Supabase — and the live Grocery workflow failed with HTTP 500.
The guard makes that incident class detectable early and actionably
(`/health/ready`, drift CLI). **Until the separately authorized rollout stage
points Railway's healthcheck at `/health/ready`, this is on-demand detection,
not deployment enforcement** — a drifted deploy still takes traffic if nobody
checks.

## The pieces

| Piece | What it does |
|---|---|
| `migrations/NNN_name.sql` | Hand-authored SQL, one migration per file |
| `migrations/025_migration_ledger_rpc.sql` | Installs `public.migration_ledger()` — a restricted read-only RPC over `supabase_migrations.schema_migrations` (EXECUTE: service_role only) |
| `api/core/migration_guard.py` | Compares the packaged inventory against the ledger + column probes; read-only, no DDL, no caching |
| `GET /health/ready` | Schema readiness endpoint: 200 `compatible` (or 200 `schema_check_skipped` in non-strict local contexts) or 503 with a stable error code. Concurrent callers share one in-flight check |
| `GET /health` | Unchanged process liveness (static). Railway currently healthchecks this path; switching the healthcheck to `/health/ready` is a separately authorized rollout stage |
| `scripts/check_migration_drift.py` | Operator CLI for the same check; needs only `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |

## Authoring rules

1. Filename `NNN_snake_case_name.sql` — three digits, lowercase, `.sql`.
   Anything else in `migrations/` fails the guard (`malformed_filename`).
2. Never reuse a numeric prefix. (The historical `004_*` pair is
   grandfathered inside the frozen pre-ledger baseline; nothing else is.)
3. Migrations must be additive/backward-compatible wherever possible
   (expand/contract): old code must keep working after the migration is
   applied, because migrations are applied **before** the dependent code
   deploys, and a rollback re-exposes old code to the new schema.
   Any non-additive migration needs an explicit backward-compatibility
   review in its gate.
4. No automatic DDL anywhere in the API. Migrations are applied manually
   through the canonical mechanism below.

## Applying a migration (canonical mechanism — the ONLY one)

Apply via **Supabase MCP `apply_migration`** with `name` set to the exact
filename stem (e.g. `026_example_change` for
`migrations/026_example_change.sql`). This both executes the SQL and writes
the ledger row the guard compares against.

- Do **not** apply via the Supabase Dashboard SQL Editor. It does not write
  the migration ledger, and re-applying non-idempotent DDL afterwards fails
  on duplicate objects — stranding the schema changed but unledgered.
  If an emergency ever forces a manual application, ledger repair is its own
  separately approved procedure after exact schema verification; never
  hand-insert ledger rows as a routine fix.
- Migration 020 was historically applied under the ledger name
  `riff_lineage_in_search` (no prefix). The guard carries that single alias;
  do not create new aliases — apply with the exact stem.

## Verifying

```bash
python scripts/check_migration_drift.py            # strict: skipped exits 1
python scripts/check_migration_drift.py --allow-skipped
```

Or check `GET /health/ready` on a deployed API.

Readiness codes:

| status | code | meaning |
|---|---|---|
| ready | `compatible` | inventory, ledger, and probes agree |
| skipped | `schema_check_skipped` | non-strict context (local/tests) without Supabase config — NOT verified |
| fail | `config_missing` | strict context missing `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (or key is not service-role) |
| fail | `ledger_rpc_unavailable` | `migration_ledger()` missing, EXECUTE denied, or PostgREST schema cache stale — apply migration 025 if absent, else reload the cache |
| fail | `migration_missing` | listed migration file(s) not in the ledger — apply them |
| fail | `column_missing` | ledger claims a migration but a probed column/table is not usable — either absent (partial application: inspect) or the PostgREST schema cache is stale (reload and retry) |
| fail | `db_unavailable` | unreachable/timed out (5s per-call deadline) — transient |
| fail | `ledger_malformed` | unexpected ledger response shape |
| fail | `inventory_missing` | packaged `migrations/` absent or empty — packaging problem, never "zero drift" |
| fail | `malformed_filename` / `duplicate_identity` | inventory hygiene violation, exact names listed |
| fail | `internal_error` | unexpected checker failure (diagnostics in server logs) |

Strictness: the check is strict (skip forbidden) when `RAILWAY_ENVIRONMENT_NAME`
is present (Railway injects it on every deploy, including previews) or when
`ENVIRONMENT=production`. Note: the guard reads process environment variables
only; a local `.env` file is honored by the CLI (which loads it) but not by a
locally run server process unless the variables are exported.

## Remediation: readiness reports `migration_missing`

1. Note the exact filename(s) from `/health/ready` or the drift CLI.
2. Inspect `migrations/<file>` in the repo.
3. Apply it via Supabase MCP `apply_migration(name=<stem>)`.
4. Verify: `list_migrations` shows the stem; if the migration is in the
   guard's probe list, the probe column now exists.
5. If the migration added/changed RPCs, views, **tables, or columns**, reload
   the PostgREST schema cache (`NOTIFY pgrst, 'reload schema'`) — 025 embeds
   its own.
6. Re-run `scripts/check_migration_drift.py` → `compatible`.
7. **Explicitly redeploy the same commit** (Railway dashboard → Redeploy, or
   `railway redeploy`). Applying a migration does NOT automatically revive a
   failed Railway deployment.
8. Verify `/health/ready` returns 200 and spot-check the affected workflow.

## Partial migration failure: stop and inspect

If applying a migration errors partway:

- **Do not** blindly retry the whole file.
- **Do not** manually insert rows into `supabase_migrations.schema_migrations`.
- **Do not** rewrite migration history.
- **Do not** run destructive rollback SQL without a migration-specific,
  separately approved plan.

Capture the exact error, inspect actual database state per statement
(read-only `information_schema` / `pg_catalog` queries), and author an
idempotent forward-fix as a NEW migration with its own approval. The guard is
conservative here by construction: a partially applied migration has no
ledger row, so readiness keeps reporting `migration_missing` rather than
pretending the database is compatible.

## Rollback notes

- Rolling back **code** past an applied additive migration is safe for the
  guard: ledger entries unknown to the packaged inventory ("ledger ahead")
  are informational, not failures.
- Application-level compatibility on rollback is only guaranteed for
  additive migrations — see authoring rule 3.
- Once Railway's healthcheck points at `/health/ready` (separately authorized
  stage), rolling back to an artifact that predates the endpoint requires
  restoring `healthcheckPath = /health` FIRST, or the old artifact can never
  pass its healthcheck.

## What V1 guarantees — and what it does not

Detects: post-baseline repo migrations absent from the ledger (and all files
on a fresh database); `migration_ledger()` unavailable; packaged inventory
absent/empty; malformed filenames / unexpected entries; duplicate identities;
probed columns missing despite ledger entries (probes: 008
`grocery_lists.updated_at`, 009 `recipes.favorite`, 024
`grocery_items.note`); missing production config; unreachable database
(fails closed).

Does NOT detect (explicit exclusions): out-of-order application; modified
migration contents after application (no checksums); partial multi-statement
application beyond the probe list; drift in RPCs/views/policies/grants/
triggers/functions other than `migration_ledger` existence and probed
columns; data drift; ledger-ahead entries (informational only);
deleted/renamed migration files in repo history; forged/copied ledger rows
(including the baseline anchor — partially mitigated by the sentinel
probes); an altered `migration_ledger()` body; invalid-but-present
credentials (the service-role check decodes the key, it does not
cryptographically verify it); PostgREST schema-cache staleness windows;
old-code incompatibility with non-additive ledger-ahead migrations;
partial-but-non-empty packaged inventory.

## Fresh database bootstrap

`migrations/` starts at 003. The original 001/002 files are not in this
repository, so a fresh database needs `db/bootstrap/000_base_schema.sql`
first: a reconstruction of the five pre-003 tables (`recipes`,
`recipe_ingredients`, `recipe_steps`, `grocery_lists`, `grocery_items`)
derived from the column lists that later migrations, the API's insert
paths, the response models and `docs/architecture.md` pin down. Its header
lists the evidence and the assumptions it could not evidence. It cannot be
diffed against production from this repository, and it is deliberately
not under `migrations/`: the guard requires every file there to exist in
the production ledger, and this schema predates the ledger.

`db/bootstrap/apply.sh <psql args>` applies the base schema and then every
migration in order (the superseded `004_search_function.sql` is skipped,
as production applied them) to a database that already has Supabase's
`auth` schema and PostgREST roles — `supabase start` or the
`supabase/postgres` image. It also records every file under
`migrations/` in `supabase_migrations.schema_migrations` under the name
the guard expects (020 under its production alias, the skipped 004 as
not applied), so `/health/ready` reports `compatible` against the fresh
database. `tests/db/run_db_proof.sh` runs the same base
and chain on the pinned production Postgres image under Docker, with no
migration skipped, before proving 026 and 027.

## Baseline (pre-ledger history)

Migrations 003–015 (14 files, including both `004_*` files) predate the
production ledger. The guard exempts them ONLY when the ledger contains the
exact anchor row `version 20260412015417` + `name 016_search_fts_rpc_v3`
(production's first ledgered migration). A fresh database has no anchor, so
every file is required there — a fresh environment must be migrated in full,
not grandfathered.
