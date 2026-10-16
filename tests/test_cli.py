"""CLI wrapper verification tests.

These tests verify CLI scripts still import correctly after refactor to api.core.
"""


def test_cli_modules_import():
    """All CLI wrapper modules import without error."""
    import parser  # noqa: F401
    import capture  # noqa: F401
    import search  # noqa: F401
    import grocery  # noqa: F401
