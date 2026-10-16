"""
15.3.S-CF1b: legacy POST /api/recipes/capture error contract.

First test coverage for this route. Pins the corrected exception cascade:
provider failures map to honest 5xx statuses with stable codes (never a
422 blaming the user's photo), unreadable images keep 422 with the
RECIPE_UNREADABLE code and fixed copy, residual parse failures map to
502 RECIPE_PROVIDER_BAD_RESPONSE, storage failures return 503 with fixed
retry guidance and never leak exception text. Transport/validation/auth
paths (400/401/409/413/429) keep their pre-existing plain-string details.

Seam: monkeypatch at the api.routes.recipes namespace (token verification,
idempotency, rate limit, capture_recipe), mirroring test_drafts.py's
PROVIDER-S1 contract-test pattern.
"""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.core.anthropic_client import (
    PROVIDER_BAD_RESPONSE,
    PROVIDER_RATE_LIMITED,
    PROVIDER_TIMEOUT,
    PROVIDER_UNAVAILABLE,
)
from api.core.exceptions import (
    ImageProcessingError,
    ParsingError,
    ProviderError,
    StorageError,
)
from api.core.idempotency import IdempotencyConflictError, IdempotencyServiceError
from api.core.token_auth import RateLimitExceededError
from api.dependencies import get_db

STORAGE_RETRY_DETAIL = (
    "Recipe capture failed before completion. Retry with the same Idempotency-Key."
)


