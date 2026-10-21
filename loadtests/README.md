# Load-test tooling

Tier A reads, seed/cleanup CLIs and the JSON aggregator are implemented. Tier B mutations and Tier C Riff scenarios are stubs that throw if run. This directory does not establish a measured capacity claim.

## Target setup

Use an isolated API and Supabase database with the current [schema](../docs/migrations.md), never production. Set the API's `ANTHROPIC_STUB_MODE=deterministic`. The stub exists; no real model calls are needed for load testing.

Copy [.env.loadtest.example](.env.loadtest.example) to `loadtests/.env.loadtest`, fill in the isolated target's values, and export them in your shell. The CLIs read process environment; they do not load this file automatically. Seed/cleanup reuse the API virtualenv. Tier A also requires k6; the aggregator requires Node.

[Target guards](lib/guards.py) reject known production host fragments and a configured Supabase project-ref fragment. These checks are not proof of isolation: verify the actual target before writes or traffic. Keep service keys and generated JWTs out of logs and commits.

## Seed and read traffic

From the repository root, inspect options and validate configuration first:

```bash
api/.venv/bin/python -m loadtests.seed.run --help
api/.venv/bin/python -m loadtests.seed.run --dry-run
```

Without `--dry-run`, seed creates test users and app records. It writes a JWT to `loadtests/output/loadtest-jwt.txt` and IDs to `loadtests/output/seed-ids.json`, both ignored and mode 0600. Export `LOADTEST_JWT`, `LOADTEST_RECIPE_ID`, `LOADTEST_LIST_ID` and `LOADTEST_SEARCH_QUERY` from those files, alongside `LOADTEST_API_BASE_URL`.

Review the load profile in [tier_a_reads.js](k6/scenarios/tier_a_reads.js) before running:

```bash
k6 run --out json=loadtests/output/reads.json loadtests/k6/scenarios/tier_a_reads.js
node loadtests/k6/aggregate.mjs loadtests/output/reads.json
```

## Cleanup is destructive

[loadtest_helpers.sql](cleanup/sql/loadtest_helpers.sql) installs service-role-only functions that truncate app tables with `CASCADE` and refresh search. Apply it only to the disposable load database, outside the application migration chain.

```bash
api/.venv/bin/python -m loadtests.cleanup.run --dry-run
```

Omitting `--dry-run` calls those functions and deletes app data; auth users remain. Do not use this cleanup on a personal demo database containing work you want to keep.

Seed, cleanup and load traffic were not executed during the documentation cleanup. Validate the tooling against the selected disposable target before relying on its results.
