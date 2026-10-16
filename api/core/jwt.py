"""
Tastelog: JWT verification using Supabase JWKS (RS256).

- Async JWKS fetch with caching (1 hour TTL)
- Testable: cache keyed by URL

Note: JWKS is fetched lazily on the first authenticated request and cached for
1 hour. Warm-up is intentionally omitted to keep startup resilient; add later
only if cold-start latency becomes an issue.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any
from uuid import UUID

import httpx
from cryptography.hazmat.primitives import serialization
from jose import jwt, JWTError
from jwt import PyJWK

logger = logging.getLogger("tastelog.auth")


class JWTVerificationError(Exception):
    """Raised when JWT verification fails. Details logged server-side only."""
    pass


class JWKSClient:
    """
    Fetches and caches JWKS from Supabase.

    - Async fetch with httpx.AsyncClient
    - Keys cached for 1 hour
    - One forced refresh on unknown kid, then fail
    - Concurrency-safe via asyncio.Lock
    """

    def __init__(
        self,
        supabase_url: str,
        audience: str,
        issuer: str | None = None,
    ):
        self._jwks_url = f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        self._issuer = issuer or f"{supabase_url.rstrip('/')}/auth/v1"
        self._audience = audience
        self._keys: dict[str, dict[str, Any]] = {}  # kid -> JWK dict
        self._pem_cache: dict[str, bytes] = {}  # kid -> PEM bytes
        self._keys_fetched_at: datetime | None = None
        self._cache_duration = timedelta(hours=1)
        self._lock = asyncio.Lock()

    @property
    def issuer(self) -> str:
        return self._issuer

    @property
    def audience(self) -> str:
        return self._audience

    def _should_refresh(self) -> bool:
        if self._keys_fetched_at is None:
            return True
        return datetime.now(timezone.utc) - self._keys_fetched_at > self._cache_duration

    async def _fetch_keys(self, force: bool = False) -> None:
        """
        Fetch JWKS from Supabase. Raises JWTVerificationError on failure.

        Args:
            force: If True, fetch even if cache is fresh (for key rotation).
        """
        async with self._lock:
            # Double-check after acquiring lock to avoid redundant fetches
            if not force and not self._should_refresh():
                return

            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get(self._jwks_url)
                    response.raise_for_status()
                    jwks_data = response.json()

                self._keys = {}
                for key_data in jwks_data.get("keys", []):
                    kid = key_data.get("kid")
                    if kid:
                        self._keys[kid] = key_data

                # Prune PEM cache: remove keys that no longer exist
                self._pem_cache = {k: v for k, v in self._pem_cache.items() if k in self._keys}

                self._keys_fetched_at = datetime.now(timezone.utc)
                logger.debug(f"JWKS refreshed: {len(self._keys)} keys cached")

            except Exception as e:
                logger.error(f"Failed to fetch JWKS from {self._jwks_url}: {e}")
                raise JWTVerificationError("Unable to verify token") from e

    def _jwk_to_pem(self, jwk_dict: dict[str, Any]) -> bytes:
        """Convert JWK dict to PEM bytes for jose verification."""
        try:
            jwk_obj = PyJWK.from_dict(jwk_dict)
            public_key = jwk_obj.key
            return public_key.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        except Exception as e:
            logger.error(f"Failed to convert JWK to PEM: {e}")
            raise JWTVerificationError("Unable to verify token") from e

    async def get_signing_key_pem(self, kid: str) -> bytes:
        """
        Get PEM-encoded public key for a given key ID.

        On unknown kid, performs one forced refresh before failing.
        """
        # Return from cache if fresh and kid exists
        if not self._should_refresh() and kid in self._pem_cache:
            return self._pem_cache[kid]

        # Refresh if stale
        if self._should_refresh():
            await self._fetch_keys(force=False)

        # If kid still missing, force one refresh for key rotation
        if kid not in self._keys:
            await self._fetch_keys(force=True)

        # If still missing after forced refresh, fail
        if kid not in self._keys:
            raise JWTVerificationError("Unknown signing key")

        # Convert to PEM and cache
        if kid not in self._pem_cache:
            self._pem_cache[kid] = self._jwk_to_pem(self._keys[kid])

        return self._pem_cache[kid]


@lru_cache(maxsize=4)
def get_jwks_client(
    supabase_url: str,
    audience: str = "authenticated",
    issuer: str | None = None,
) -> JWKSClient:
    """
    Get or create a JWKSClient for the given Supabase URL.

    Cached by URL - safe for multiple environments in tests.
    """
    return JWKSClient(supabase_url, audience, issuer)


async def verify_supabase_jwt(
    token: str,
    supabase_url: str,
    audience: str = "authenticated",
    issuer: str | None = None,
) -> UUID:
    """
    Verify a Supabase access token and extract user_id.

    Validates:
    - Algorithm is RS256 (rejects all others)
    - Signature (via JWKS)
    - Issuer (iss)
    - Audience (aud)
    - Expiration (exp)
    - Subject exists (sub)

    Returns: user_id as UUID
    Raises: JWTVerificationError on any failure
    """
    client = get_jwks_client(supabase_url, audience, issuer)

    try:
        # Decode header WITHOUT verification to get kid and alg
        unverified_header = jwt.get_unverified_header(token)

        # Only allow RS256 and ES256 (Supabase uses either)
        alg = unverified_header.get("alg")
        if alg not in ("RS256", "ES256"):
            logger.warning(f"JWT has unexpected algorithm: {alg}")
            raise JWTVerificationError("Invalid token")

        kid = unverified_header.get("kid")
        if not kid:
            logger.warning("JWT missing kid in header")
            raise JWTVerificationError("Invalid token")

        # Get PEM-encoded public key
        pem_key = await client.get_signing_key_pem(kid)

        # Verify signature and decode
        payload = jwt.decode(
            token,
            pem_key,
            algorithms=["RS256", "ES256"],  # Supabase uses RS256 or ES256
            audience=client.audience,
            issuer=client.issuer,
            options={
                "require_exp": True,
                "require_sub": True,
            }
        )

        # Extract user_id from sub claim
        sub = payload.get("sub")
        if not sub:
            logger.warning("JWT missing sub claim after decode")
            raise JWTVerificationError("Invalid token")

        return UUID(sub)

    except JWTError as e:
        logger.warning(f"JWT verification failed: {type(e).__name__}")
        raise JWTVerificationError("Invalid token") from e
    except ValueError as e:
        # UUID parsing failed
        logger.warning(f"Invalid sub claim format: {e}")
        raise JWTVerificationError("Invalid token") from e
