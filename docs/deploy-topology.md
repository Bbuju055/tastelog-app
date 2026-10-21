# Deployment configuration

This describes repository configuration, not verified live infrastructure.

- [railway.toml](../railway.toml) runs Uvicorn on `$PORT` and checks `/health/ready` with a 30-second timeout. Replica count is managed in the Railway dashboard.
- [nixpacks.toml](../nixpacks.toml) installs Python 3.12 and Poppler for PDF inspection/rendering.
- [Procfile](../Procfile) provides the same Uvicorn start command.
- API settings are listed in [.env.example](../.env.example). Real extraction requires Anthropic credentials; the local demo uses `ANTHROPIC_STUB_MODE=deterministic`.
- Web settings are in [tastelog-web/.env.example](../tastelog-web/.env.example). `/api/*` requests are rewritten to the configured backend.

Apply required [migrations](migrations.md) before deploying dependent code. `/health` checks only process liveness; `/health/ready` checks schema compatibility and returns 503 on failure. A successful check does not verify every database object or user journey.

After changing schema or deployment settings, verify readiness and the affected user flow. Rolling back code does not roll back schema. If an older artifact lacks `/health/ready`, its healthcheck configuration must be adjusted before rollback.
