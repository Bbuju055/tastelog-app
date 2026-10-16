"""Shared test fixtures for API tests."""

from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from api.dependencies import get_current_user_id

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")


@pytest.fixture()
def app():
    """Create app instance (no auth overrides)."""
    return create_app()


@pytest.fixture()
def client(app):
    """Unauthenticated test client."""
    return TestClient(app)


@pytest.fixture()
def authed_client(app):
    """Test client with auth bypassed via dependency override (tests only)."""

    def _fake_user_id():
        return FAKE_USER_ID

    app.dependency_overrides[get_current_user_id] = _fake_user_id
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)


@pytest.fixture()
def validation_client(app):
    """Client that bypasses auth dependencies so validation (422) can be tested deterministically."""

    def _fake_user_id():
        return FAKE_USER_ID

    def _fake_user_supabase():
        # Should never be used for invalid UUID requests; returning a sentinel object is enough.
        return object()

    from api.dependencies import get_user_supabase

    app.dependency_overrides[get_current_user_id] = _fake_user_id
    app.dependency_overrides[get_user_supabase] = _fake_user_supabase
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)
        app.dependency_overrides.pop(get_user_supabase, None)
