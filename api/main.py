"""
Tastelog: FastAPI application entry point.

Factory pattern for testability. ASGI entrypoint at module level.
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.core.config import get_settings


def _init_sentry_from_env() -> None:
    """
    Initialize Sentry as early as possible, without depending on get_settings().
    This ensures startup/import/config failures can be captured.
    """
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return

    import sentry_sdk
    from sentry_sdk.integrations.logging import LoggingIntegration

    environment = (os.getenv("SENTRY_ENVIRONMENT") or "local").strip()

    # Prefer explicit SENTRY_RELEASE, fall back to Railway/Vercel commit SHA
    release = (os.getenv("SENTRY_RELEASE") or "").strip()
    if not release:
        release = (
            os.getenv("RAILWAY_GIT_COMMIT_SHA")
            or os.getenv("VERCEL_GIT_COMMIT_SHA")
            or ""
        ).strip() or None

    def before_send(event, hint):
        # Never ship auth secrets or request bodies (uploads) to Sentry.
        req = event.get("request")
        if isinstance(req, dict):
            headers = req.get("headers") or {}
            if isinstance(headers, dict):
                for k in list(headers.keys()):
                    lk = str(k).lower()
                    if lk in ("authorization", "cookie", "x-api-key"):
                        headers[k] = "[redacted]"
                req["headers"] = headers

            # Prevent accidental body/cookie capture
            req.pop("data", None)
            req.pop("cookies", None)
            event["request"] = req

        # Also scrub cookies from the event root if present
        event.pop("cookies", None)
        return event

    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=release,
        send_default_pii=False,
        before_send=before_send,
        integrations=[
            # Capture ERROR/WARNING logs as breadcrumbs, and exceptions as events.
            LoggingIntegration(level=None, event_level="ERROR"),
        ],
        # Tracing OFF by default. Enable per-environment via SENTRY_TRACES_SAMPLE_RATE
        # (e.g. on an isolated load target). Empty string collapses to 0.0 to
        # tolerate Railway's "" semantics for deleted env vars.
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE") or "0.0"),
    )


_init_sentry_from_env()


def create_app() -> FastAPI:
    """Application factory.

    Builds the FastAPI app, attaches middleware, registers routers.
    Config is loaded lazily via get_settings() (cached).
    """
    settings = get_settings()

    app = FastAPI(
        title="Tastelog API",
        description="Recipe capture, search, and grocery list management",
        version="1.0.0",
    )

    # CORS middleware: only attach if origins configured (empty = locked down)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["*"],
        )

    # Register routers (local import to avoid circular deps)
    from api.routes import cook_events, drafts, grocery, health, recipes, riff, storage, tokens

    app.include_router(health.router)
    app.include_router(recipes.router)
    app.include_router(tokens.router)
    app.include_router(storage.router)
    app.include_router(grocery.router)
    app.include_router(drafts.router)
    app.include_router(cook_events.router)
    app.include_router(riff.router)

    return app


# ASGI entrypoint for Procfile/Railway/uvicorn
app = create_app()
