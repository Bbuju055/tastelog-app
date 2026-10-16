"""Phase 13.4.C — Riff prompt baseline harness.

Runs `RIFF_SYSTEM_PROMPT_TEMPLATE` (current, unchanged) through the
production `run_riff_turn` path against the eval recipes and cases in
`riff_eval_recipes.py`, captures one raw assistant reply per case, and
writes a JSONL transcript to `tests/eval/runs/baseline_<UTC-timestamp>.jsonl`.

Usage:
    api/.venv/bin/python tests/eval/run_riff_baseline.py

Requires `ANTHROPIC_API_KEY` in the environment. The script never reads,
prints, or writes the API key value. The Anthropic SDK reads it from the
environment on its own.

Not a pytest test — invoked manually for prompt-quality evaluation only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# sys.path setup — import recipe registry as a sibling module without
# adding a tests/eval/__init__.py package marker. Repo root must also be on
# sys.path so `api.core.riff` resolves.
# ---------------------------------------------------------------------------

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[1]
for _path in (str(_REPO_ROOT), str(_THIS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import anthropic  # noqa: E402

from api.core.riff import (  # noqa: E402
    extract_recipe_block,
    get_default_riff_config,
    run_riff_turn,
)
from riff_eval_recipes import EVAL_CASES, RECIPES_BY_ID  # noqa: E402


# ---------------------------------------------------------------------------
# Mechanical signal helpers
# ---------------------------------------------------------------------------

# §4 banned phrasings from docs/phase13-4-A-riff-prompt-audit.md.
# Lowercased substring match — not exhaustive; the audit explicitly leaves
# the final list to the revision phase.
BANNED_PHRASINGS: tuple[str, ...] = (
    "certainly!",
    "of course!",
    "great question",
    "absolutely!",
    "here are several options",
    "it depends",
    "i'd suggest considering",
    "i would suggest considering",
    "feel free to",
)

# Strips fenced ```recipe-json``` blocks for prose-side counting only.
# Mirrors the production regex at api/core/riff.py:_RECIPE_BLOCK_PATTERN
# (DOTALL non-greedy match) — local to the harness; not imported from
# production. We do not modify or rely on the production regex semantics
# beyond this counting use.
_FENCE_PATTERN = re.compile(r"```recipe-json\s*\n.*?\n```", re.DOTALL)

# Detects whether the assistant TRIED to emit a recipe-json fence at all,
# regardless of whether it parsed. Used to distinguish:
#   - block_present=True  + block_validates=True   → clean emission
#   - block_present=True  + block_validates=False  → fence attempted, failed validation
#   - block_present=False + block_validates=False  → no attempt
_FENCE_OPEN_TOKEN = "```recipe-json"


def _now_utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _strip_fenced_block(text: str) -> str:
    return _FENCE_PATTERN.sub("", text)


def _word_count(text: str) -> int:
    return len(text.split())


def _paragraph_count(text: str) -> int:
    return sum(1 for chunk in text.split("\n\n") if chunk.strip())


def _banned_phrasing_hits(text: str) -> list[str]:
    lowered = text.lower()
    return [p for p in BANNED_PHRASINGS if p in lowered]


def _question_mark_in_prose(prose: str) -> bool:
    return "?" in prose


def _excerpt(text: str, limit: int = 280) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1] + "…"


def _build_record(*, case: dict, recipe: dict, raw_text: str) -> dict[str, Any]:
    block_dict = extract_recipe_block(raw_text)
    block_present = _FENCE_OPEN_TOKEN in raw_text
    prose_only = _strip_fenced_block(raw_text)

    return {
        "recipe_id": recipe["id"],
        "case_id": case["case_id"],
        "anchor": case.get("anchor"),
        "user_turn": case["user_turn"],
        "expected_shape": case["expected_shape"],
        "raw_text": raw_text,
        "raw_text_excerpt": _excerpt(raw_text),
        "block_present": block_present,
        "block_validates": block_dict is not None,
        "response_word_count_outside_block": _word_count(prose_only),
        "response_paragraph_count_outside_block": _paragraph_count(prose_only),
        "banned_phrasing_hits": _banned_phrasing_hits(raw_text),
        "question_mark_present_in_prose": _question_mark_in_prose(prose_only),
    }


def _run_case(*, config, client, recipe: dict, case: dict) -> dict[str, Any]:
    history = [{"role": "user", "content": case["user_turn"]}]
    raw_text = run_riff_turn(
        config=config,
        client=client,
        recipe=recipe,
        history=history,
        logger=None,
    )
    return _build_record(case=case, recipe=recipe, raw_text=raw_text)


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ERROR: ANTHROPIC_API_KEY not set in environment. "
            "Set it before running. Do not echo its value.",
            file=sys.stderr,
        )
        return 2

    config = get_default_riff_config()
    # SDK reads ANTHROPIC_API_KEY from env. We never touch the value here.
    client = anthropic.Anthropic()

    runs_dir = _THIS_DIR / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    out_path = runs_dir / f"baseline_{_now_utc_stamp()}.jsonl"

    total = len(EVAL_CASES)
    print(f"Running {total} eval cases against current prompt…", flush=True)
    print(f"Writing transcript to: {out_path}", flush=True)

    with out_path.open("w", encoding="utf-8") as fh:
        for idx, case in enumerate(EVAL_CASES, start=1):
            recipe = RECIPES_BY_ID[case["recipe_id"]]
            print(
                f"  [{idx}/{total}] {case['case_id']} "
                f"({case['recipe_id']}, anchor={case['anchor']}) — {case['user_turn']!r}",
                flush=True,
            )
            record = _run_case(config=config, client=client, recipe=recipe, case=case)
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()

    print(f"Done. {total} cases written to {out_path}.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
