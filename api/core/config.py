"""
Tastelog: Centralized configuration using Pydantic Settings v2.
Validates environment variables at startup (fail-fast).
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, HttpUrl, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    All required fields use Field(min_length=1) to reject empty strings.
    UUIDs and URLs are strongly typed for validation.
    Snake_case attributes map to UPPER_CASE env vars via aliases.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # Supabase: optional — app must boot in unauthenticated mode when missing.
    # Use has_supabase_env() / require_supabase() guards at call sites.
    supabase_url: HttpUrl | None = Field(default=None, alias="SUPABASE_URL")
    supabase_service_key: str | None = Field(default=None, alias="SUPABASE_SERVICE_KEY")
    supabase_anon_key: str | None = Field(default=None, alias="SUPABASE_ANON_KEY")

    # Railway may inject empty-string env vars for deleted values.
    # Treat "" as None so optional config does not crash at boot.
    @field_validator(
        "supabase_url", "supabase_anon_key", "supabase_service_key", mode="before"
    )
    @classmethod
    def _empty_str_to_none(cls, v: Any) -> Any:
        """Coerce blank env vars to None so HttpUrl validation doesn't choke on ''."""
        if isinstance(v, str) and v.strip() == "":
            return None
        return v

    # Required - fail-fast at boot
    anthropic_api_key: str = Field(min_length=1, alias="ANTHROPIC_API_KEY")

    # Test user: optional — only required in dev/test flows, not production boot.
    test_user_id: UUID | None = Field(default=None, alias="TEST_USER_ID")

    # JWT authentication settings
    supabase_jwt_audience: str = Field(default="authenticated", alias="SUPABASE_JWT_AUDIENCE")
    supabase_jwt_issuer: str | None = Field(default=None, alias="SUPABASE_JWT_ISSUER")
    dev_auth_bypass: bool = Field(default=False, alias="DEV_AUTH_BYPASS")

    # Riff streaming endpoint feature flag (Phase 13.5).
    # When False, POST /api/recipes/{id}/riff/stream returns 404 — the route
    # is mounted but invisible by behavior. Default off; enabled per env via
    # RIFF_STREAMING_ENABLED. Sync /riff endpoint is unaffected.
    riff_streaming_enabled: bool = Field(
        default=False, alias="RIFF_STREAMING_ENABLED"
    )

    # Server settings - validated environment
    environment: Literal["development", "staging", "production"] = Field(
        default="development", alias="ENVIRONMENT"
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # CORS: empty by default (locked down), must be explicitly configured
    cors_origins: list[str] = Field(default_factory=list, alias="CORS_ORIGINS")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v: Any) -> list[str]:
        """Parse CORS_ORIGINS from JSON list or comma-separated string."""
        # Unset / empty -> []
        if v is None:
            return []
        if isinstance(v, list):
            return [s.strip() for s in v if isinstance(s, str) and s.strip()]
        if isinstance(v, str):
            raw = v.strip()
            if not raw:
                return []
            # Allow JSON list: '["https://a.com","https://b.com"]'
            if raw.startswith("["):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    # fall back to comma-split
                    parsed = raw
                else:
                    if isinstance(parsed, list):
                        return [str(s).strip() for s in parsed if str(s).strip()]
            # Comma-separated
            return [part.strip() for part in raw.split(",") if part.strip()]

        # Anything else -> fail fast
        raise TypeError("cors_origins must be a list or a string")

    @model_validator(mode="after")
    def validate_cors_production(self):
        """Block wildcard CORS in production."""
        if self.environment == "production" and "*" in self.cors_origins:
            raise ValueError("CORS wildcard '*' is not allowed in production")
        return self

    @model_validator(mode="after")
    def _validate_dev_auth_bypass(self) -> "Settings":
        """DEV_AUTH_BYPASS can only be enabled in development environment."""
        if self.dev_auth_bypass and self.environment != "development":
            raise ValueError(
                f"DEV_AUTH_BYPASS can only be enabled in development, not {self.environment}"
            )
        return self

    # -------------------------------------------------------------------------
    # Runtime guards: use these at call sites that require Supabase/test user
    # -------------------------------------------------------------------------

    def has_supabase_env(self) -> bool:
        """Check if Supabase is configured (URL + anon key minimum for client use)."""
        return bool(self.supabase_url and self.supabase_anon_key)

    def require_supabase(self) -> None:
        """Raise if Supabase is not configured. Call only in auth-required paths."""
        if not self.has_supabase_env():
            raise RuntimeError(
                "Supabase is not configured. Missing SUPABASE_URL and/or SUPABASE_ANON_KEY."
            )

    def require_test_user_id(self) -> UUID:
        """Return test_user_id or raise. Call only in dev/test flows."""
        if self.test_user_id is None:
            raise RuntimeError("TEST_USER_ID is not configured.")
        return self.test_user_id


@lru_cache()
def get_settings() -> Settings:
    """Return cached settings instance.

    Uses lru_cache so settings are loaded once and reused.
    Raises ValidationError on startup if env vars are missing/invalid.
    """
    return Settings()
