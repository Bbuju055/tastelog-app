"""Phase 14.2A: validate SENTRY_TRACES_SAMPLE_RATE env override in _init_sentry_from_env.

Production default (env unset OR empty string) MUST remain 0.0 — tracing stays OFF
unless an operator explicitly opts in (e.g. on an isolated load target).
"""

from unittest.mock import patch

import api.main as main_module


def test_traces_sample_rate_defaults_to_zero_when_env_unset(monkeypatch):
    """Env unset → sentry_sdk.init receives traces_sample_rate=0.0."""
    monkeypatch.setenv("SENTRY_DSN", "https://test@example.invalid/1")
    monkeypatch.delenv("SENTRY_TRACES_SAMPLE_RATE", raising=False)

    with patch("sentry_sdk.init") as mock_init:
        main_module._init_sentry_from_env()

    assert mock_init.call_count == 1
    assert mock_init.call_args.kwargs["traces_sample_rate"] == 0.0


def test_traces_sample_rate_defaults_to_zero_when_env_empty_string(monkeypatch):
    """Empty string (Railway pattern for deleted env vars) collapses to default 0.0."""
    monkeypatch.setenv("SENTRY_DSN", "https://test@example.invalid/1")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "")

    with patch("sentry_sdk.init") as mock_init:
        main_module._init_sentry_from_env()

    assert mock_init.call_count == 1
    assert mock_init.call_args.kwargs["traces_sample_rate"] == 0.0


def test_traces_sample_rate_uses_env_override_when_set(monkeypatch):
    """SENTRY_TRACES_SAMPLE_RATE=0.25 → sentry_sdk.init receives 0.25 as a float."""
    monkeypatch.setenv("SENTRY_DSN", "https://test@example.invalid/1")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")

    with patch("sentry_sdk.init") as mock_init:
        main_module._init_sentry_from_env()

    assert mock_init.call_count == 1
    assert mock_init.call_args.kwargs["traces_sample_rate"] == 0.25
