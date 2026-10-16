"""Custom exceptions for Tastelog API."""


class TastelogError(Exception):
    """Base exception for all Tastelog errors."""

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code


class ParsingError(TastelogError):
    """Error during recipe parsing."""

    pass


class ProviderError(ParsingError):
    """Recipe-parsing failure caused by the model provider, not the user.

    Covers provider availability, authentication/account status, rate
    limiting, timeouts/network, and unusable provider output (PROVIDER-S1).
    Carries safe structured diagnostics for logging only — never provider
    response bodies, authorization material, keys, or user content.

    Subclasses ParsingError so existing broad handlers keep working;
    routes must catch ProviderError FIRST to map honest provider statuses.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        provider_status: int | None = None,
        provider_error_type: str | None = None,
        request_id: str | None = None,
    ):
        super().__init__(message, code=code)
        self.provider_status = provider_status
        self.provider_error_type = provider_error_type
        self.request_id = request_id


class ImageProcessingError(TastelogError):
    """Error during image processing."""

    pass


class RecipeNotFoundError(TastelogError):
    """Recipe not found in database."""

    pass


class GroceryListNotFoundError(TastelogError):
    """Grocery list not found in database."""

    pass


class GroceryListForbiddenError(TastelogError):
    """Grocery list exists but is not owned by the requesting user."""

    pass


class StorageError(TastelogError):
    """Error during storage operations."""

    pass


class DraftNotFoundError(TastelogError):
    """Draft not found in database."""

    pass


class DraftExpiredError(TastelogError):
    """Draft has expired."""

    pass


class CookEventNotFoundError(TastelogError):
    """Cook event not found in database."""

    pass


class URLFetchError(TastelogError):
    """URL fetch failed (DNS, timeout, non-200, non-HTML, etc.)."""

    pass
