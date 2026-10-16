"""
Phase 14.2C — Service-role Supabase client factory for seed/cleanup.

Wraps the supabase Python SDK with hard target guards from
loadtests.lib.guards. Never logs URL, key, or ref values.
"""

from __future__ import annotations

from supabase import Client, create_client

from loadtests.lib.guards import (
    ENV_PROD_REF_REFUSE_FRAGMENT,
    ENV_SUPABASE_ANON_KEY,
    ENV_SUPABASE_SERVICE_KEY,
    ENV_SUPABASE_URL,
    assert_load_target_service_key,
    assert_load_target_url,
    require_env,
)


def get_load_target_admin_client() -> Client:
    """Return a service-role Supabase client for the load-target project.

    Guard order:
      1. All required env vars present (NAME-only errors).
      2. URL passes assert_load_target_url.
      3. Service key passes assert_load_target_service_key.
    """
    url = require_env(ENV_SUPABASE_URL)
    service_key = require_env(ENV_SUPABASE_SERVICE_KEY)
    refuse_fragment = require_env(ENV_PROD_REF_REFUSE_FRAGMENT)

    normalized_url = assert_load_target_url(url)
    assert_load_target_service_key(service_key, refuse_fragment)

    return create_client(normalized_url, service_key)


def get_load_target_anon_client() -> Client:
    """Return an anon-key Supabase client for JWT minting via sign-in."""
    url = require_env(ENV_SUPABASE_URL)
    anon_key = require_env(ENV_SUPABASE_ANON_KEY)
    normalized_url = assert_load_target_url(url)
    return create_client(normalized_url, anon_key)
