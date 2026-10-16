"""Issue 1: bounded step-mapping quality gate (3 recipes x 4 paths x 2 runs).

Runs the four REAL mapping-producing model paths over the adversarial
fixture corpus in mapping_eval_recipes.py:

    vision        parse_recipe_image on the committed fixture PNGs
    url_text      parse_recipe_from_text with URL_TEXT_PARSE_PROMPT
    jsonld_mapper map_ingredients_to_steps (JSON-LD shape: raw_text rows)
    riff_mapper   map_ingredients_to_steps (riff shape: no raw_text)

24 provider calls total. Writes a JSONL transcript to
tests/eval/runs/mapping_<UTC-timestamp>.jsonl (gitignored) and prints a
per-cell verdict table plus the binding PASS gate:

    a. zero false-positive associations anywhere;
    b. expected associations present on BOTH runs of every cell;
    c. golden-empty steps come back authoritative-empty;
    d. malformed output never surfaces as authoritative (the production
       four-state validators run in-path; the harness additionally asserts
       only list/None shapes appear);
    e. extraction equivalence on vision/url_text: every fixture ingredient
       aligns to exactly one extracted ingredient and step counts match.

Usage:
    api/.venv/bin/python tests/eval/run_mapping_eval.py

Requires ANTHROPIC_API_KEY in the environment (never read or printed
here; the SDK resolves it). Not a pytest test.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[1]
for _path in (str(_REPO_ROOT), str(_THIS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import anthropic  # noqa: E402

from api.core.parser import (  # noqa: E402
    get_default_config,
    parse_recipe_image,
    parse_recipe_from_text,
)
from api.core.step_mapping import map_ingredients_to_steps  # noqa: E402
from api.core.url_extractor import URL_TEXT_PARSE_PROMPT  # noqa: E402
from mapping_eval_recipes import (  # noqa: E402
    MAPPING_EVAL_RECIPES,
    publisher_steps,
    recipe_text,
    structured_ingredients,
)

logger = logging.getLogger("mapping_eval")
logging.basicConfig(level=logging.WARNING)

RUNS = 2
PATHS = ("vision", "url_text", "jsonld_mapper", "riff_mapper")


def _norm(s: str | None) -> str:
    return " ".join((s or "").lower().strip().split())


def align_ingredients(
    fixture: list[dict[str, Any]], extracted: list[dict[str, Any]]
) -> dict[int, int] | None:
    """Map extracted-ingredient index (1-based) -> fixture position (1-based).

    Bijective or bust: every fixture row must claim exactly one extracted
    row. Matching priority per fixture row: exact name + quantity, exact
    name (if unique), fixture-name containment in name/raw_text (if
    unique). Returns None when alignment fails (criterion e failure).
    """
    if len(extracted) != len(fixture):
        return None
    claimed: set[int] = set()
    fixture_to_model: dict[int, int] = {}

    def candidates(pred) -> list[int]:
        return [
            i
            for i, row in enumerate(extracted)
            if i not in claimed and pred(row)
        ]

    for f_idx, f_row in enumerate(fixture):
        f_name = _norm(f_row["name"])
        f_qty = _norm(f_row["quantity"])
        cands = candidates(
            lambda r: _norm(r.get("name")) == f_name
            and _norm(r.get("quantity")) == f_qty
        )
        if len(cands) != 1:
            cands = candidates(lambda r: _norm(r.get("name")) == f_name)
        if len(cands) != 1:
            cands = candidates(
                lambda r: f_name
                and (
                    f_name in _norm(r.get("name"))
                    or f_name in _norm(r.get("raw_text"))
                )
            )
        if len(cands) != 1:
            return None
        claimed.add(cands[0])
        fixture_to_model[f_idx + 1] = cands[0] + 1

    model_to_fixture = {m: f for f, m in fixture_to_model.items()}
    return model_to_fixture


def evaluate_cell(
    recipe: dict[str, Any],
    produced: list[list[int] | None] | None,
    *,
    alignment: dict[int, int] | None,
    extraction_ok: bool,
) -> dict[str, Any]:
    """Score one run of one path against the recipe goldens."""
    steps = recipe["steps"]
    result: dict[str, Any] = {
        "extraction_ok": extraction_ok,
        "false_positives": 0,
        "misses": 0,
        "empty_wrong": 0,
        "unknown_steps": 0,
        "step_verdicts": [],
        "shape_ok": True,
    }
    if produced is None:
        produced = [None] * len(steps)
    if len(produced) != len(steps):
        result["shape_ok"] = False
        produced = [None] * len(steps)

    for i, step in enumerate(steps):
        value = produced[i]
        if value is not None and not isinstance(value, list):
            # Criterion d: production validators must never emit this.
            result["shape_ok"] = False
            value = None
        if value is not None and alignment is not None:
            translated: list[int] | None = []
            for ref in value:
                fixture_pos = alignment.get(ref)
                if fixture_pos is None:
                    translated = None  # references a row we couldn't align
                    break
                translated.append(fixture_pos)
            value = translated
        accepted = [sorted(a) for a in step["accepted"]]
        if value is None:
            # An unknown step is a miss for criterion b: even a golden-empty
            # step must come back authoritative-empty, never unknown.
            result["unknown_steps"] += 1
            verdict = "unknown"
            result["misses"] += 1
        else:
            got = sorted(set(value))
            if got in accepted:
                verdict = "pass"
            elif accepted == [[]]:
                result["false_positives"] += 1
                result["empty_wrong"] += 1
                verdict = "fp_on_empty"
            else:
                # Wrong set: a false positive if it contains anything
                # outside the union of accepted sets, else a miss.
                union = {ref for acc in accepted for ref in acc}
                if any(ref not in union for ref in got):
                    result["false_positives"] += 1
                    verdict = "false_positive"
                else:
                    result["misses"] += 1
                    verdict = "miss"
        result["step_verdicts"].append(
            {"step": i + 1, "got": value, "accepted": accepted, "verdict": verdict}
        )
    result["pass"] = (
        extraction_ok
        and result["shape_ok"]
        and result["false_positives"] == 0
        and result["misses"] == 0
    )
    return result


def run_path(
    path: str, recipe: dict[str, Any], client: anthropic.Anthropic
) -> tuple[list[list[int] | None] | None, dict[int, int] | None, bool, dict]:
    """Execute one provider call for (path, recipe).

    Returns (produced_fixture_or_model_positions, alignment, extraction_ok,
    raw_debug).
    """
    config = get_default_config()
    fixture_ings = recipe["ingredients"]
    debug: dict[str, Any] = {}

    if path in ("vision", "url_text"):
        if path == "vision":
            image = _THIS_DIR / "fixtures" / f"{recipe['id']}.png"
            parsed = parse_recipe_image(
                str(image), client=client, config=config, logger=logger
            )
        else:
            url_config = dataclasses.replace(
                config, prompt=URL_TEXT_PARSE_PROMPT
            )
            parsed = parse_recipe_from_text(
                recipe_text(recipe),
                client=client,
                config=url_config,
                logger=logger,
            )
        extracted = parsed.get("ingredients") or []
        steps = parsed.get("steps") or []
        debug["extracted_ingredients"] = [
            {"name": r.get("name"), "quantity": r.get("quantity")}
            for r in extracted
        ]
        alignment = align_ingredients(fixture_ings, extracted)
        extraction_ok = (
            alignment is not None and len(steps) == len(recipe["steps"])
        )
        produced = [s.get("ingredient_positions") for s in steps]
        return produced, alignment, extraction_ok, debug

    include_raw = path == "jsonld_mapper"
    produced = map_ingredients_to_steps(
        structured_ingredients(recipe, include_raw_text=include_raw),
        publisher_steps(recipe),
        client=client,
        config=config,
        logger=logger,
    )
    # Mapper paths use fixture positions directly: identity alignment.
    identity = {i + 1: i + 1 for i in range(len(fixture_ings))}
    return produced, identity, True, debug


def main() -> None:
    client = anthropic.Anthropic()
    runs_dir = _THIS_DIR / "runs"
    runs_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    transcript = runs_dir / f"mapping_{stamp}.jsonl"

    cells: dict[tuple[str, str], list[dict]] = {}
    with transcript.open("w") as fh:
        for run_no in range(1, RUNS + 1):
            for recipe in MAPPING_EVAL_RECIPES:
                for path in PATHS:
                    produced, alignment, extraction_ok, debug = run_path(
                        path, recipe, client
                    )
                    scored = evaluate_cell(
                        recipe,
                        produced,
                        alignment=alignment,
                        extraction_ok=extraction_ok,
                    )
                    record = {
                        "run": run_no,
                        "recipe": recipe["id"],
                        "path": path,
                        "produced": produced,
                        "debug": debug,
                        **scored,
                    }
                    fh.write(json.dumps(record, default=str) + "\n")
                    cells.setdefault((recipe["id"], path), []).append(scored)
                    print(
                        f"run {run_no} {recipe['id']:<12} {path:<13} "
                        f"{'PASS' if scored['pass'] else 'FAIL'} "
                        f"(fp={scored['false_positives']} "
                        f"miss={scored['misses']} "
                        f"unknown={scored['unknown_steps']} "
                        f"extraction={'ok' if scored['extraction_ok'] else 'FAIL'})"
                    )

    total_fp = sum(s["false_positives"] for runs in cells.values() for s in runs)
    all_cells_both_runs = all(
        all(s["pass"] for s in runs) for runs in cells.values()
    )
    print("\n=== GATE ===")
    print(f"a. zero false positives: {'PASS' if total_fp == 0 else 'FAIL'} ({total_fp})")
    print(
        "b. expected associations on both runs of every cell: "
        f"{'PASS' if all_cells_both_runs else 'FAIL'}"
    )
    print(f"transcript: {transcript}")
    overall = total_fp == 0 and all_cells_both_runs
    print(f"OVERALL: {'PASS' if overall else 'FAIL'}")
    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