@pytest.fixture()
def legacy_capture_client(app, monkeypatch):
    """Token-authed client with everything but the route's cascade faked."""
    import api.routes.recipes as recipes_module

    token_record = SimpleNamespace(id=uuid4(), user_id=uuid4())

    monkeypatch.setattr(
        recipes_module, "verify_capture_token", lambda *a, **k: token_record
    )
    monkeypatch.setattr(recipes_module, "check_idempotency", lambda *a, **k: None)
    monkeypatch.setattr(
        recipes_module, "check_and_record_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr(recipes_module, "store_idempotency", lambda *a, **k: None)
    monkeypatch.setattr(recipes_module, "update_last_used", lambda *a, **k: None)

    app.dependency_overrides[get_db] = lambda: SimpleNamespace()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
    app.dependency_overrides.pop(get_db, None)


def _patch_capture(monkeypatch, effect):
    import api.routes.recipes as recipes_module

    def _capture(*a, **k):
        if isinstance(effect, Exception):
            raise effect
        return effect

    monkeypatch.setattr(recipes_module, "capture_recipe", _capture)


def _post_capture(client, headers_extra=None, content_type="image/jpeg"):
    headers = {
        "Authorization": "Bearer tl_cap_" + "a" * 32,
        "Idempotency-Key": str(uuid4()),
    }
    if headers_extra:
        headers.update(headers_extra)
    return client.post(
        "/api/recipes/capture",
        headers=headers,
        files={"image": ("recipe.jpg", b"fake jpeg bytes", content_type)},
    )


class TestLegacyCaptureProcessingContract:
    def test_unreadable_image_maps_422_with_stable_code(
        self, legacy_capture_client, monkeypatch
    ):
        _patch_capture(
            monkeypatch, ImageProcessingError("cv2 blew up", code="DECODE_FAILED")
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 422
        assert resp.json()["detail"] == {
            "code": "RECIPE_UNREADABLE",
            "message": "We couldn’t read a recipe from this image.",
        }
        # The raw exception text must never reach the wire.
        assert "cv2" not in resp.text

    def test_provider_unavailable_maps_503_not_422(
        self, legacy_capture_client, monkeypatch
    ):
        _patch_capture(
            monkeypatch,
            ProviderError("prov down", code=PROVIDER_UNAVAILABLE, provider_status=529),
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_UNAVAILABLE"
        assert "prov down" not in resp.text

    def test_provider_rate_limited_maps_503(self, legacy_capture_client, monkeypatch):
        _patch_capture(
            monkeypatch, ProviderError("rl", code=PROVIDER_RATE_LIMITED)
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_RATE_LIMITED"

    def test_provider_timeout_maps_504(self, legacy_capture_client, monkeypatch):
        _patch_capture(monkeypatch, ProviderError("t", code=PROVIDER_TIMEOUT))
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 504
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_TIMEOUT"

    def test_provider_bad_response_maps_502(self, legacy_capture_client, monkeypatch):
        _patch_capture(monkeypatch, ProviderError("b", code=PROVIDER_BAD_RESPONSE))
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 502
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_BAD_RESPONSE"

    def test_residual_parsing_error_maps_502_never_blames_content(
        self, legacy_capture_client, monkeypatch
    ):
        _patch_capture(
            monkeypatch, ParsingError("weird model output", code="NO_JSON_OBJECT")
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 502
        assert resp.json()["detail"]["code"] == "RECIPE_PROVIDER_BAD_RESPONSE"
        assert "weird model output" not in resp.text

    def test_storage_error_maps_503_fixed_copy_no_leak(
        self, legacy_capture_client, monkeypatch
    ):
        _patch_capture(
            monkeypatch,
            StorageError(
                "Failed to insert recipe: APIError: secret-ish", code="DB_INSERT_FAILED"
            ),
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 503
        assert resp.json()["detail"] == STORAGE_RETRY_DETAIL
        assert "secret-ish" not in resp.text

    def test_undecodable_upload_maps_422_not_retryable_503(
        self, legacy_capture_client, monkeypatch
    ):
        # Declared MIME passed validation but actual bytes are unreadable:
        # content-derived StorageError codes must NOT promise a retry.
        _patch_capture(
            monkeypatch,
            StorageError("Unable to detect file type: x.jpg", code="UNKNOWN_FILE_TYPE"),
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 422
        assert resp.json()["detail"] == {
            "code": "RECIPE_UNREADABLE",
            "message": "We couldn’t read a recipe from this image.",
        }

    def test_idempotency_persist_failure_maps_503(
        self, legacy_capture_client, monkeypatch
    ):
        import api.routes.recipes as recipes_module

        _patch_capture(monkeypatch, {"id": str(uuid4())})

        def _store_fails(*a, **k):
            raise IdempotencyServiceError("persist down")

        monkeypatch.setattr(recipes_module, "store_idempotency", _store_fails)
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 503
        assert "Idempotency-Key" in resp.json()["detail"]

    def test_success_shape_unchanged(self, legacy_capture_client, monkeypatch):
        recipe_id = str(uuid4())
        _patch_capture(monkeypatch, {"id": recipe_id})
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 200
        body = resp.json()
        assert body["recipe_id"] == recipe_id
        assert body["status"] == "complete"
        assert body["view_url"] == f"/recipes/{recipe_id}"
        assert "capture_id" in body


class TestLegacyCaptureTransportPathsUnchanged:
    def test_missing_token_maps_401_string_detail(
        self, legacy_capture_client, monkeypatch
    ):
        _patch_capture(monkeypatch, {"id": str(uuid4())})
        resp = legacy_capture_client.post(
            "/api/recipes/capture",
            headers={"Idempotency-Key": str(uuid4())},
            files={"image": ("r.jpg", b"x", "image/jpeg")},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Capture token required"

    def test_invalid_content_type_maps_400(self, legacy_capture_client, monkeypatch):
        _patch_capture(monkeypatch, {"id": str(uuid4())})
        resp = _post_capture(legacy_capture_client, content_type="text/plain")
        assert resp.status_code == 400
        assert "Invalid file type" in resp.json()["detail"]

    def test_oversize_file_maps_413(self, legacy_capture_client, monkeypatch):
        _patch_capture(monkeypatch, {"id": str(uuid4())})
        big = b"x" * (10 * 1024 * 1024 + 1)
        resp = legacy_capture_client.post(
            "/api/recipes/capture",
            headers={
                "Authorization": "Bearer tl_cap_" + "a" * 32,
                "Idempotency-Key": str(uuid4()),
            },
            files={"image": ("big.jpg", big, "image/jpeg")},
        )
        assert resp.status_code == 413

    def test_idempotency_conflict_maps_409_string_detail(
        self, legacy_capture_client, monkeypatch
    ):
        import api.routes.recipes as recipes_module

        _patch_capture(monkeypatch, {"id": str(uuid4())})

        def _conflict(*a, **k):
            raise IdempotencyConflictError("conflict")

        monkeypatch.setattr(recipes_module, "check_idempotency", _conflict)
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 409
        assert resp.json()["detail"] == (
            "Idempotency key already used with different payload"
        )

    def test_rate_limit_maps_429(self, legacy_capture_client, monkeypatch):
        import api.routes.recipes as recipes_module

        _patch_capture(monkeypatch, {"id": str(uuid4())})

        def _limited(*a, **k):
            raise RateLimitExceededError("Rate limit exceeded: 60 per hour")

        monkeypatch.setattr(
            recipes_module, "check_and_record_rate_limit", _limited
        )
        resp = _post_capture(legacy_capture_client)
        assert resp.status_code == 429
