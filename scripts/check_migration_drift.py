#!/usr/bin/env python3
"""
Tastelog: read-only migration drift check (15.2.4-CF-MD1).

Compares the repository migration inventory (migrations/*.sql) against the
target database's migration ledger and probes selected hot-path columns.
Strictly read-only — never applies anything.

Requires ONLY SUPABASE_URL and SUPABASE_SERVICE_KEY (from the environment or
a repo-root .env). Values are never printed.

Usage:
    python scripts/check_migration_drift.py [--allow-skipped]

Exit codes:
    0  schema compatible (or skipped, only with --allow-skipped)
    1  drift, misconfiguration, unreachable database, or skipped without
       --allow-skipped

Output: the public readiness fields only (status, code, migrations, hint).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only migration drift check.")
    parser.add_argument(
        "--allow-skipped",
        action="store_true",
        help="exit 0 when the check is skipped for missing local config "
        "(default: skipped exits 1 so automation cannot mistake it for green)",
    )
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")

    from api.core.migration_guard import check_migration_compatibility

    result = check_migration_compatibility()

    print(f"status: {result.status}")
    print(f"code: {result.code}")
    for filename in result.migrations:
        print(f"migration: {filename}")
    if result.hint:
        print(f"hint: {result.hint}")

    if result.status == "ready":
        return 0
    if result.status == "skipped":
        return 0 if args.allow_skipped else 1
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # boundary: class name only, never raw text
        print(f"status: fail\ncode: internal_error\ndetail: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
