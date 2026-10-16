"""
Tastelog: stable machine-readable capture error wire contract (PROVIDER-S1).

Shared by the draft capture routes (api/routes/drafts.py) and the legacy
token capture route (api/routes/recipes.py). Route-owned capture-processing
failures return a dict detail:

    {"detail": {"code": <STABLE_CODE>, "message": <safe fixed copy>}}

Provider failures are never blamed on the user's content; genuine
content-level failures keep 422 + RECIPE_UNREADABLE. Messages are fixed
safe strings: never provider names, model IDs, bodies, or user content.
Transport/validation/authentication failures deliberately stay on
status-based plain-string details; clients fall back on status class.

Relocated verbatim from api/routes/drafts.py (15.3.S-CF1b); provider
failure logging stays route-local so log streams keep their route logger.
"""

from fastapi import HTTPException

from api.core.exceptions import ProviderError

PROVIDER_WIRE: dict[str, tuple[int, str, str]] = {
    "PROVIDER_UNAVAILABLE": (
        503,
        "RECIPE_PROVIDER_UNAVAILABLE",
        "Recipe capture is currently unavailable.",
    ),
    "PROVIDER_RATE_LIMITED": (
        503,
        "RECIPE_PROVIDER_RATE_LIMITED",
        "Recipe capture is currently unavailable.",
    ),
    "PROVIDER_TIMEOUT": (
        504,
        "RECIPE_PROVIDER_TIMEOUT",
        "Recipe capture timed out.",
    ),
    "PROVIDER_BAD_RESPONSE": (
        502,
        "RECIPE_PROVIDER_BAD_RESPONSE",
        "Recipe capture received an unusable response.",
    ),
}


def provider_http_exception(e: ProviderError) -> HTTPException:
    """Map a typed ProviderError to its stable wire contract."""
    status, wire_code, message = PROVIDER_WIRE.get(
        e.code or "", PROVIDER_WIRE["PROVIDER_UNAVAILABLE"]
    )
    return HTTPException(
        status_code=status, detail={"code": wire_code, "message": message}
    )


def unreadable_http_exception(message: str) -> HTTPException:
    return HTTPException(
        status_code=422, detail={"code": "RECIPE_UNREADABLE", "message": message}
    )
