"""
Tastelog: FastAPI dependencies.

Dependency injection for request-scoped values.
"""

import logging
from uuid import UUID

from fastapi import Depends, Header, HTTPException
from supabase import Client

from api.core.config import get_settings
from api.core.jwt import verify_supabase_jwt, JWTVerificationError
from api.core.supabase_client import get_supabase_client
from api.core.supabase_user_client import get_user_supabase_client
from api.core.token_auth import (
    InvalidTokenError,
    TOKEN_PREFIX,
    verify_capture_token,
)

logger = logging.getLogger("tastelog.auth")


def _require_supabase_or_503() -> None:
    settings = get_settings()
    try:
        settings.require_supabase()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


def get_db() -> Client:
    _require_supabase_or_503()
    try:
        return get_supabase_client()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


def get_bearer_token(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> str:
    """Extract and validate Bearer token from Authorization header."""
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization must be Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Empty Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


async def get_current_user_id(
    token: str = Depends(get_bearer_token),
) -> UUID:
    settings = get_settings()

    if settings.dev_auth_bypass and settings.environment == "development":
        logger.debug("Auth bypass active - using TEST_USER_ID")
        return settings.require_test_user_id()

    _require_supabase_or_503()

    try:
        user_id = await verify_supabase_jwt(
            token,
            str(settings.supabase_url),
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_jwt_issuer,
        )
        return user_id
    except JWTVerificationError as e:
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e


def get_user_db(token: str = Depends(get_bearer_token)) -> Client:
    """Return user-scoped Supabase client for RLS-enforced operations."""
    _require_supabase_or_503()
    try:
        return get_user_supabase_client(token)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


async def get_user_id_jwt_or_capture_token(
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Client = Depends(get_db),
) -> UUID:
    """Extract user ID from either Supabase JWT or capture token.

    Determines auth mode from token prefix.
    Tokens starting with tl_cap_ are treated as capture tokens.
    All other tokens are verified as Supabase JWTs.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization[7:].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Empty Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Explicit branch: capture token if prefix matches, JWT otherwise
    if token.startswith(TOKEN_PREFIX):
        try:
            token_record = verify_capture_token(token, supabase=db)
            return token_record.user_id
        except InvalidTokenError as e:
            raise HTTPException(
                status_code=401,
                detail=str(e),
                headers={"WWW-Authenticate": "Bearer"},
            ) from e

    # JWT path
    settings = get_settings()

    if settings.dev_auth_bypass and settings.environment == "development":
        logger.debug("Auth bypass active - using TEST_USER_ID")
        return settings.require_test_user_id()

    _require_supabase_or_503()

    try:
        user_id = await verify_supabase_jwt(
            token,
            str(settings.supabase_url),
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_jwt_issuer,
        )
        return user_id
    except JWTVerificationError as e:
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e


async def get_user_supabase(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> Client:
    """Legacy wrapper - prefer get_user_db for new code."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization[7:]
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        return get_user_supabase_client(token)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
