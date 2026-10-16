"""Phase 14.2D: validate the Anthropic client factory + deterministic stub.

Production default (`ANTHROPIC_STUB_MODE` unset / "" / "off") MUST remain the
real `anthropic.Anthropic` SDK — no behavior change from pre-14.2D.

Isolated load targets opt into the in-process stub via
`ANTHROPIC_STUB_MODE=deterministic`. The stub satisfies the four call
patterns currently in production (parser image, parser text /
ingredient structuring, Riff sync, Riff stream) without any network
call.

Invalid env values raise `ValueError` to fail fast — silent fallback
to the real SDK would let a misconfigured load target spend money or
quota against the real Anthropic API.

No real Anthropic calls are made by any test in this module — the
real-SDK branch is verified via `patch("...anthropic.Anthropic")` so
the SDK constructor itself is intercepted before any network code runs.
"""

import json
import logging
from unittest.mock import patch

import pytest

from api.core.anthropic_client import (
    _DeterministicAnthropic,
    get_anthropic_client,
)
from api.core.parser import ParsedRecipe, get_default_config
from api.core.riff import get_default_riff_config, run_riff_turn, run_riff_turn_stream
from api.core.url_extractor import structure_ingredients_with_claude


# -----------------------------------------------------------------------------
# Mode selection — env → which client
# -----------------------------------------------------------------------------


def test_returns_real_client_when_env_unset(monkeypatch):
    """Env unset → factory routes to the real `anthropic.Anthropic` constructor."""
    monkeypatch.delenv("ANTHROPIC_STUB_MODE", raising=False)

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 1
    # api_key is passed; value never asserted (would risk leaking the real env
    # key to a failure diff). Presence + non-empty is enough.
    assert "api_key" in ctor.call_args.kwargs
    assert ctor.call_args.kwargs["api_key"]
    assert client is ctor.return_value


def test_returns_real_client_when_env_empty_string(monkeypatch):
    """Empty string (Railway pattern for deleted env vars) → real SDK."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "")

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 1
    assert client is ctor.return_value


def test_returns_real_client_when_env_off(monkeypatch):
    """`off` → real SDK."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "off")

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 1
    assert client is ctor.return_value


def test_returns_real_client_when_env_off_uppercase(monkeypatch):
    """`OFF` → real SDK (case-insensitive resolution)."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "OFF")

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 1
    assert client is ctor.return_value


def test_returns_stub_when_env_deterministic(monkeypatch):
    """`deterministic` → in-process stub, no SDK constructor call."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 0
    assert isinstance(client, _DeterministicAnthropic)


def test_stub_with_options_returns_usable_client(monkeypatch):
    """Issue 3: the bounded edit-mapping call uses client.with_options(
    timeout=5.0, max_retries=0); the stub must accept it and stay usable."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")

    client = get_anthropic_client()
    bounded = client.with_options(timeout=5.0, max_retries=0)

    assert isinstance(bounded, _DeterministicAnthropic)
    assert bounded.messages is client.messages


def test_returns_stub_when_env_deterministic_uppercase(monkeypatch):
    """`DETERMINISTIC` → stub (case-insensitive resolution)."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "DETERMINISTIC")

    with patch("api.core.anthropic_client.anthropic.Anthropic") as ctor:
        client = get_anthropic_client()

    assert ctor.call_count == 0
    assert isinstance(client, _DeterministicAnthropic)


def test_invalid_mode_raises_value_error(monkeypatch):
    """Unknown value → `ValueError`. No silent fallback to real SDK.

    Fail-fast guards a misconfigured load target from accidentally hitting
    the real Anthropic API (cost + quota + production-side traffic risk).
    """
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "totally-bogus")

    with pytest.raises(ValueError) as exc:
        get_anthropic_client()

    msg = str(exc.value)
    assert "ANTHROPIC_STUB_MODE" in msg
    assert "totally-bogus" in msg


# -----------------------------------------------------------------------------
# Stub shape — schema-compatible responses for each consumer
# -----------------------------------------------------------------------------


