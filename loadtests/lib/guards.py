"""
Phase 14.2C — Python target guards for seed/cleanup tooling.

Mirrors loadtests/k6/lib/target-guard.js semantics on the Python side:
refuses production-like Supabase URLs and production-issued service keys
before any seed/cleanup operation.

Errors reference env-var NAMES only — URL, key, ref, and role values are
NEVER echoed.

No network calls. Stdlib only.
"""

from __future__ import annotations

import base64
import binascii
import json
import os

PROD_HOST_FRAGMENT = "tastelog-production"

# Env-var NAMES. The values are NEVER logged.
ENV_API_BASE_URL = "LOADTEST_API_BASE_URL"
ENV_SUPABASE_URL = "LOADTEST_SUPABASE_URL"
ENV_SUPABASE_SERVICE_KEY = "LOADTEST_SUPABASE_SERVICE_KEY"
ENV_SUPABASE_ANON_KEY = "LOADTEST_SUPABASE_ANON_KEY"
ENV_PROD_REF_REFUSE_FRAGMENT = "LOADTEST_PROD_REF_REFUSE_FRAGMENT"
ENV_SEED_USER_PASSWORD = "LOADTEST_SEED_USER_PASSWORD"


class TargetGuardError(RuntimeError):
    """Raised when seed/cleanup target fails a guard check."""


def require_env(name: str) -> str:
    """Return env-var value, or raise TargetGuardError referencing NAME only."""
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        raise TargetGuardError(
            f"{name} is required but missing or empty. Refusing to run."
        )
    return value.strip()


def assert_load_target_url(supabase_url: str) -> str:
    """Refuse production-like Supabase URLs. Returns normalized URL on success."""
    if not isinstance(supabase_url, str) or supabase_url.strip() == "":
        raise TargetGuardError(
            f"{ENV_SUPABASE_URL} is required but missing or empty. Refusing to run."
        )
    normalized = supabase_url.strip()
    if PROD_HOST_FRAGMENT in normalized.lower():
        raise TargetGuardError(
            f"{ENV_SUPABASE_URL} points at a production-like host. "
            "Refusing to run against production."
        )
    return normalized


def _b64url_decode(segment: str) -> bytes:
    seg = segment.strip()
    rem = len(seg) % 4
    if rem == 1:
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} has an invalid JWT segment length. Refusing."
        )
    if rem:
        seg += "=" * (4 - rem)
    try:
        return base64.urlsafe_b64decode(seg.encode("ascii"))
    except (binascii.Error, UnicodeEncodeError) as exc:
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} cannot be base64-decoded. Refusing."
        ) from exc


def _decode_service_key_payload(service_key: str) -> dict:
    if not isinstance(service_key, str) or service_key.strip() == "":
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} is required but missing or empty. Refusing."
        )
    parts = service_key.split(".")
    if len(parts) != 3:
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} is not a valid JWT (3 segments expected). Refusing."
        )
    payload_bytes = _b64url_decode(parts[1])
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} payload is not decodable JSON. Refusing."
        ) from exc
    if not isinstance(payload, dict):
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} payload is not a JSON object. Refusing."
        )
    return payload


def assert_load_target_service_key(service_key: str, refuse_fragment: str) -> None:
    """Refuse production-issued service keys.

    1. Must be a valid JWT (3 segments, decodable payload).
    2. Role claim must equal "service_role".
    3. Ref claim must NOT contain refuse_fragment (case-insensitive).

    Errors reference env-var NAMES only. Key, role, and ref values are
    NEVER echoed.
    """
    if not isinstance(refuse_fragment, str) or refuse_fragment.strip() == "":
        raise TargetGuardError(
            f"{ENV_PROD_REF_REFUSE_FRAGMENT} is required but missing or empty. "
            "Refusing to run without an explicit production-ref refusal fragment."
        )

    payload = _decode_service_key_payload(service_key)

    role = payload.get("role")
    if role != "service_role":
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} is not a service_role key. Refusing."
        )

    ref = payload.get("ref")
    if not isinstance(ref, str) or ref.strip() == "":
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} is missing a project ref claim. Refusing."
        )

    if refuse_fragment.strip().lower() in ref.lower():
        raise TargetGuardError(
            f"{ENV_SUPABASE_SERVICE_KEY} project ref matches "
            f"{ENV_PROD_REF_REFUSE_FRAGMENT}. Refusing to run against production."
        )
