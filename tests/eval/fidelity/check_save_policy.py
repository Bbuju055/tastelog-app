"""Apply today's structural guard to historical parsed outputs, with no model calls."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from api.core.extraction_review import IncompleteRecipeError, require_recipe_content

source = Path(__file__).parent / "results/fidelity_20261018T213818Z.jsonl"
rows = []
for line in source.read_text().splitlines():
    capture = json.loads(line)
    parsed = capture.get("parsed")
    if parsed is None:
        continue
    missing = []
    try:
        require_recipe_content(parsed.get("ingredients"), parsed.get("steps"))
    except IncompleteRecipeError as error:
        missing = error.missing
    rows.append({"case": capture["case"], "arm": capture["arm"], "run": capture["run"],
                 "confidence": parsed.get("confidence"), "missing_sections": missing,
                 "save_allowed_by_structure": not missing})
report = {
    "scope": "Offline structural guard applied to historical October 18 parsed outputs. Not a capture rerun or source-fidelity evaluation. Current PDF policy separately rejects all multi-page inputs.",
    "checked": len(rows), "blocked": sum(bool(row["missing_sections"]) for row in rows),
    "limitation": "Nonempty invented or truncated instructions can pass. No completeness guarantee.",
    "results": rows,
}
print(json.dumps(report, indent=2))
