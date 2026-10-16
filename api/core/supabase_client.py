"""
Tastelog: Supabase client factory.

IMPORTANT: This is the ONLY sanctioned entry point for Supabase client creation.
No other module may call create_client() directly. All database access must go
through get_supabase_client() to ensure consistent configuration and safety checks.
"""

import base64
import binascii
import json
import os
from functools import lru_cache

from supabase import create_client, Client, ClientOptions

from api.core.config import get_settings


def _b64url_decode(segment: str) -> bytes:
    """Decode a base64url segment to bytes.

    Handles missing padding and validates segment length.
    Raises RuntimeError on invalid input.
    """
    try:
        seg = segment.strip()
        rem = len(seg) % 4
        if rem == 1:
            raise RuntimeError("Invalid base64url segment length")
        if rem:
            seg += "=" * (4 - rem)
        return base64.urlsafe_b64decode(seg.encode("ascii"))
    except (binascii.Error, UnicodeEncodeError) as e:
        raise RuntimeError(f"Invalid base64url encoding: {e}") from e


def _validate_service_role_key(key: str) -> None:
    """Validate that the key is a service role key, not anon.

    Decodes the JWT payload and checks the role claim.
    Raises RuntimeError if the key is malformed or has wrong role.
    """
    # JWT structure: header.payload.signature
    parts = key.split(".")
    if len(parts) != 3:
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY is not a valid JWT (expected 3 dot-separated segments)"
        )

    try:
        payload_bytes = _b64url_decode(parts[1])
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise RuntimeError(f"SUPABASE_SERVICE_KEY has invalid JWT payload: {e}") from e

    if not isinstance(payload, dict):
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY has invalid JWT payload: not a JSON object"
        )

    role = payload.get("role")
    if role is None:
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY JWT payload missing 'role' claim. "
            "This does not appear to be a valid Supabase key."
        )
    if role != "service_role":
        raise RuntimeError(
            f"SUPABASE_SERVICE_KEY has role '{role}', expected 'service_role'. "
            "Server-side operations require the service role key to bypass RLS safely."
        )


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    """Return cached singleton Supabase client.

    Thread-safe and stateless. Request-specific data (user_id)
    stays request-scoped via dependency injection, not stored in client.

    Validates on first call that Supabase is configured and the key is a service role key.
    Raises RuntimeError if misconfigured or Supabase env is missing.
    """
    settings = get_settings()

    # Guard: Supabase must be configured (URL + anon key minimum)
    settings.require_supabase()

    # Guard: Service key must be present (separate from URL/anon check)
    if not settings.supabase_service_key:
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY is not configured. "
            "Server-side operations require the service role key."
        )

    # Fail fast if wrong key type
    _validate_service_role_key(settings.supabase_service_key)

    return create_client(str(settings.supabase_url), settings.supabase_service_key)


def get_migration_guard_client(*, timeout_seconds: int) -> Client:
    """Dedicated service-role client for the migration drift guard (15.2.4-CF-MD1).

    Deliberately bypasses get_settings(): the guard must run with ONLY
    SUPABASE_URL + SUPABASE_SERVICE_KEY (Settings would additionally require
    ANTHROPIC_API_KEY, which the drift-check CLI must not need). Lives in this
    module so create_client() keeps a single sanctioned home.

    Not cached: each check constructs a fresh client so env changes and the
    short per-call timeout stay isolated from the shared singleton.
    Raises RuntimeError when config is absent or the key is not service-role.
    """
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY are required for the migration guard."
        )
    _validate_service_role_key(key)
    return create_client(
        url, key, options=ClientOptions(postgrest_client_timeout=timeout_seconds)
    )


def get_user_supabase_client(user_jwt: str) -> Client:
    """Create a user-scoped Supabase client using anon key + user JWT (RLS enforced).

    Raises RuntimeError if Supabase is not configured.
    """
    settings = get_settings()
    settings.require_supabase()
    if not settings.supabase_anon_key:
        raise RuntimeError("SUPABASE_ANON_KEY is not configured.")
    return create_client(
        str(settings.supabase_url),
        settings.supabase_anon_key,
        options=ClientOptions(headers={"Authorization": f"Bearer {user_jwt}"}),
    )
