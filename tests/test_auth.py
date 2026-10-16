"""
Auth tests - no network, deterministic.

Strategy:
- Generate RSA keypair locally
- Mock httpx.AsyncClient to return fake JWKS
- Test JWT verification logic
"""

import base64
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt

from api.core.jwt import (
    JWTVerificationError,
    get_jwks_client,
    verify_supabase_jwt,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def rsa_keypair():
    """Generate RSA keypair for tests."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    public_key = private_key.public_key()
    return private_key, public_key


@pytest.fixture
def jwks_data(rsa_keypair):
    """Build fake JWKS from keypair."""
    _, public_key = rsa_keypair
    kid = "test-key-id"

    # Export public key numbers for JWK
    pub_numbers = public_key.public_numbers()
    n_bytes = pub_numbers.n.to_bytes((pub_numbers.n.bit_length() + 7) // 8, "big")
    e_bytes = pub_numbers.e.to_bytes((pub_numbers.e.bit_length() + 7) // 8, "big")

    jwks = {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": kid,
                "n": base64.urlsafe_b64encode(n_bytes).rstrip(b"=").decode(),
                "e": base64.urlsafe_b64encode(e_bytes).rstrip(b"=").decode(),
            }
        ]
    }
    return jwks, kid


@pytest.fixture(autouse=True)
def clear_cache():
    """Clear JWKS client cache before each test."""
    get_jwks_client.cache_clear()
    yield
    get_jwks_client.cache_clear()


def make_token(
    private_key,
    kid: str,
    sub: str,
    exp_delta: timedelta = timedelta(hours=1),
    aud: str = "authenticated",
    iss: str = "https://test.supabase.co/auth/v1",
) -> str:
    """Create a signed JWT for testing."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "aud": aud,
        "iss": iss,
        "exp": now + exp_delta,
        "iat": now,
    }
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return jwt.encode(payload, pem, algorithm="RS256", headers={"kid": kid})


def mock_httpx_response(jwks_data: dict):
    """Create a mock httpx response returning JWKS data."""
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = jwks_data
    return mock_response


# =============================================================================
# JWT Verification Tests
# =============================================================================


@pytest.mark.asyncio
async def test_valid_token_returns_user_id(rsa_keypair, jwks_data):
    """Valid token → returns user_id UUID."""
    private_key, _ = rsa_keypair
    jwks, kid = jwks_data
    user_id = uuid4()
    token = make_token(private_key, kid, str(user_id))

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        result = await verify_supabase_jwt(token, "https://test.supabase.co")
        assert result == user_id


@pytest.mark.asyncio
async def test_expired_token_returns_error(rsa_keypair, jwks_data):
    """Expired token → JWTVerificationError."""
    private_key, _ = rsa_keypair
    jwks, kid = jwks_data
    token = make_token(private_key, kid, str(uuid4()), exp_delta=timedelta(hours=-1))

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_wrong_audience_returns_error(rsa_keypair, jwks_data):
    """Wrong aud claim → JWTVerificationError."""
    private_key, _ = rsa_keypair
    jwks, kid = jwks_data
    token = make_token(private_key, kid, str(uuid4()), aud="wrong-audience")

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_wrong_issuer_returns_error(rsa_keypair, jwks_data):
    """Wrong iss claim → JWTVerificationError."""
    private_key, _ = rsa_keypair
    jwks, kid = jwks_data
    token = make_token(private_key, kid, str(uuid4()), iss="https://wrong.issuer.com")

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_invalid_sub_uuid_returns_error(rsa_keypair, jwks_data):
    """sub claim is not valid UUID → JWTVerificationError."""
    private_key, _ = rsa_keypair
    jwks, kid = jwks_data
    token = make_token(private_key, kid, "not-a-uuid")

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_unknown_kid_returns_error_after_retry(rsa_keypair, jwks_data):
    """Unknown kid after forced refresh → JWTVerificationError, fetched twice."""
    private_key, _ = rsa_keypair
    jwks, _ = jwks_data
    token = make_token(private_key, "wrong-kid", str(uuid4()))

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")

        # Verify forced refresh: should have fetched twice (initial + retry)
        assert mock_instance.get.await_count == 2


@pytest.mark.asyncio
async def test_missing_kid_in_header_returns_error(rsa_keypair, jwks_data):
    """JWT missing kid in header → JWTVerificationError."""
    private_key, _ = rsa_keypair
    jwks, _ = jwks_data

    # Create token without kid in header
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(uuid4()),
        "aud": "authenticated",
        "iss": "https://test.supabase.co/auth/v1",
        "exp": now + timedelta(hours=1),
    }
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    token = jwt.encode(payload, pem, algorithm="RS256")  # No kid header

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_non_rs256_algorithm_returns_error(rsa_keypair, jwks_data):
    """JWT with non-RS256 algorithm → JWTVerificationError."""
    jwks, kid = jwks_data

    # Create HS256 token (wrong algorithm)
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(uuid4()),
        "aud": "authenticated",
        "iss": "https://test.supabase.co/auth/v1",
        "exp": now + timedelta(hours=1),
    }
    token = jwt.encode(payload, "secret", algorithm="HS256", headers={"kid": kid})

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.return_value = mock_httpx_response(jwks)
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")


@pytest.mark.asyncio
async def test_jwks_fetch_failure_returns_error(rsa_keypair, jwks_data):
    """JWKS fetch failure → JWTVerificationError."""
    private_key, _ = rsa_keypair
    _, kid = jwks_data
    token = make_token(private_key, kid, str(uuid4()))

    with patch("api.core.jwt.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get.side_effect = Exception("Network error")
        mock_instance.__aenter__.return_value = mock_instance
        mock_instance.__aexit__.return_value = None
        mock_client.return_value = mock_instance

        with pytest.raises(JWTVerificationError):
            await verify_supabase_jwt(token, "https://test.supabase.co")
