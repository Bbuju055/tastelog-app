"""Structural save guard, not a claim of source fidelity or completeness."""
from api.core.exceptions import TastelogError


class IncompleteRecipeError(TastelogError):
    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(
            "Add at least one ingredient and one instruction from the source before saving.",
            code="RECIPE_INCOMPLETE",
        )


def require_recipe_content(ingredients: list | None, steps: list | None) -> None:
    """Require meaningful content in both sections; ignore confidence scores."""
    def present(value: object) -> bool:
        return isinstance(value, str) and bool(value.strip())

    missing = []
    if not any(present(row.get("name")) and (row.get("raw_text") is None or present(row.get("raw_text"))) for row in ingredients or []):
        missing.append("ingredients")
    if not any(present(row.get("instruction")) for row in steps or []):
        missing.append("instructions")
    if missing:
        raise IncompleteRecipeError(missing)
