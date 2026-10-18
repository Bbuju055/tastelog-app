"""
Draft route tests - no network, deterministic.

Scope:
- Validate request validation (UUID parsing)
- Validate auth required behavior (when bypass is off)
- Validate file type rejection (with mocked auth)
- Validate multi-image count/size limits

Fixtures (client, authed_client, capture_client) are provided by conftest.py.
These tests DO NOT hit Supabase or Anthropic.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock
from uuid import UUID

import pytest

from api.core.drafts import get_active_draft
from api.core.exceptions import DraftExpiredError, DraftNotFoundError, StorageError
from api.dependencies import get_user_id_jwt_or_capture_token

FAKE_USER_ID = UUID("00000000-0000-0000-0000-000000000001")
FAKE_DRAFT_ID = UUID("00000000-0000-0000-0000-000000000abc")


@pytest.fixture()
def capture_client(app, monkeypatch):
    """Test client with capture auth bypassed and no database.

    The capture endpoint uses get_user_id_jwt_or_capture_token (not
    get_current_user_id), so this fixture overrides the correct dependency.
    The db is a stub, the rate limiter passes, and storage upload fails with
    a StorageError, so a request that clears validation ends in exactly 500.
    """
    import api.routes.drafts as drafts_module
    from api.core.exceptions import StorageError
    from api.dependencies import get_db

    def _fake_user_id():
        return FAKE_USER_ID

    upload_calls: list[dict] = []

    def _upload_fails(*a, **k):
        upload_calls.append(k)
        raise StorageError("no storage in tests", code="UPLOAD_FAILED")

    monkeypatch.setattr(drafts_module, "check_and_record_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(drafts_module, "upload_image", _upload_fails)
    app.dependency_overrides[get_user_id_jwt_or_capture_token] = _fake_user_id
    app.dependency_overrides[get_db] = lambda: object()
    try:
        from fastapi.testclient import TestClient

        with TestClient(app) as c:
            c.upload_calls = upload_calls
            yield c
    finally:
        app.dependency_overrides.pop(get_user_id_jwt_or_capture_token, None)
        app.dependency_overrides.pop(get_db, None)


# =============================================================================
# Validation Tests (authed — auth must pass to reach path validator)
# =============================================================================


def test_get_draft_invalid_uuid_returns_422(authed_client):
    resp = authed_client.get("/api/drafts/not-a-uuid")
    assert resp.status_code == 422


def test_confirm_draft_invalid_uuid_returns_422(validation_client):
    resp = validation_client.post("/api/drafts/not-a-uuid/confirm")
    assert resp.status_code == 422


def test_delete_draft_invalid_uuid_returns_422(authed_client):
    resp = authed_client.delete("/api/drafts/not-a-uuid")
    assert resp.status_code == 422


# =============================================================================
# Auth Tests (expects bypass OFF — uses unauthenticated client)
# =============================================================================


def test_capture_requires_auth(client):
    # Send minimal file; auth should be checked before heavy work
    resp = client.post(
        "/api/drafts/capture",
        files={"image": ("test.jpg", b"fake", "image/jpeg")},
    )
    assert resp.status_code == 401
    assert resp.headers.get("WWW-Authenticate") == "Bearer"


def test_get_draft_requires_auth(client):
    resp = client.get("/api/drafts/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 401
    assert resp.headers.get("WWW-Authenticate") == "Bearer"


def test_confirm_draft_requires_auth(client):
    resp = client.post("/api/drafts/00000000-0000-0000-0000-000000000000/confirm")
    assert resp.status_code == 401
    assert resp.headers.get("WWW-Authenticate") == "Bearer"


def test_delete_draft_requires_auth(client):
    resp = client.delete("/api/drafts/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 401
    assert resp.headers.get("WWW-Authenticate") == "Bearer"


# =============================================================================
# File Validation Tests (capture_client — overrides correct auth dep)
# =============================================================================


def test_capture_invalid_content_type_returns_400(capture_client):
    resp = capture_client.post(
        "/api/drafts/capture",
        files={"image": ("test.txt", b"not an image", "text/plain")},
    )
    assert resp.status_code == 400
    assert "Invalid file type" in resp.json()["detail"]


def test_capture_too_many_images_returns_400(capture_client):
    """More than 5 images should be rejected before any processing."""
    files = [
        ("image", (f"img{i}.jpg", b"fake jpeg bytes", "image/jpeg"))
        for i in range(6)
    ]
    resp = capture_client.post("/api/drafts/capture", files=files)
    assert resp.status_code == 400
    assert "Maximum" in resp.json()["detail"]


def test_capture_zero_images_returns_400(capture_client):
    """Empty request with no images and no URL should fail."""
    resp = capture_client.post("/api/drafts/capture")
    assert resp.status_code == 400  # Our handler rejects: "Provide image(s) or a URL"


def test_capture_mixed_valid_invalid_types_returns_400(capture_client):
    """One valid + one invalid content type should reject."""
    files = [
        ("image", ("good.jpg", b"fake", "image/jpeg")),
        ("image", ("bad.txt", b"fake", "text/plain")),
    ]
    resp = capture_client.post("/api/drafts/capture", files=files)
    assert resp.status_code == 400
    assert "Invalid file type" in resp.json()["detail"]


def test_capture_single_image_passes_validation(capture_client):
    """Single image should pass type/count validation (fails at the stubbed storage upload)."""
    files = [("image", ("test.jpg", b"fake jpeg bytes", "image/jpeg"))]
    resp = capture_client.post("/api/drafts/capture", files=files)
    # Validation passed — the 500 is our stubbed storage failure, not an accident
    assert resp.status_code == 500
    assert len(capture_client.upload_calls) == 1


def test_capture_three_images_passes_validation(capture_client):
    """Multiple images within limit should pass type/count validation."""
    files = [
        ("image", (f"img{i}.jpg", b"fake jpeg bytes", "image/jpeg"))
        for i in range(3)
    ]
    resp = capture_client.post("/api/drafts/capture", files=files)
    assert resp.status_code == 500
    assert len(capture_client.upload_calls) == 1  # the first upload fails and the request stops


def test_capture_five_images_passes_validation(capture_client):
    """Exactly 5 images (max limit) should pass validation."""
    files = [
        ("image", (f"img{i}.jpg", b"fake jpeg bytes", "image/jpeg"))
        for i in range(5)
    ]
    resp = capture_client.post("/api/drafts/capture", files=files)
    assert resp.status_code == 500
    assert len(capture_client.upload_calls) == 1


def test_capture_malformed_url_returns_400(capture_client):
    resp = capture_client.post("/api/drafts/capture", data={"url": "http://[::1"})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid URL"


def test_capture_file_too_large_returns_413(capture_client):
    """A single file exceeding 10 MB should be rejected."""
    big = b"x" * (11 * 1024 * 1024)
    files = [("image", ("big.jpg", big, "image/jpeg"))]
    resp = capture_client.post("/api/drafts/capture", files=files)
    assert resp.status_code == 413
    assert "10 MB" in resp.json()["detail"]


# =============================================================================
# get_active_draft helper-unit tests (Phase 13.9 Slice B)
# =============================================================================
#
# Helper-level only — no FastAPI client. Route-level wiring of
# get_active_draft into the draft-anchored Riff sync/stream endpoints is a
# Slice D / E deliverable; these tests assert the helper's contract in
# isolation.


def _make_active_draft_dict(expires_at: str | None = None, **overrides) -> dict:
    """Build a recipe_drafts row dict for helper tests.

    Default expires_at is 1 day in the future (active). Overrides allow
    pinning to a specific timestamp for boundary / expiry tests.
    """
    if expires_at is None:
        expires_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    row = {
        "id": str(FAKE_DRAFT_ID),
        "user_id": str(FAKE_USER_ID),
        "title": "Test Recipe",
        "image_storage_keys": [],
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "30 min",
        "confidence_score": 0.95,
        "ingredients": [],
        "steps": [],
        "raw_model_json": {},
        "source_url": None,
        "model_version": "test",
        "parser_version": "test",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at,
    }
    row.update(overrides)
    return row


def _mock_db_returning_draft(draft: dict) -> MagicMock:
    """Mock supabase whose recipe_drafts SELECT chain returns the given draft."""
    db = MagicMock()
    chain = (
        db.table.return_value
        .select.return_value
        .eq.return_value
        .eq.return_value
        .single.return_value
        .execute.return_value
    )
    chain.data = draft
    return db


def _mock_db_raising_not_found() -> MagicMock:
    """Mock supabase whose .execute() raises a PGRST116 0-rows error."""
    db = MagicMock()
    (
        db.table.return_value
        .select.return_value
        .eq.return_value
        .eq.return_value
        .single.return_value
        .execute
    ).side_effect = Exception("PGRST116: 0 rows returned")
    return db


def test_get_active_draft_returns_owned_active_draft():
    """Happy path: active, owned draft round-trips back as a dict and the
    recipe_drafts table is queried with the id filter in the chain."""
    draft = _make_active_draft_dict()
    db = _mock_db_returning_draft(draft)

    result = get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    assert result == draft
    db.table.assert_called_with("recipe_drafts")
    eq1 = db.table.return_value.select.return_value.eq
    eq1.assert_any_call("id", str(FAKE_DRAFT_ID))


def test_get_active_draft_raises_not_found_for_missing_id():
    """Missing draft surfaces as DraftNotFoundError via get_draft's
    PGRST116 mapping. Code carried for client-side branching."""
    db = _mock_db_raising_not_found()

    with pytest.raises(DraftNotFoundError) as exc_info:
        get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    assert exc_info.value.code == "DRAFT_NOT_FOUND"


def test_get_active_draft_raises_not_found_for_cross_user():
    """Cross-user drafts are invisible: .eq('user_id', ...) in get_draft's
    chain excludes them, .single() raises PGRST116, mapped to
    DraftNotFoundError. Locks in the user_id filter is in the chain so
    service-role queries stay scoped to the caller.
    """
    db = _mock_db_raising_not_found()

    with pytest.raises(DraftNotFoundError):
        get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    eq1 = db.table.return_value.select.return_value.eq
    eq1.assert_any_call("id", str(FAKE_DRAFT_ID))
    eq2 = eq1.return_value.eq
    eq2.assert_any_call("user_id", str(FAKE_USER_ID))


def test_get_active_draft_raises_expired_for_past_expiry():
    """expires_at strictly in the past must raise DraftExpiredError with
    code='DRAFT_EXPIRED' so the route layer (Slice D) can translate to 404
    + identifiable client error code per contract §3.4."""
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    draft = _make_active_draft_dict(expires_at=past)
    db = _mock_db_returning_draft(draft)

    with pytest.raises(DraftExpiredError) as exc_info:
        get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    assert exc_info.value.code == "DRAFT_EXPIRED"


def test_get_active_draft_equality_boundary_rejects(monkeypatch):
    """expires_at exactly equal to NOW() must reject (<=, per contract §3.4
    which requires active drafts to satisfy expires_at > NOW()).

    Freezes datetime inside api.core.drafts so the equality boundary can be
    asserted deterministically. The frozen value is also used as expires_at
    in the mocked draft row, making the comparison exactly equal.
    """
    fixed = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed

    import api.core.drafts as drafts_module
    monkeypatch.setattr(drafts_module, "datetime", _FrozenDateTime)

    draft = _make_active_draft_dict(expires_at=fixed.isoformat())
    db = _mock_db_returning_draft(draft)

    with pytest.raises(DraftExpiredError) as exc_info:
        get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    assert exc_info.value.code == "DRAFT_EXPIRED"


def test_get_active_draft_tz_aware_comparison_does_not_raise_typeerror():
    """A PostgREST-style ISO 8601 string with +00:00 offset must compare
    cleanly against datetime.now(timezone.utc) — never produce a
    "can't compare offset-naive and offset-aware datetimes" TypeError.

    Future-dated draft → helper returns the row; absence of TypeError IS
    the assertion.
    """
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    draft = _make_active_draft_dict(expires_at=future)
    db = _mock_db_returning_draft(draft)

    result = get_active_draft(FAKE_DRAFT_ID, user_id=FAKE_USER_ID, supabase=db)

    assert result["expires_at"] == future


# =============================================================================
# PROVIDER-S1 — stable capture error contract (photo + URL routes)
# =============================================================================

import pytest as _pytest_ps1

from api.core.anthropic_client import (
    PROVIDER_BAD_RESPONSE as _PS1_BAD_RESPONSE,
    PROVIDER_RATE_LIMITED as _PS1_RATE_LIMITED,
    PROVIDER_TIMEOUT as _PS1_TIMEOUT,
    PROVIDER_UNAVAILABLE as _PS1_UNAVAILABLE,
)
from api.core.exceptions import (
    ImageProcessingError as _PS1_ImageProcessingError,
    ParsingError as _PS1_ParsingError,
    ProviderError as _PS1_ProviderError,
)
from api.dependencies import get_current_user_id as _ps1_get_current_user_id
from api.dependencies import get_db as _ps1_get_db


class _PS1FakeBucket:
    def __init__(self):
        self.removed = []

    def remove(self, keys):
        self.removed.append(keys)


class _PS1FakeStorage:
    def __init__(self):
        self.bucket = _PS1FakeBucket()

    def from_(self, name):
        return self.bucket


class _PS1FakeDb:
    def __init__(self):
        self.storage = _PS1FakeStorage()


@_pytest_ps1.fixture
def provider_contract_client(app, monkeypatch):
    """Capture-auth + fake-db client for PROVIDER-S1 contract tests."""
    import api.routes.drafts as drafts_module
    from api.dependencies import get_user_id_jwt_or_capture_token

    def _fake_user_id():
        return "00000000-0000-0000-0000-000000000001"

    # The fake db has no tables; the rate limiter is exercised in its own tests.
    monkeypatch.setattr(drafts_module, "check_and_record_rate_limit", lambda *a, **k: None)
    fake_db = _PS1FakeDb()
    app.dependency_overrides[get_user_id_jwt_or_capture_token] = _fake_user_id
    app.dependency_overrides[_ps1_get_current_user_id] = _fake_user_id
    app.dependency_overrides[_ps1_get_db] = lambda: fake_db
    from fastapi.testclient import TestClient

    with TestClient(app, raise_server_exceptions=False) as c:
        c.fake_db = fake_db
        yield c
    app.dependency_overrides.pop(get_user_id_jwt_or_capture_token, None)
    app.dependency_overrides.pop(_ps1_get_current_user_id, None)
    app.dependency_overrides.pop(_ps1_get_db, None)


def _ps1_post_images(client, count=1):
    files = [
        ("image", (f"img{i}.jpg", b"fake jpeg bytes", "image/jpeg"))
        for i in range(count)
    ]
    return client.post("/api/drafts/capture", files=files)


def _ps1_patch_photo_pipeline(monkeypatch, parse_effect):
    import api.routes.drafts as drafts_module

    monkeypatch.setattr(
        drafts_module, "upload_image", lambda *a, **k: "user/fake-key.jpg"
    )

    def _parse(*a, **k):
        if isinstance(parse_effect, Exception):
            raise parse_effect
        return parse_effect

    monkeypatch.setattr(drafts_module, "parse_recipe_images", _parse)


class TestPhotoCaptureErrorContract:
    def test_provider_unavailable_maps_503(self, provider_contract_client, monkeypatch):
        _ps1_patch_photo_pipeline(
            monkeypatch, _PS1_ProviderError("x", code=_PS1_UNAVAILABLE, provider_status=404)
        )
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 503
        assert resp.json()["detail"] == {
            "code": "RECIPE_PROVIDER_UNAVAILABLE",
            "message": "Recipe capture is currently unavailable.",
        }

    def test_provider_rate_limit_maps_503_never_429(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_photo_pipeline(
            monkeypatch, _PS1_ProviderError("x", code=_PS1_RATE_LIMITED, provider_status=429)
        )
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 503
        assert resp.status_code != 429
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_RATE_LIMITED"

    def test_provider_timeout_maps_504(self, provider_contract_client, monkeypatch):
        _ps1_patch_photo_pipeline(monkeypatch, _PS1_ProviderError("x", code=_PS1_TIMEOUT))
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 504
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_TIMEOUT"

    def test_provider_bad_response_maps_502(self, provider_contract_client, monkeypatch):
        _ps1_patch_photo_pipeline(
            monkeypatch, _PS1_ProviderError("x", code=_PS1_BAD_RESPONSE)
        )
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 502
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_BAD_RESPONSE"

    def test_unreadable_image_maps_422(self, provider_contract_client, monkeypatch):
        _ps1_patch_photo_pipeline(
            monkeypatch, _PS1_ImageProcessingError("bad image", code="DECODE_FAILED")
        )
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["code"] == "RECIPE_UNREADABLE"
        # 15.3.S-CF1a: the message is what keeps image-vs-URL unreadable
        # outcomes distinguishable on the wire under the single code.
        assert detail["message"] == "We couldn’t read a recipe from this image."

    def test_unexpected_defect_maps_500_generic(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_photo_pipeline(monkeypatch, ValueError("internal defect"))
        resp = _ps1_post_images(provider_contract_client)
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Internal server error"

    def test_multi_image_maps_identically(self, provider_contract_client, monkeypatch):
        _ps1_patch_photo_pipeline(
            monkeypatch, _PS1_ProviderError("x", code=_PS1_UNAVAILABLE, provider_status=404)
        )
        single = _ps1_post_images(provider_contract_client, count=1)
        multi = _ps1_post_images(provider_contract_client, count=3)
        assert single.status_code == multi.status_code == 503
        assert single.json() == multi.json()

    def test_provider_failure_cleans_up_storage(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_photo_pipeline(monkeypatch, _PS1_ProviderError("x", code=_PS1_UNAVAILABLE))
        _ps1_post_images(provider_contract_client)
        assert provider_contract_client.fake_db.storage.bucket.removed == [
            ["user/fake-key.jpg"]
        ]


def _ps1_fake_draft_row():
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "user_id": "00000000-0000-0000-0000-000000000001",
        "title": "Stub URL Recipe",
        "servings": "4",
        "prep_time": None,
        "cook_time": None,
        "confidence_score": 0.95,
        "ingredients": [
            {"quantity": "2", "unit": "cups", "name": "flour", "prep": None, "raw_text": "2 cups flour"}
        ],
        "steps": [{"position": 1, "instruction": "Mix."}],
        "image_storage_keys": [],
        "source_url": "https://example.com/recipe",
        "raw_model_json": None,
        "model_version": "test",
        "parser_version": "1.0",
        "created_at": "2026-07-11T12:00:00+00:00",
        "updated_at": "2026-07-11T12:00:00+00:00",
        "expires_at": "2026-07-18T12:00:00+00:00",
    }


def _ps1_patch_url_pipeline(monkeypatch, extract_effect, *, existing=None):
    import api.routes.drafts as drafts_module

    calls = {"create_draft": 0}
    monkeypatch.setattr(
        drafts_module, "find_existing_by_url", lambda *a, **k: existing
    )

    def _extract(*a, **k):
        if isinstance(extract_effect, Exception):
            raise extract_effect
        return extract_effect

    monkeypatch.setattr(drafts_module, "extract_recipe_from_url", _extract)

    calls["create_draft_ids"] = []

    def _create_draft(*a, **k):
        calls["create_draft"] += 1
        calls["create_draft_ids"].append(k.get("draft_id"))
        return _ps1_fake_draft_row()

    monkeypatch.setattr(drafts_module, "create_draft", _create_draft)
    return calls


class TestUrlCaptureErrorContract:
    _URL = {"url": "https://example.com/recipe"}

    def test_success_creates_structured_draft(self, provider_contract_client, monkeypatch):
        parsed = {
            "title": "Stub URL Recipe",
            "ingredients": _ps1_fake_draft_row()["ingredients"],
            "steps": [{"position": 1, "instruction": "Mix."}],
            "servings": "4",
            "prep_time": None,
            "cook_time": None,
            "confidence": 0.95,
        }
        calls = _ps1_patch_url_pipeline(monkeypatch, parsed)
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 200
        body = resp.json()
        assert body["ingredients"][0]["quantity"] == "2"
        assert calls["create_draft"] == 1

    @_pytest_ps1.mark.parametrize(
        "code,status,wire",
        [
            (_PS1_UNAVAILABLE, 503, "RECIPE_PROVIDER_UNAVAILABLE"),
            (_PS1_RATE_LIMITED, 503, "RECIPE_PROVIDER_RATE_LIMITED"),
            (_PS1_TIMEOUT, 504, "RECIPE_PROVIDER_TIMEOUT"),
            (_PS1_BAD_RESPONSE, 502, "RECIPE_PROVIDER_BAD_RESPONSE"),
        ],
    )
    def test_provider_failure_maps_and_creates_no_draft(
        self, provider_contract_client, monkeypatch, code, status, wire
    ):
        calls = _ps1_patch_url_pipeline(
            monkeypatch, _PS1_ProviderError("x", code=code)
        )
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == status
        assert resp.json()["detail"]["code"] == wire
        assert calls["create_draft"] == 0

    def test_no_content_page_maps_unreadable_422(
        self, provider_contract_client, monkeypatch
    ):
        calls = _ps1_patch_url_pipeline(
            monkeypatch, _PS1_ParsingError("No recipe content found on page", code="NO_CONTENT")
        )
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["code"] == "RECIPE_UNREADABLE"
        # 15.3.S-CF1a: URL-variant message, distinguishable from the image copy.
        assert detail["message"] == "We couldn’t find a recipe on this page."
        assert calls["create_draft"] == 0

    def test_duplicate_url_contract_unchanged(
        self, provider_contract_client, monkeypatch
    ):
        calls = _ps1_patch_url_pipeline(
            monkeypatch,
            _ps1_fake_draft_row(),
            existing={"type": "recipe", "id": "r-1", "title": "Existing"},
        )
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["recipe_id"] == "r-1"
        assert detail["title"] == "Existing"
        assert calls["create_draft"] == 0

    @_pytest_ps1.mark.parametrize(
        "code,status",
        [
            ("BLOCKED_ADDRESS", 400),  # SSRF guard: the client's URL is refused
            ("INVALID_URL", 400),
            ("TIMEOUT", 502),  # the upstream site failed
            ("NON_HTML", 502),
        ],
    )
    def test_url_fetch_failure_maps_and_creates_no_draft(
        self, provider_contract_client, monkeypatch, code, status
    ):
        from api.core.exceptions import URLFetchError

        calls = _ps1_patch_url_pipeline(monkeypatch, URLFetchError("x", code=code))
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == status
        assert calls["create_draft"] == 0


# =============================================================================
# Rate limit on both draft capture routes (per user, shared sliding window)
# =============================================================================

from api.core.token_auth import (
    RateLimitExceededError as _RL_Exceeded,
    RateLimitUnavailableError as _RL_Unavailable,
)

_RL_USER_KEY = "user:00000000-0000-0000-0000-000000000001"


def _patch_rate_limit(monkeypatch, effect=None):
    """Replace the limiter; returns the list of keys it was called with."""
    import api.routes.drafts as drafts_module

    keys: list[str] = []

    def _limiter(key, **kwargs):
        keys.append(key)
        if effect is not None:
            raise effect

    monkeypatch.setattr(drafts_module, "check_and_record_rate_limit", _limiter)
    return keys


class TestDraftCaptureRateLimit:
    _URL = {"url": "https://example.com/recipe"}

    def test_url_route_exceeded_maps_429_and_creates_no_draft(
        self, provider_contract_client, monkeypatch
    ):
        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_fake_draft_row())
        keys = _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 429
        assert keys == [_RL_USER_KEY]
        assert calls["create_draft"] == 0

    def test_url_route_unavailable_maps_503(self, provider_contract_client, monkeypatch):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_fake_draft_row())
        _patch_rate_limit(monkeypatch, _RL_Unavailable("down", code="RATE_LIMIT_UNAVAILABLE"))
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 503

    def test_url_only_form_capture_is_limited_once(self, provider_contract_client, monkeypatch):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_fake_draft_row())
        keys = _patch_rate_limit(monkeypatch)
        resp = provider_contract_client.post("/api/drafts/capture", data=self._URL)
        assert resp.status_code == 200
        assert keys == [_RL_USER_KEY]

    def test_photo_route_exceeded_maps_429_before_upload(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module

        uploads: list[str] = []
        monkeypatch.setattr(
            drafts_module, "upload_image", lambda *a, **k: uploads.append("x") or "k"
        )
        keys = _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        resp = _ps1_post_images(provider_contract_client, count=2)
        assert resp.status_code == 429
        assert keys == [_RL_USER_KEY]
        assert uploads == []

    def test_photo_route_validation_runs_before_rate_limit(
        self, provider_contract_client, monkeypatch
    ):
        keys = _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("bad.txt", b"x", "text/plain"))],
        )
        assert resp.status_code == 400
        assert keys == []

    def test_photo_route_rate_limit_runs_before_file_bytes_are_read(
        self, provider_contract_client, monkeypatch
    ):
        _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        big = b"x" * (11 * 1024 * 1024)
        resp = provider_contract_client.post(
            "/api/drafts/capture", files=[("image", ("big.jpg", big, "image/jpeg"))]
        )
        assert resp.status_code == 429  # not 413: an over-limit client gets no byte copying

    def test_both_routes_share_one_window_per_user(self, provider_contract_client, monkeypatch):
        import api.routes.drafts as drafts_module

        _ps1_patch_url_pipeline(monkeypatch, _ps1_fake_draft_row())
        monkeypatch.setattr(drafts_module, "upload_image", lambda *a, **k: "k")
        keys = _patch_rate_limit(monkeypatch)
        provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        _ps1_post_images(provider_contract_client)
        assert keys == [_RL_USER_KEY, _RL_USER_KEY]


# =============================================================================
# Issue 1: confirm-time mapping flow (route wiring)
# =============================================================================


_CONFIRM_URL = f"/api/drafts/{FAKE_DRAFT_ID}/confirm"

_FAKE_RECIPE_ID = "00000000-0000-0000-0000-000000000def"

_DRAFT_ROW = {
    "id": str(FAKE_DRAFT_ID),
    "steps": [
        {"position": 1, "instruction": "Preheat"},
        {"position": 2, "instruction": "Mix flour and salt"},
    ],
    "ingredients": [
        {
            "quantity": "2",
            "unit": "cups",
            "name": "flour",
            "prep": None,
            "raw_text": "2 cups flour",
        },
        {
            "quantity": None,
            "unit": None,
            "name": "salt",
            "prep": None,
            "raw_text": "salt to taste",
        },
    ],
    "raw_model_json": {
        "title": "T",
        "step_ingredient_positions": [[], [1, 2]],
    },
}


@pytest.fixture()
def confirm_client(app, authed_client):
    """authed_client plus get_user_supabase/get_db overrides for confirm."""
    from api.dependencies import get_db, get_user_supabase

    app.dependency_overrides[get_user_supabase] = lambda: MagicMock()
    app.dependency_overrides[get_db] = lambda: MagicMock()
    try:
        yield authed_client
    finally:
        app.dependency_overrides.pop(get_user_supabase, None)
        app.dependency_overrides.pop(get_db, None)


class TestConfirmMappingFlow:
    def _post(self, client, body=None, *, draft_row=None, mappings_spy=None):
        from unittest.mock import patch

        draft_row = draft_row if draft_row is not None else _DRAFT_ROW
        recipe_detail = {
            "id": _FAKE_RECIPE_ID,
            "user_id": str(FAKE_USER_ID),
            "title": "T",
            "image_path": None,
            "source_url": None,
            "servings": None,
            "prep_time": None,
            "cook_time": None,
            "confidence_score": None,
            "favorite": False,
            "tags": [],
            "ingredients": [],
            "steps": [],
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "content_rev": 1,
        }
        with patch(
            "api.routes.drafts.get_draft", return_value=draft_row
        ), patch(
            "api.routes.drafts.confirm_draft",
            return_value={"recipe_id": _FAKE_RECIPE_ID},
        ) as confirm_spy, patch(
            "api.routes.drafts.apply_step_mapping", return_value="complete"
        ) as apply_spy, patch(
            "api.routes.drafts.get_recipe",
            return_value=recipe_detail,
        ):
            resp = client.post(
                _CONFIRM_URL, json=body if body is not None else {}
            )
        return resp, confirm_spy, apply_spy

    def test_unedited_confirm_attaches_full_mapping(self, confirm_client):
        resp, _, apply_spy = self._post(confirm_client)
        assert resp.status_code == 200
        apply_spy.assert_called_once()
        args = apply_spy.call_args
        assert args.args[0] == _FAKE_RECIPE_ID
        assert args.args[1] == [[], [1, 2]]
        # Issue 3: creation producers attach against content_rev DEFAULT 1.
        assert args.kwargs["expected_content_rev"] == 1

    def test_title_only_edit_keeps_mapping(self, confirm_client):
        resp, confirm_spy, apply_spy = self._post(
            confirm_client, {"title": "New Title"}
        )
        assert resp.status_code == 200
        assert confirm_spy.call_args.kwargs["title"] == "New Title"
        assert apply_spy.call_args.args[1] == [[], [1, 2]]

    def test_step_edit_invalidates_that_step(self, confirm_client):
        body = {
            "steps": [
                {"position": 1, "instruction": "Preheat"},
                {"position": 2, "instruction": "Whisk it all"},
            ]
        }
        resp, _, apply_spy = self._post(confirm_client, body)
        assert resp.status_code == 200
        assert apply_spy.call_args.args[1] == [[], None]

    def test_raw_text_edit_is_normalized_and_invalidates(self, confirm_client):
        body = {
            "ingredients": [
                {
                    "quantity": "2",
                    "unit": "cups",
                    "name": "flour",
                    "prep": None,
                    "raw_text": "3 tbsp butter",
                },
                {
                    "quantity": None,
                    "unit": None,
                    "name": "salt",
                    "prep": None,
                    "raw_text": "salt to taste",
                },
            ]
        }
        resp, confirm_spy, apply_spy = self._post(confirm_client, body)
        assert resp.status_code == 200
        # Truthful normalization forwarded to the RPC: no stale quantity.
        sent = confirm_spy.call_args.kwargs["ingredients"]
        assert sent[0] == {
            "quantity": None,
            "unit": None,
            "name": "3 tbsp butter",
            "prep": None,
            "raw_text": "3 tbsp butter",
        }
        # Step 2 referenced ingredient 1 -> unknown; step 1 was [] -> kept.
        assert apply_spy.call_args.args[1] == [[], None]

    def test_legacy_draft_skips_attach(self, confirm_client):
        legacy = dict(_DRAFT_ROW)
        legacy["raw_model_json"] = {"title": "T"}
        resp, _, apply_spy = self._post(confirm_client, draft_row=legacy)
        assert resp.status_code == 200
        apply_spy.assert_not_called()


# =============================================================================
# Idempotency-Key on both draft capture routes (route wiring; the atomic
# reservation itself is proven in tests/db/proof_migration_028.sql)
# =============================================================================


_IDEM_KEY = "7b1d3e0a-4c2f-4b8e-9a6d-1f2e3d4c5b6a"
_IDEM_HEADER = {"Idempotency-Key": _IDEM_KEY}


def _patch_draft_idempotency(
    monkeypatch, *, reserve=None, complete_effect=None, complete_result=True
):
    """Replace the three 028 helpers; returns the calls each received.

    ``reserve`` is a Reservation to return (None = reserved) or an exception
    to raise. Each recorded reserve call is (user_id, key, payload_hash,
    draft_id); complete calls are (key, draft_id, response); release calls
    are (key, draft_id).
    """
    import api.routes.drafts as drafts_module
    from api.core.draft_idempotency import Reservation

    calls = {"reserve": [], "complete": [], "release": []}

    def _reserve(user_id, key, payload_hash, draft_id, *, supabase):
        calls["reserve"].append((str(user_id), key, payload_hash, draft_id))
        if isinstance(reserve, Exception):
            raise reserve
        return reserve if reserve is not None else Reservation("reserved")

    def _complete(user_id, key, draft_id, response_json, *, supabase):
        calls["complete"].append((key, draft_id, response_json))
        if complete_effect is not None:
            raise complete_effect
        return complete_result

    def _release(user_id, key, draft_id, *, supabase):
        calls["release"].append((key, draft_id))
        return True

    monkeypatch.setattr(drafts_module, "reserve_draft_capture", _reserve)
    monkeypatch.setattr(drafts_module, "complete_draft_capture", _complete)
    monkeypatch.setattr(drafts_module, "release_draft_capture", _release)
    return calls


def _ps1_parsed_recipe():
    return {
        "title": "Stub URL Recipe",
        "ingredients": _ps1_fake_draft_row()["ingredients"],
        "steps": [{"position": 1, "instruction": "Mix."}],
        "servings": "4",
        "prep_time": None,
        "cook_time": None,
        "confidence": 0.95,
    }


def _patch_get_draft(monkeypatch, effect):
    """Replace the post-failure draft check; ``effect`` is a row or an exception."""
    import api.routes.drafts as drafts_module

    looked: list[UUID] = []

    def _get(draft_id, *, user_id, supabase):
        looked.append(draft_id)
        if isinstance(effect, Exception):
            raise effect
        return effect

    monkeypatch.setattr(drafts_module, "get_draft", _get)
    return looked


class TestDraftCaptureIdempotency:
    _URL = {"url": "https://example.com/recipe"}

    def test_no_header_runs_work_without_touching_idempotency(
        self, provider_contract_client, monkeypatch
    ):
        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(monkeypatch)
        resp = provider_contract_client.post("/api/drafts/capture-url", json=self._URL)
        assert resp.status_code == 200
        assert calls["create_draft"] == 1
        assert idem == {"reserve": [], "complete": [], "release": []}

    def test_reserved_runs_once_and_records_the_response(
        self, provider_contract_client, monkeypatch
    ):
        from api.core.draft_idempotency import hash_capture_payload

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert calls["create_draft"] == 1
        (user, key, payload_hash, draft_id), = idem["reserve"]
        assert (user, key) == ("00000000-0000-0000-0000-000000000001", _IDEM_KEY)
        assert payload_hash == hash_capture_payload([b"https://example.com/recipe"])
        assert isinstance(draft_id, UUID)
        # The draft is created under the reserved id, and completed under it.
        assert calls["create_draft_ids"] == [draft_id]
        assert [(k, d) for k, d, _ in idem["complete"]] == [(_IDEM_KEY, draft_id)]
        assert idem["complete"][0][2]["id"] == resp.json()["id"]
        assert idem["release"] == []

    def test_replay_returns_recorded_draft_without_work_or_rate_limit(
        self, provider_contract_client, monkeypatch
    ):
        from api.core.draft_idempotency import Reservation

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        keys = _patch_rate_limit(monkeypatch)
        idem = _patch_draft_idempotency(
            monkeypatch, reserve=Reservation("replay", response=_ps1_fake_draft_row())
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == _ps1_fake_draft_row()["id"]
        assert calls["create_draft"] == 0
        assert keys == []
        assert idem["complete"] == [] and idem["release"] == []

    def test_in_progress_is_409_with_retry_after(self, provider_contract_client, monkeypatch):
        from api.core.draft_idempotency import IdempotencyInProgressError

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        _patch_draft_idempotency(
            monkeypatch,
            reserve=IdempotencyInProgressError("busy", code="IDEMPOTENCY_IN_PROGRESS"),
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "IDEMPOTENCY_IN_PROGRESS"
        assert resp.headers["Retry-After"] == "5"
        assert calls["create_draft"] == 0

    def test_payload_mismatch_is_409(self, provider_contract_client, monkeypatch):
        from api.core.idempotency import IdempotencyConflictError

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        _patch_draft_idempotency(
            monkeypatch,
            reserve=IdempotencyConflictError("other payload", code="IDEMPOTENCY_CONFLICT"),
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
        assert calls["create_draft"] == 0

    def test_idempotency_store_down_is_503_and_creates_nothing(
        self, provider_contract_client, monkeypatch
    ):
        from api.core.idempotency import IdempotencyServiceError

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        _patch_draft_idempotency(
            monkeypatch, reserve=IdempotencyServiceError("down", code="IDEMPOTENCY_UNAVAILABLE")
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 503
        assert calls["create_draft"] == 0

    @pytest.mark.parametrize("bad", ["   ", "has space", "tab\tbed"])
    def test_invalid_key_is_400_before_any_reservation(
        self, provider_contract_client, monkeypatch, bad
    ):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(monkeypatch)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers={"Idempotency-Key": bad}
        )
        assert resp.status_code == 400
        assert idem["reserve"] == []

    def test_failure_before_the_insert_releases_without_a_lookup(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        looked = _patch_get_draft(monkeypatch, DraftNotFoundError("none", code="DRAFT_NOT_FOUND"))
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 429
        (_, _, _, draft_id), = idem["reserve"]
        assert looked == []
        assert idem["release"] == [(_IDEM_KEY, draft_id)]
        assert idem["complete"] == []

    @staticmethod
    def _rejected_insert(code="23505") -> StorageError:
        from postgrest.exceptions import APIError

        err = StorageError("Failed to insert draft: APIError", code="DB_INSERT_FAILED")
        err.__cause__ = APIError({"message": "refused", "code": code})
        return err

    @pytest.mark.parametrize(
        "code",
        ["23505", "22P02", "42501", "40001", "P0001", "0A000", "53100", "54000"],
    )
    def test_rejection_codes_prove_a_rollback(self, code):
        import api.routes.drafts as drafts_module

        assert drafts_module._insert_definitely_rejected(self._rejected_insert(code).__cause__)

    @pytest.mark.parametrize(
        "code",
        [
            "502", "504", None, "", "2350", "08006", "57P01", "XX000",
            # Every PostgREST-level code is ambiguous: PGRST111/112 can follow a commit.
            "PGRST000", "PGRST001", "PGRST100", "PGRST111", "PGRST112", "PGRST204", "PGRST301",
        ],
    )
    def test_other_api_errors_are_ambiguous(self, code):
        import api.routes.drafts as drafts_module

        assert not drafts_module._insert_definitely_rejected(self._rejected_insert(code).__cause__)
        assert not drafts_module._insert_definitely_rejected(RuntimeError("x"))
        assert not drafts_module._insert_definitely_rejected(None)

    @pytest.mark.parametrize("code", ["504", "PGRST111", "PGRST112"])
    def test_post_commit_capable_errors_keep_reservation_and_images(
        self, provider_contract_client, monkeypatch, code
    ):
        """A gateway 5xx body, or a PostgREST response-building error, also
        arrives as an APIError; the insert may have committed, so nothing may
        be released or deleted."""
        import api.routes.drafts as drafts_module

        _ps1_patch_photo_pipeline(monkeypatch, _ps1_parsed_recipe())
        gateway = self._rejected_insert(code)

        def _gateway(*a, **k):
            raise gateway

        monkeypatch.setattr(drafts_module, "create_draft", _gateway)
        _patch_get_draft(monkeypatch, DraftNotFoundError("none", code="DRAFT_NOT_FOUND"))
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("a.jpg", b"first bytes", "image/jpeg"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 500
        assert provider_contract_client.fake_db.storage.bucket.removed == []
        assert idem["release"] == []

    def test_insert_rejected_by_the_database_releases(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module

        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        rejected = self._rejected_insert()

        def _reject(*a, **k):
            raise rejected

        monkeypatch.setattr(drafts_module, "create_draft", _reject)
        looked = _patch_get_draft(monkeypatch, DraftNotFoundError("none", code="DRAFT_NOT_FOUND"))
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 500
        (_, _, _, draft_id), = idem["reserve"]
        assert looked == []
        assert idem["release"] == [(_IDEM_KEY, draft_id)]

    def test_insert_committed_but_call_failed_returns_that_draft(
        self, provider_contract_client, monkeypatch
    ):
        """create_draft raised without a database answer (timeout / lost
        response) and the row IS visible: no second draft, no release; the
        committed draft is returned and recorded."""
        import api.routes.drafts as drafts_module

        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        created: list[UUID] = []

        def _create_then_lose(*a, **k):
            created.append(k["draft_id"])
            raise StorageError("Failed to insert draft: ReadTimeout", code="DB_INSERT_FAILED")

        monkeypatch.setattr(drafts_module, "create_draft", _create_then_lose)
        committed_row = dict(_ps1_fake_draft_row())
        looked = _patch_get_draft(monkeypatch, committed_row)
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == committed_row["id"]
        assert looked == created
        assert idem["release"] == []
        assert [(k, d) for k, d, _ in idem["complete"]] == [(_IDEM_KEY, created[0])]

    @pytest.mark.parametrize(
        "lookup",
        [
            DraftNotFoundError("not visible yet", code="DRAFT_NOT_FOUND"),  # may still commit
            StorageError("db down", code="DB_ERROR"),  # cannot ask
        ],
        ids=["absent", "unknown"],
    )
    def test_ambiguous_insert_keeps_the_reservation_even_when_not_visible(
        self, provider_contract_client, monkeypatch, lookup
    ):
        """A timed-out insert can commit after the lookup: never release."""
        import api.routes.drafts as drafts_module

        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())

        def _lose(*a, **k):
            raise StorageError("Failed to insert draft: ReadTimeout", code="DB_INSERT_FAILED")

        monkeypatch.setattr(drafts_module, "create_draft", _lose)
        _patch_get_draft(monkeypatch, lookup)
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 500
        assert idem["release"] == [] and idem["complete"] == []

    def test_complete_failure_returns_the_draft_and_keeps_the_reservation(
        self, provider_contract_client, monkeypatch
    ):
        """The draft exists; releasing would let a retry create a second one.
        The row stays pending with our draft id so a retry recovers it."""
        from api.core.idempotency import IdempotencyServiceError

        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(
            monkeypatch,
            reserve=None,
            complete_effect=IdempotencyServiceError("down", code="IDEMPOTENCY_UNAVAILABLE"),
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert idem["release"] == []

    def test_complete_without_a_row_still_returns_the_draft(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(monkeypatch, reserve=None, complete_result=False)
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert idem["release"] == []

    def test_recover_returns_the_holders_draft_without_work(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module
        from api.core.draft_idempotency import Reservation

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        keys = _patch_rate_limit(monkeypatch)
        recovered_id = UUID(_ps1_fake_draft_row()["id"])
        loaded: list[tuple[UUID, str]] = []

        def _get_draft(draft_id, *, user_id, supabase):
            loaded.append((draft_id, str(user_id)))
            return _ps1_fake_draft_row()

        monkeypatch.setattr(drafts_module, "get_draft", _get_draft)
        idem = _patch_draft_idempotency(
            monkeypatch, reserve=Reservation("recover", draft_id=recovered_id)
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == str(recovered_id)
        assert loaded == [(recovered_id, "00000000-0000-0000-0000-000000000001")]
        assert calls["create_draft"] == 0
        assert keys == []
        assert idem["complete"] == [] and idem["release"] == []

    def test_recover_of_a_deleted_draft_is_404(self, provider_contract_client, monkeypatch):
        import api.routes.drafts as drafts_module
        from api.core.draft_idempotency import Reservation

        calls = _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())

        def _missing(draft_id, *, user_id, supabase):
            raise DraftNotFoundError("gone", code="DRAFT_NOT_FOUND")

        monkeypatch.setattr(drafts_module, "get_draft", _missing)
        _patch_draft_idempotency(
            monkeypatch, reserve=Reservation("recover", draft_id=UUID(_ps1_fake_draft_row()["id"]))
        )
        resp = provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        assert resp.status_code == 404
        assert calls["create_draft"] == 0

    def test_photo_route_identity_covers_every_file_and_the_url(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module
        from api.core.draft_idempotency import hash_capture_payload

        _ps1_patch_photo_pipeline(monkeypatch, _ps1_parsed_recipe())
        created = []
        monkeypatch.setattr(
            drafts_module,
            "create_draft",
            lambda *a, **k: created.append(k) or _ps1_fake_draft_row(),
        )
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        files = [
            ("image", ("a.jpg", b"first bytes", "image/jpeg")),
            ("image", ("b.jpg", b"second bytes", "image/jpeg")),
        ]
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=files,
            data={"url": "https://example.com/recipe"},
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 200
        normalized = drafts_module._validate_url("https://example.com/recipe")
        assert idem["reserve"][0][2] == hash_capture_payload(
            [b"first bytes", b"second bytes", normalized.encode("utf-8")]
        )
        assert len(created) == 1
        assert created[0]["draft_id"] == idem["reserve"][0][3]
        assert [(k, d) for k, d, _ in idem["complete"]] == [(_IDEM_KEY, idem["reserve"][0][3])]

    def test_photo_route_without_url_hashes_an_empty_url_part(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module
        from api.core.draft_idempotency import hash_capture_payload

        _ps1_patch_photo_pipeline(monkeypatch, _ps1_parsed_recipe())
        monkeypatch.setattr(drafts_module, "create_draft", lambda *a, **k: _ps1_fake_draft_row())
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("a.jpg", b"first bytes", "image/jpeg"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 200
        assert idem["reserve"][0][2] == hash_capture_payload([b"first bytes", b""])

    def test_photo_route_with_key_limits_new_work_and_releases_on_429(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module

        uploads: list[str] = []
        monkeypatch.setattr(
            drafts_module, "upload_image", lambda *a, **k: uploads.append("x") or "k"
        )
        keys = _patch_rate_limit(monkeypatch, _RL_Exceeded("limited", code="RATE_LIMIT_EXCEEDED"))
        _patch_get_draft(monkeypatch, DraftNotFoundError("none", code="DRAFT_NOT_FOUND"))
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("a.jpg", b"first bytes", "image/jpeg"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 429
        assert keys == [_RL_USER_KEY]
        assert uploads == []
        assert idem["release"] == [(_IDEM_KEY, idem["reserve"][0][3])]

    def test_photo_ambiguous_insert_failure_keeps_uploaded_images(
        self, provider_contract_client, monkeypatch
    ):
        """An insert with an unknown outcome may have committed; its objects
        must stay (a retry recovers that draft by id)."""
        import api.routes.drafts as drafts_module

        _ps1_patch_photo_pipeline(monkeypatch, _ps1_parsed_recipe())

        def _lose(*a, **k):
            raise StorageError("Failed to insert draft: ReadTimeout", code="DB_INSERT_FAILED")

        monkeypatch.setattr(drafts_module, "create_draft", _lose)
        _patch_get_draft(monkeypatch, DraftNotFoundError("none", code="DRAFT_NOT_FOUND"))
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("a.jpg", b"first bytes", "image/jpeg"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 500
        assert provider_contract_client.fake_db.storage.bucket.removed == []
        assert idem["release"] == []

    def test_photo_rejected_insert_cleans_up_and_releases(
        self, provider_contract_client, monkeypatch
    ):
        import api.routes.drafts as drafts_module

        _ps1_patch_photo_pipeline(monkeypatch, _ps1_parsed_recipe())
        rejected = self._rejected_insert()

        def _reject(*a, **k):
            raise rejected

        monkeypatch.setattr(drafts_module, "create_draft", _reject)
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("a.jpg", b"first bytes", "image/jpeg"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 500
        assert provider_contract_client.fake_db.storage.bucket.removed == [["user/fake-key.jpg"]]
        assert idem["release"] == [(_IDEM_KEY, idem["reserve"][0][3])]

    def test_photo_route_validation_still_precedes_reservation(
        self, provider_contract_client, monkeypatch
    ):
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        resp = provider_contract_client.post(
            "/api/drafts/capture",
            files=[("image", ("bad.txt", b"x", "text/plain"))],
            headers=_IDEM_HEADER,
        )
        assert resp.status_code == 400
        assert idem["reserve"] == []

    def test_url_only_form_and_json_routes_share_one_identity(
        self, provider_contract_client, monkeypatch
    ):
        _ps1_patch_url_pipeline(monkeypatch, _ps1_parsed_recipe())
        idem = _patch_draft_idempotency(monkeypatch, reserve=None)
        provider_contract_client.post(
            "/api/drafts/capture", data=self._URL, headers=_IDEM_HEADER
        )
        provider_contract_client.post(
            "/api/drafts/capture-url", json=self._URL, headers=_IDEM_HEADER
        )
        hashes = [h for _, _, h, _ in idem["reserve"]]
        assert len(hashes) == 2 and hashes[0] == hashes[1]
