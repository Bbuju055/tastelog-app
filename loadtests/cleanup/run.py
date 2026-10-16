#!/usr/bin/env python3
"""
Phase 14.2C — Load-target cleanup CLI.

Operator runs this against the isolated load-target Supabase project to
clear app data between runs. Preserves auth.users.

Requires loadtests/cleanup/sql/loadtest_helpers.sql to have been applied
ONCE to the load target by the operator. NOT a migration. NOT applied to
production.

Hard non-goals:
  - No production traffic.
  - No execution in 14.2C.
"""

from __future__ import annotations

import argparse
import logging
import sys

from loadtests.lib.guards import TargetGuardError
from loadtests.lib.supabase_admin import get_load_target_admin_client

LOG = logging.getLogger("loadtests.cleanup")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Clear app data on the load-target Supabase project."
    )
    p.add_argument("--dry-run", action="store_true", help="Run guards only.")
    return p.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _parse_args()

    try:
        client = get_load_target_admin_client()
    except TargetGuardError as exc:
        LOG.error("Guard failed: %s", exc)
        return 2

    if args.dry_run:
        LOG.info("Dry run: guards passed. No RPCs called.")
        return 0

    LOG.info("Calling loadtest_truncate_all() …")
    client.rpc("loadtest_truncate_all").execute()
    LOG.info("Calling loadtest_refresh_search_index() …")
    client.rpc("loadtest_refresh_search_index").execute()
    LOG.info("Cleanup complete. auth.users preserved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