def test_stub_messages_create_image_path_returns_valid_parsed_recipe(monkeypatch):
    """Parser image path: stub returns JSON validating against `ParsedRecipe`.

    Bypasses `parse_recipe_image()` (which needs a real image file on disk)
    by invoking `client.messages.create()` directly with the same call
    shape the parser uses — confirms the stub's response survives
    `ParsedRecipe.model_validate`.
    """
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")
    client = get_anthropic_client()

    config = get_default_config()
    message = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": "<fake-base64-stub>",
                        },
                    },
                    {"type": "text", "text": config.prompt},
                ],
            }
        ],
    )

    raw_text = "".join(block.text for block in message.content)
    parsed = json.loads(raw_text)
    validated = ParsedRecipe.model_validate(parsed)
    assert validated.title
    assert validated.ingredients
    assert validated.steps
    assert 0.0 <= validated.confidence <= 1.0


def test_stub_structure_ingredients_returns_matching_length(monkeypatch):
    """Ingredient-structuring path: stub JSON array length matches input lines.

    `structure_ingredients_with_claude` enforces `len(parsed) ==
    len(raw_ingredients)` and validates each entry via
    `ParsedIngredient.model_validate`. End-to-end: stub → caller's parse
    → caller's validation.
    """
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")
    client = get_anthropic_client()

    raw_ingredients = ["1 cup flour", "2 large eggs", "1/2 tsp salt"]
    # PROVIDER-S1: structuring returns the structured list directly and
    # raises a typed ProviderError on failure — the old (list, success)
    # tuple contract was intentionally retired with the silent fallback.
    structured = structure_ingredients_with_claude(
        raw_ingredients,
        client=client,
        config=get_default_config(),
        logger=logging.getLogger("test"),
    )

    assert len(structured) == len(raw_ingredients)
    for item in structured:
        assert item["name"]
        assert "raw_text" in item


def test_stub_run_riff_turn_returns_non_empty_text(monkeypatch):
    """Riff sync path: `run_riff_turn` returns non-empty prose text."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")
    client = get_anthropic_client()

    recipe = {
        "title": "Test Recipe",
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "20 min",
        "ingredients": [{"name": "butter", "quantity": "2", "unit": "tbsp", "prep": None}],
        "steps": [{"position": 1, "instruction": "Melt butter."}],
    }
    history = [{"role": "user", "content": "Can I sub olive oil for butter?"}]

    reply = run_riff_turn(
        config=get_default_riff_config(),
        client=client,
        recipe=recipe,
        history=history,
    )

    assert isinstance(reply, str)
    assert reply.strip()


def test_stub_run_riff_turn_stream_yields_non_empty_deltas(monkeypatch):
    """Riff stream path: `run_riff_turn_stream` yields ≥1 non-empty text delta."""
    monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")
    client = get_anthropic_client()

    recipe = {
        "title": "Test Recipe",
        "servings": "4",
        "prep_time": "10 min",
        "cook_time": "20 min",
        "ingredients": [{"name": "butter", "quantity": "2", "unit": "tbsp", "prep": None}],
        "steps": [{"position": 1, "instruction": "Melt butter."}],
    }
    history = [{"role": "user", "content": "Can I sub olive oil for butter?"}]

    deltas = list(
        run_riff_turn_stream(
            config=get_default_riff_config(),
            client=client,
            recipe=recipe,
            history=history,
        )
    )

    assert len(deltas) >= 1
    assert all(isinstance(d, str) for d in deltas)
    assert all(d for d in deltas)


# -----------------------------------------------------------------------------
# Logging discipline
# -----------------------------------------------------------------------------


def test_factory_does_not_log_secrets(monkeypatch, caplog):
    """The factory must never emit the API key value to logs.

    Exercise both branches (real-SDK + stub) with a sentinel api_key
    swapped into `get_settings`. After both calls, assert no log record
    contains the sentinel value.
    """
    sentinel_key = "sk-ant-stub-test-key-DO-NOT-LEAK-xxxxxxxxxxxxxxxxxxxx"

    class _FakeSettings:
        anthropic_api_key = sentinel_key

    monkeypatch.setattr(
        "api.core.anthropic_client.get_settings", lambda: _FakeSettings()
    )

    with caplog.at_level(logging.DEBUG, logger="tastelog.core.anthropic_client"):
        # Real-SDK branch (constructor patched to avoid network).
        monkeypatch.delenv("ANTHROPIC_STUB_MODE", raising=False)
        with patch("api.core.anthropic_client.anthropic.Anthropic"):
            get_anthropic_client()

        # Stub branch — no SDK call, but exercises the factory's INFO log line.
        monkeypatch.setenv("ANTHROPIC_STUB_MODE", "deterministic")
        get_anthropic_client()

    for record in caplog.records:
        assert sentinel_key not in record.getMessage()
