# Database migrations

## Fresh local database

Use `make demo` from the [root README](../README.md). It calls [db/bootstrap/apply.sh](../db/bootstrap/apply.sh) against local Supabase.

For a separate **fresh Supabase-compatible database**:

```bash
bash db/bootstrap/apply.sh '<psql connection string>'
```

The database must already have Supabase's auth schema and PostgREST roles. The script applies the reconstructed [base schema](../db/bootstrap/000_base_schema.sql), then the migration chain and ledger entries. It skips superseded `004_search_function.sql` but records that identity. Do not use this bootstrap to upgrade an existing database.

## Author and apply

1. Add `migrations/NNN_snake_case_name.sql` with a new numeric prefix. Prefer additive changes so old code remains compatible.
2. Review and apply the SQL through Supabase's `apply_migration` tool, using the exact filename stem as its name. This records the migration ledger; SQL Editor alone does not.
3. Reload the PostgREST schema cache after changing tables, columns, views or RPCs: `NOTIFY pgrst, 'reload schema';`.
4. Verify readiness before deploying dependent code. A failed deployment may need an explicit redeploy after the schema is fixed.

If an application fails partway, inspect the actual schema before retrying. Do not hide partial changes by inserting ledger rows or rewriting old migrations; prepare a forward fix.

## Verify

With `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` configured (the CLI also loads `.env`):

```bash
api/.venv/bin/python scripts/check_migration_drift.py
```

`/health/ready` uses the same [guard](../api/core/migration_guard.py). Railway's repository configuration points its healthcheck here. The API performs no automatic DDL.

| Result | Action |
|---|---|
| `compatible` | Inventory, ledger and selected column probes agree. |
| `schema_check_skipped` | Local config is absent; the database is **not verified**. CLI fails unless `--allow-skipped` is given. |
| `migration_missing` | Inspect and apply the named migrations. |
| `column_missing` | Inspect partial application or stale PostgREST schema cache. |
| `ledger_rpc_unavailable` | Check migration 025, service-role access and schema cache. |
| Config, inventory or database errors | Fix the reported configuration, packaging or connection problem and rerun. |

Strict checks prohibit skipping when `RAILWAY_ENVIRONMENT_NAME` is present or `ENVIRONMENT=production`. Server settings must be in the process environment.

## Compatibility rules

- Historical migrations 003–015 are exempt only with ledger anchor `20260412015417` / `016_search_fts_rpc_v3`. This includes the two historical `004_*` files; new duplicate prefixes fail.
- Migration 020 has one accepted historical alias, `riff_lineage_in_search`. New migrations use their exact stems.
- Ledger entries newer than the code are informational. They do not guarantee old code works with non-additive schema changes.
- The guard checks inventory/ledger agreement and selected columns, not SQL checksums, application order, every policy/function, data integrity or all partial failures. A compatible result still needs workflow verification.

The isolated Docker proof applies the base and full chain, including both 004 files, and tests migrations 026–028:

```bash
bash tests/db/run_db_proof.sh
```
