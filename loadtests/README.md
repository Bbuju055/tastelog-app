# Tastelog Load-Test Harness — Phase 14.2B + 14.2C Skeleton

This directory contains the **k6 load-test harness skeleton** and the
**Python seed/cleanup tooling skeleton**. Phase 14.2B (k6 scaffolding)
and Phase 14.2C (seed/cleanup + auxiliary k6 hookups) ship file shapes
only — there is **no execution**, **no synthetic traffic**, **no
production traffic**, **no real AI calls**, and **no dependency
install**.

## Scope

- **In scope for 14.2B:** parse-only k6 scenario skeletons, target-guard
  module, env-name conventions, JSON aggregator skeleton.
- **In scope for 14.2C:** Python seed + cleanup CLIs, deterministic
  fixture generators, shared Python target guards, service-role client
  factory, one-time operator-applied SQL helpers for the load target,
  k6 config + Tier A scenario hookups for seed-derived IDs.
- **Out of scope for 14.2B/C:**
  - Execution (sequenced to Phase 14.2E and requires explicit approval).
  - AI-stub factory at the `anthropic.Anthropic` SDK boundary (sequenced
    to Phase 14.2D — `ANTHROPIC_STUB_MODE` env var documented here only).
  - Real Anthropic calls. ≤10 calibration iterations per Tier C
    expensive flow allowed only after separate approval.
  - Bottleneck fixes (Phase 14.3, gated on measured 14.2 results).
  - Phase 14.4 TestFlight build / submission prep.
  - Phase 14.5 external TestFlight rollout (blocked until 14.2 + 14.3
    pass).

## Non-negotiables

- **No production traffic.** `loadtests/k6/lib/target-guard.js` and
  `loadtests/lib/guards.py` refuse the production host literal
  `tastelog-production.example.com` and any host containing the
  fragment `tastelog-production`. The Python guards additionally refuse
  Supabase service keys whose JWT `ref` claim matches the
  operator-supplied `LOADTEST_PROD_REF_REFUSE_FRAGMENT`.
- **No synthetic traffic against production**, even authenticated reads.
- **No real AI calls.** Tier C is a stub in 14.2B/C and must not be
  executed. Once Phase 14.2D ships, the load target sets
  `ANTHROPIC_STUB_MODE=deterministic`.
- **No secret values in chat, commits, or logs.** Env-var NAMES only.
  Errors reference variable names, never values.
- **`RIFF_DAILY_LIMIT` stays untouched in code** (single source of truth
  at `api/core/riff_usage.py:41`). Sustained Riff testing is mitigated
  in the seed by ≥50 dedicated Riff-cap users, not by lowering the cap.

## Operator prerequisites (outside this repo)

These must be in place before Phase 14.2E. The operator captures and
holds the corresponding values; nothing here is committed.

- Isolated **Railway service** running the same backend image as
  production. Not the production service.
- Isolated **Supabase project**. Not the production project. Schema
  seeded by migrations `005` → `023`.
- One-time SQL setup on the load target: apply
  `loadtests/cleanup/sql/loadtest_helpers.sql` once via Supabase MCP,
  psql, or the Supabase SQL editor. **DO NOT apply to production.**
- Load target may set `SENTRY_ENVIRONMENT=loadtest` (or similar) and
  `SENTRY_TRACES_SAMPLE_RATE > 0` to enable transaction tracing on the
  load target only. **Production default for `SENTRY_TRACES_SAMPLE_RATE`
  stays `0.0` — do NOT set this on prod.**
- Load target sets `ANTHROPIC_STUB_MODE=deterministic` once Phase 14.2D
  ships. Until then Tier C scenarios remain unrun.
- Dashboards captured before any execution (operator-only — never
  printed in chat): Railway plan tier / resource class / CPU + memory
  ceiling; Supabase plan tier / DB pool ceiling / observed connection
  usage / storage + auth limits; Sentry project + environment names +
  tracing quota; Anthropic per-call cost from the Anthropic console.

## Env vars

Copy the example template to a local file. The local file is gitignored.

| Name                                | Required for           | Purpose                                                                                  |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `LOADTEST_API_BASE_URL`             | every scenario         | Load-target backend base URL. Guarded against production literal.                        |
| `LOADTEST_JWT`                      | authed Tier A runs     | Temporary JWT minted by the seed. Consumed by k6 scenarios.                              |
| `LOADTEST_SUPABASE_URL`             | seed + cleanup         | Load-target Supabase project URL.                                                        |
| `LOADTEST_SUPABASE_SERVICE_KEY`     | seed + cleanup         | Service-role key for the load-target Supabase project.                                   |
| `LOADTEST_SUPABASE_ANON_KEY`        | seed + cleanup         | Anon key for the load-target Supabase project.                                           |
| `LOADTEST_PROD_REF_REFUSE_FRAGMENT` | seed + cleanup         | Operator-supplied substring of the production project ref. Guards refuse without it. Never logged. |
| `LOADTEST_SEED_USER_PASSWORD`       | seed                   | Password used for all seeded users incl. the primary. Never logged.                      |
| `LOADTEST_RECIPE_ID`                | Tier A scenarios       | Seed-derived primary recipe UUID. Populated from `loadtests/output/seed-ids.json`.       |
| `LOADTEST_LIST_ID`                  | Tier A scenarios       | Seed-derived primary grocery list UUID. Same source.                                     |
| `LOADTEST_SEARCH_QUERY`             | Tier A scenarios       | Search query string known to match seeded recipe titles. Same source.                    |
| `SENTRY_TRACES_SAMPLE_RATE`         | optional, load only    | Enable Sentry tracing on the load target. Production stays `0.0`.                        |
| `ANTHROPIC_STUB_MODE`               | once 14.2D ships       | `off` (real SDK) or `deterministic` (stub). Load target uses stub.                       |

