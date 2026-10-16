"""
Tastelog: Health check endpoints.

/health is process liveness only — static, no dependencies. It is what
Railway healthchecks today and it must stay cheap and unconditional.

/health/ready is schema readiness (migration drift guard, 15.2.4-CF-MD1):
it compares the packaged migration inventory against the database's
migration ledger and returns 503 with a stable error code on any drift,
so a deployment whose code depends on an unapplied migration can be
gated before it takes traffic.
"""

import asyncio
import concurrent.futures
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.core.migration_guard import (
    CODE_DB_UNAVAILABLE,
    CODE_INTERNAL_ERROR,
    HINT_DB_UNAVAILABLE,
    READINESS_WAIT_BUDGET_SECONDS,
    MigrationCheckResult,
    run_readiness_check_single_flight,
)
from api.models.common import HealthResponse, ReadinessResponse

logger = logging.getLogger("tastelog.migration_guard")

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check for deployment verification."""
    return HealthResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse}},
)
async def readiness_check() -> JSONResponse:
    """Schema readiness: packaged migrations vs the database migration ledger.

    Concurrent callers share one in-flight database check (single-flight) and
    every caller receives a bounded response. Results are never cached — each
    new request after completion re-evaluates.
    """
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(run_readiness_check_single_flight),
            timeout=READINESS_WAIT_BUDGET_SECONDS + 1,
        )
    except (asyncio.TimeoutError, concurrent.futures.TimeoutError):
        result = MigrationCheckResult(
            status="fail",
            code=CODE_DB_UNAVAILABLE,
            hint=HINT_DB_UNAVAILABLE,
            log_detail="readiness_wait_budget_exceeded",
        )
    except Exception as exc:  # boundary of last resort — class name only
        result = MigrationCheckResult(
            status="fail",
            code=CODE_INTERNAL_ERROR,
            log_detail=f"route_unhandled={type(exc).__name__}",
        )

    if result.status == "ready":
        if result.log_detail:
            logger.info("readiness %s (%s)", result.code, result.log_detail)
    else:
        logger.warning(
            "readiness %s status=%s detail=%s",
            result.code,
            result.status,
            result.log_detail or "-",
        )

    payload = ReadinessResponse(
        status=result.status,
        code=result.code,
        migrations=list(result.migrations) or None,
        hint=result.hint,
    )
    status_code = 200 if result.status in ("ready", "skipped") else 503
    return JSONResponse(
        payload.model_dump(exclude_none=True), status_code=status_code
    )
