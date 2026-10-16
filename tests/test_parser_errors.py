"""PROVIDER-S1 — parser provider-error classification tests.

Pins the typed exception taxonomy at the Anthropic SDK boundary:
- every SDK failure class maps to a ProviderError with a stable internal
  code, safe diagnostics, and `raise ... from e` chaining;
- unusable provider output (empty / invalid JSON / schema mismatch) maps
  to PROVIDER_BAD_RESPONSE and never echoes the response body;
- unexpected non-SDK exceptions bubble unwrapped (routes map them to 500);
- single-image, multi-image, and text paths classify consistently;
- the default parser config consumes the shared DEFAULT_CLAUDE_MODEL.

No network and no real Claude — all clients are stubs.
"""

import json
import logging

import anthropic
import httpx
import pytest

from api.core.anthropic_client import (
    DEFAULT_CLAUDE_MODEL,
    PROVIDER_BAD_RESPONSE,
    PROVIDER_RATE_LIMITED,
    PROVIDER_TIMEOUT,
    PROVIDER_UNAVAILABLE,
)
from api.core.exceptions import ProviderError
from api.core import parser as parser_module
from api.core.parser import (
    get_default_config,
    parse_recipe_image,
    parse_recipe_images,
    parse_recipe_from_text,
)

_TEST_LOGGER = logging.getLogger("test.parser_errors")

_REQ = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def _status_error(status: int) -> anthropic.APIStatusError:
    resp = httpx.Response(status, request=_REQ, json={"type": "error"})
    if status == 404:
        return anthropic.NotFoundError("model not found", response=resp, body=None)
    if status == 401:
        return anthropic.AuthenticationError("bad key", response=resp, body=None)
    if status == 429:
        return anthropic.RateLimitError("slow down", response=resp, body=None)
    return anthropic.APIStatusError("provider error", response=resp, body=None)


class _StubBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class _StubMessage:
    def __init__(self, texts: list[str]) -> None:
        self.content = [_StubBlock(t) for t in texts]


class _StubMessages:
    def __init__(self, *, texts=None, exc=None):
        self._texts = texts
        self._exc = exc

    def create(self, **kwargs):
        if self._exc is not None:
            raise self._exc
        return _StubMessage(self._texts or [])


class _StubClient:
    def __init__(self, *, texts=None, exc=None):
        self.messages = _StubMessages(texts=texts, exc=exc)


@pytest.fixture(autouse=True)
def _fake_encode_image(monkeypatch):
    """Image encoding is out of scope here — return a deterministic blob."""
    monkeypatch.setattr(
        parser_module, "encode_image", lambda *a, **k: ("ZmFrZQ==", "image/jpeg")
    )


def _parse_image(client):
    return parse_recipe_image(
        "/tmp/fake.jpg", client=client, config=get_default_config(), logger=_TEST_LOGGER
    )


# -----------------------------------------------------------------------------
# SDK exception classification
# -----------------------------------------------------------------------------


class TestSdkClassification:
    def test_model_not_found_is_provider_unavailable_with_chain(self):
        exc = _status_error(404)
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(exc=exc))
        err = ei.value
        assert err.code == PROVIDER_UNAVAILABLE
        assert err.provider_status == 404
        assert err.provider_error_type == "NotFoundError"
        assert err.__cause__ is exc

    def test_authentication_failure_is_provider_unavailable(self):
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(exc=_status_error(401)))
        assert ei.value.code == PROVIDER_UNAVAILABLE
        assert ei.value.provider_status == 401

    def test_rate_limit_is_provider_rate_limited(self):
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(exc=_status_error(429)))
        assert ei.value.code == PROVIDER_RATE_LIMITED
        assert ei.value.provider_status == 429

    def test_timeout_is_provider_timeout(self):
        exc = anthropic.APITimeoutError(request=_REQ)
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(exc=exc))
        assert ei.value.code == PROVIDER_TIMEOUT
        assert ei.value.__cause__ is exc

    def test_connection_failure_is_provider_unavailable(self):
        exc = anthropic.APIConnectionError(request=_REQ)
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(exc=exc))
        assert ei.value.code == PROVIDER_UNAVAILABLE

    def test_unexpected_exception_bubbles_unwrapped(self):
        with pytest.raises(ValueError):
            _parse_image(_StubClient(exc=ValueError("boom")))

    def test_multi_image_classifies_identically(self):
        exc = _status_error(404)
        with pytest.raises(ProviderError) as ei:
            parse_recipe_images(
                ["/tmp/a.jpg", "/tmp/b.jpg"],
                client=_StubClient(exc=exc),
                config=get_default_config(),
                logger=_TEST_LOGGER,
            )
        assert ei.value.code == PROVIDER_UNAVAILABLE
        assert ei.value.provider_status == 404

    def test_text_path_classifies_identically(self):
        with pytest.raises(ProviderError) as ei:
            parse_recipe_from_text(
                "Some recipe text",
                client=_StubClient(exc=_status_error(429)),
                config=get_default_config(),
                logger=_TEST_LOGGER,
            )
        assert ei.value.code == PROVIDER_RATE_LIMITED


# -----------------------------------------------------------------------------
# Unusable provider output → PROVIDER_BAD_RESPONSE (never user-blamed)
# -----------------------------------------------------------------------------


class TestBadResponseClassification:
    def test_empty_response_is_bad_response(self):
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(texts=[]))
        assert ei.value.code == PROVIDER_BAD_RESPONSE

    def test_non_json_response_is_bad_response_without_body_echo(self):
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(texts=["utterly not json output"]))
        assert ei.value.code == PROVIDER_BAD_RESPONSE
        # Safe diagnostics: the provider response body is never echoed.
        assert "utterly not json" not in str(ei.value)

    def test_schema_mismatch_is_bad_response_with_chain(self):
        # Valid JSON that fails the ParsedRecipe schema (missing confidence).
        with pytest.raises(ProviderError) as ei:
            _parse_image(_StubClient(texts=[json.dumps({"title": "X"})]))
        assert ei.value.code == PROVIDER_BAD_RESPONSE
        assert ei.value.__cause__ is not None

    def test_valid_recipe_still_parses(self):
        payload = {
            "title": "Stub Pasta",
            "servings": "4",
            "prep_time": None,
            "cook_time": None,
            "ingredients": [
                {
                    "quantity": "1",
                    "unit": "cup",
                    "name": "flour",
                    "prep": None,
                    "raw_text": "1 cup flour",
                }
            ],
            "steps": [{"position": 1, "instruction": "Mix."}],
            "confidence": 0.9,
        }
        result = _parse_image(_StubClient(texts=[json.dumps(payload)]))
        assert result["title"] == "Stub Pasta"


# -----------------------------------------------------------------------------
# Shared model constant
# -----------------------------------------------------------------------------


def test_default_config_consumes_shared_model_constant():
    assert get_default_config().model == DEFAULT_CLAUDE_MODEL
    assert DEFAULT_CLAUDE_MODEL == "claude-sonnet-4-6"