## Layout

```
loadtests/
├── README.md
├── .env.loadtest.example
├── .gitignore
├── lib/
│   ├── __init__.py
│   ├── guards.py             # Python target guards (URL + service-key + ref)
│   └── supabase_admin.py     # service-role client factory
├── seed/
│   ├── fixtures.py           # deterministic generator templates
│   └── run.py                # seed CLI (operator-only)
├── cleanup/
│   ├── run.py                # cleanup CLI (operator-only)
│   └── sql/
│       └── loadtest_helpers.sql  # operator-applied SQL (load target only)
└── k6/
    ├── lib/
    │   ├── target-guard.js   # refuses production host literal
    │   ├── config.js         # env loader + Tier A endpoint constants
    │   └── auth.js           # JWT helpers, consumes env-injected token
    ├── scenarios/
    │   ├── tier_a_reads.js     # concrete Tier A cheap reads (parse only)
    │   ├── tier_b_mutations.js # stub only (14.2C blocker)
    │   └── tier_c_riff.js      # stub only (14.2D blocker)
    └── aggregate.mjs           # k6 JSON aggregator (Node ESM, stdlib only)
```

`loadtests/output/` and `loadtests/results/` are gitignored.

## Local setup (manual, do not commit)

1. Copy the example template:

   ```sh
   cp loadtests/.env.loadtest.example loadtests/.env.loadtest
   ```

2. Fill `loadtests/.env.loadtest` with the load-target URL, JWT, and
   Supabase keys provided by the operator. The file is gitignored.

## Phase 14.2C — Seed / cleanup runbook

Phase 14.2C ships the **tooling skeleton** under `loadtests/seed/`,
`loadtests/cleanup/`, and `loadtests/lib/`. The scripts are functional
and operator-runnable, but **were NOT executed in Phase 14.2C**.
Execution belongs to Phase 14.2E.

### One-time operator setup (load target only)

Apply `loadtests/cleanup/sql/loadtest_helpers.sql` ONCE to the isolated
load-target Supabase project. This installs two `SECURITY DEFINER`
functions used by `loadtests/cleanup/run.py`:

- `loadtest_truncate_all()` — TRUNCATE CASCADE on app tables.
- `loadtest_refresh_search_index()` — REFRESH the materialized view.

EXECUTE is granted to `service_role` only; anon and authenticated are
revoked.

**DO NOT apply this file to production.** It is not a migration. It
must not be added to `migrations/`.

### Seed flow (operator-only)

```sh
# DO NOT EXECUTE IN 14.2C — illustrative only.
# python -m loadtests.seed.run --dry-run     # guards only, no writes
# python -m loadtests.seed.run                # full seed
```

The seed:

1. Runs all `loadtests/lib/guards.py` checks (URL, service-key role,
   ref refusal fragment, all required env vars present).
2. Idempotently ensures the primary + baseline + Riff-cap users via
   `auth.admin.create_user` with deterministic emails under the
   `loadtest.tastelog.local` domain.
3. Inserts deterministic recipes / ingredients / steps / grocery /
   cook events / Riff sessions for the baseline pool.
4. Signs in as the primary load-test user to mint a Supabase JWT.
5. Writes JWT to `loadtests/output/loadtest-jwt.txt` (mode 0600,
   gitignored).
6. Writes seed-derived IDs to `loadtests/output/seed-ids.json` (mode
   0600, gitignored).
7. Prints env-var NAMES to export. **Never prints values.**

After seed, the operator exports the env vars consumed by k6:

```sh
# DO NOT EXECUTE IN 14.2C — illustrative only.
# export LOADTEST_JWT="$(cat loadtests/output/loadtest-jwt.txt)"
# export LOADTEST_RECIPE_ID="$(jq -r .primary_recipe_id loadtests/output/seed-ids.json)"
# export LOADTEST_LIST_ID="$(jq -r .primary_list_id loadtests/output/seed-ids.json)"
# export LOADTEST_SEARCH_QUERY="$(jq -r .search_query loadtests/output/seed-ids.json)"
```

### Cleanup flow (operator-only)

```sh
# DO NOT EXECUTE IN 14.2C — illustrative only.
# python -m loadtests.cleanup.run --dry-run   # guards only
# python -m loadtests.cleanup.run              # truncate + refresh
```

`auth.users` is preserved across runs. The seed is idempotent on re-run.

### Why no dependency install

`supabase`, `pyjwt`, and `python-jose` are already in `requirements.txt`
for the API. The seed and cleanup scripts reuse the same `.venv` the
operator uses for `make api-test`. No new deps.

## Illustrative commands — DO NOT EXECUTE IN 14.2B/C

These commands are reference only and **must NOT be run in Phase 14.2B
or 14.2C**. Execution is a separate ticket (Phase 14.2E) and requires
explicit approval. k6 is **not** installed in this slice.

```sh
# DO NOT EXECUTE IN 14.2B/C — illustrative only.
# k6 run --env LOADTEST_API_BASE_URL=... --env LOADTEST_JWT=... \
#   --env LOADTEST_RECIPE_ID=... --env LOADTEST_LIST_ID=... \
#   --env LOADTEST_SEARCH_QUERY=... \
#   loadtests/k6/scenarios/tier_a_reads.js
#
# node loadtests/k6/aggregate.mjs path/to/k6-output.json
```

## References

- `api/main.py` — `_init_sentry_from_env()` (Phase 14.2A env-driven
  Sentry tracing knob).
- `api/core/riff_usage.py` — `RIFF_DAILY_LIMIT` single source of truth.
