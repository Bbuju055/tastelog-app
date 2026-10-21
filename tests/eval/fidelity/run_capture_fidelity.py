"""Capture-fidelity eval: real inputs through the production capture paths.

Nine cases: seven PDFs committed under inputs/ and two live URLs, one with
JSON-LD and one without. Each case has a hand-written expected answer under
expected/ that covers the WHOLE source recipe, including anything on a PDF's
second page. The current pipeline rejects multi-page PDFs before model calls.
Committed October 18 results predate that guard: they rendered page 1 only,
with page-2 content scored as omissions. Offline rescoring preserves that
historical evidence; it does not evaluate the current input policy.

Two arms, same model, same code paths, same validators:

    production  the shipped prompts, untouched
    baseline    each parse prompt cut at its "Rules:" line, i.e. the schema
                example alone; the URL text prompt also loses its "ignore the
                blog noise" paragraph. The step mapper runs unchanged in both
                arms: mapping is recorded here, not scored
                (tests/eval/run_mapping_eval.py owns that gate).

The client wrapper records model, token usage, stop reason, latency and the
raw model text for every call. A committed results file can be re-scored
offline without the API: ``--rescore`` re-applies the scoring rules to each
row's stored ``parsed`` dict (the validated recipe the route would have
stored), not to the raw text.

    api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py
    api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py --arm production --runs 1 --case garlic_aioli
    api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py --rescore tests/eval/fidelity/results/fidelity_<stamp>.jsonl [--out <same or new file>]

Requires ANTHROPIC_API_KEY in the environment; presence is checked, the value
is never read or printed. Not a pytest test. A full run is about 40 calls.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import difflib
import hashlib
import json
import logging
import os
import re
import statistics
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import anthropic  # noqa: E402

from api.core import url_extractor  # noqa: E402
from api.core.parser import (  # noqa: E402
    DEFAULT_PARSE_PROMPT,
    get_default_config,
    parse_recipe_images,
)
from api.core.step_mapping import (  # noqa: E402
    STEP_MAPPING_KEY,
    canonicalize_parsed_recipe,
)

logger = logging.getLogger("capture_fidelity")
logging.basicConfig(level=logging.WARNING)

ARMS = ("production", "baseline")
INPUTS_DIR = _THIS_DIR / "inputs"
EXPECTED_DIR = _THIS_DIR / "expected"
RESULTS_DIR = _THIS_DIR / "results"

# USD per million tokens. Anthropic first-party rates for the production
# model, from the Claude API reference table dated 2026-10-06. No prompt
# caching is used on these paths, so only input and output are priced.
PRICE_USD_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
}


# ---------------------------------------------------------------------------
# Baseline prompts: the production prompt up to its "Rules:" section
# ---------------------------------------------------------------------------


def _schema_only(prompt: str) -> str:
    head, sep, _ = prompt.partition("\nRules:")
    if not sep:
        raise RuntimeError("prompt has no 'Rules:' section; the baseline cut is undefined")
    return head.rstrip() + "\n"


_NOISE_PARAGRAPH = re.compile(r"\nWeb pages often contain.*?\n\n", re.S)

BASELINE_PARSE_PROMPT = _schema_only(DEFAULT_PARSE_PROMPT)
BASELINE_URL_TEXT_PROMPT = _schema_only(
    _NOISE_PARAGRAPH.sub("\n", url_extractor.URL_TEXT_PARSE_PROMPT, count=1)
)
BASELINE_STRUCTURING_PROMPT = _schema_only(url_extractor.INGREDIENT_STRUCTURING_PROMPT)
if "Web pages often contain" in BASELINE_URL_TEXT_PROMPT:
    raise RuntimeError("baseline URL text prompt still carries the noise paragraph")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def arm_prompts(arm: str) -> dict[str, str]:
    """The three prompt texts an arm sends, for provenance in the results."""
    if arm == "production":
        return {
            "parse": DEFAULT_PARSE_PROMPT,
            "url_text": url_extractor.URL_TEXT_PARSE_PROMPT,
            "structuring": url_extractor.INGREDIENT_STRUCTURING_PROMPT,
        }
    return {
        "parse": BASELINE_PARSE_PROMPT,
        "url_text": BASELINE_URL_TEXT_PROMPT,
        "structuring": BASELINE_STRUCTURING_PROMPT,
    }


@contextlib.contextmanager
def _arm_context(arm: str, captured: dict[str, str]) -> Iterator[None]:
    """Swap the URL-path prompts for the baseline arm and capture fetched HTML.

    Harness-only patching of module globals that the production functions
    read at call time; everything is restored on exit. The PDF path takes its
    prompt through ParserConfig instead, so nothing is patched for it.
    """
    saved = (
        url_extractor.URL_TEXT_PARSE_PROMPT,
        url_extractor.INGREDIENT_STRUCTURING_PROMPT,
        url_extractor.fetch_url,
    )
    real_fetch = url_extractor.fetch_url

    def capturing_fetch(url: str, **kwargs: Any) -> str:
        html = real_fetch(url, **kwargs)
        captured["html"] = html
        return html

    url_extractor.fetch_url = capturing_fetch
    if arm == "baseline":
        url_extractor.URL_TEXT_PARSE_PROMPT = BASELINE_URL_TEXT_PROMPT
        url_extractor.INGREDIENT_STRUCTURING_PROMPT = BASELINE_STRUCTURING_PROMPT
    try:
        yield
    finally:
        (
            url_extractor.URL_TEXT_PARSE_PROMPT,
            url_extractor.INGREDIENT_STRUCTURING_PROMPT,
            url_extractor.fetch_url,
        ) = saved


# ---------------------------------------------------------------------------
# Usage-recording client
# ---------------------------------------------------------------------------


class RecordingClient:
    """Duck-types the slice of anthropic.Anthropic the capture paths use.

    Production code calls ``client.messages.create(**kwargs)``; this object
    forwards that to the real SDK and records usage, latency and the raw text
    of every call. Exceptions propagate unchanged so the production error
    classification still runs.
    """

    def __init__(self, inner: anthropic.Anthropic) -> None:
        self._inner = inner
        self.calls: list[dict[str, Any]] = []
        self.messages = self

    def create(self, **kwargs: Any) -> Any:
        prompt_chars = 0
        for message in kwargs.get("messages", []):
            content = message.get("content")
            if isinstance(content, str):
                prompt_chars += len(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        prompt_chars += len(block.get("text", ""))
        started = time.monotonic()
        try:
            message = self._inner.messages.create(**kwargs)
        except Exception as e:
            self.calls.append(
                {
                    "ok": False,
                    "requested_model": kwargs.get("model"),
                    "error": type(e).__name__,
                    "latency_ms": int((time.monotonic() - started) * 1000),
                    "prompt_chars": prompt_chars,
                }
            )
            raise
        latency_ms = int((time.monotonic() - started) * 1000)
        usage = message.usage
        raw_text = "".join(
            getattr(block, "text", "")
            for block in message.content
            if getattr(block, "type", None) == "text"
        )
        self.calls.append(
            {
                "ok": True,
                "requested_model": kwargs.get("model"),
                "model": message.model,
                "stop_reason": message.stop_reason,
                "latency_ms": latency_ms,
                "prompt_chars": prompt_chars,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
                "raw_text": raw_text,
            }
        )
        return message

    def drain(self) -> list[dict[str, Any]]:
        calls, self.calls = self.calls, []
        return calls


def cost_usd(calls: list[dict[str, Any]]) -> float | None:
    """Sum the priced cost of the calls; None if any call's model is unpriced."""
    total = 0.0
    for call in calls:
        if not call.get("ok"):
            continue
        price = PRICE_USD_PER_MTOK.get(call.get("requested_model") or "")
        if price is None:
            return None
        total += call["input_tokens"] * price["input"] / 1_000_000
        total += call["output_tokens"] * price["output"] / 1_000_000
    return round(total, 6)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

_UNICODE_FRACTIONS = {
    "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
    "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅙": "1/6", "⅚": "5/6",
}

_UNIT_ALIASES = {
    "tablespoon": "tbsp", "tbs": "tbsp", "tb": "tbsp", "tbl": "tbsp",
    "teaspoon": "tsp",
    "ounce": "oz",
    "pound": "lb",
    "gram": "g", "gr": "g",
    "liter": "liter", "litre": "liter", "l": "liter",
    "dashes": "dash", "pinches": "pinch", "inches": "inch",
    "leaves": "leaf", "loaves": "loaf",
}


def _norm_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    for symbol, ascii_fraction in _UNICODE_FRACTIONS.items():
        text = text.replace(symbol, f" {ascii_fraction} ")
    text = re.sub(r"[^a-z0-9/]+", " ", text)
    return " ".join(text.split())


def parse_quantity(value: Any) -> tuple[float, float] | str | None:
    """None for absent, (lo, hi) for a number or range, the text otherwise."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    for symbol, ascii_fraction in _UNICODE_FRACTIONS.items():
        text = text.replace(symbol, f" {ascii_fraction}")
    text = text.replace("–", "-").replace("—", "-").replace(" to ", "-")
    text = " ".join(text.split())

    def number(token: str) -> float | None:
        token = token.strip()
        mixed = re.fullmatch(r"(\d+)\s+(\d+)\s*/\s*(\d+)", token)
        if mixed:
            return int(mixed[1]) + int(mixed[2]) / int(mixed[3])
        fraction = re.fullmatch(r"(\d+)\s*/\s*(\d+)", token)
        if fraction:
            return int(fraction[1]) / int(fraction[2])
        if re.fullmatch(r"\d+(?:\.\d+)?", token):
            return float(token)
        return None

    parts = [p for p in text.split("-") if p.strip()]
    if len(parts) == 2:
        lo, hi = number(parts[0]), number(parts[1])
        if lo is not None and hi is not None:
            return (lo, hi)
    single = number(text)
    if single is not None:
        return (single, single)
    return text


def _quantity_equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    return abs(a[0] - b[0]) <= 0.011 and abs(a[1] - b[1]) <= 0.011


def norm_unit(value: Any) -> str | None:
    if value is None:
        return None
    text = _norm_text(value).rstrip(".").strip()
    if not text:
        return None
    if text in _UNIT_ALIASES:
        return _UNIT_ALIASES[text]
    if text.endswith("s") and text[:-1] in _UNIT_ALIASES:
        return _UNIT_ALIASES[text[:-1]]
    if text.endswith("s") and len(text) > 3:
        return text[:-1]
    return text


def _ingredient_name(ingredient: dict[str, Any]) -> str:
    return _norm_text(ingredient.get("name"))


def _ingredient_line(ingredient: dict[str, Any]) -> str:
    parts = [ingredient.get("quantity"), ingredient.get("unit"), ingredient.get("name")]
    line = " ".join(str(p) for p in parts if p not in (None, ""))
    prep = ingredient.get("prep")
    return f"{line}, {prep}" if prep else line


def accepted_pairs(expected: dict[str, Any]) -> list[tuple[Any, Any]]:
    """The (quantity, unit) pairs an expected ingredient accepts.

    Either an explicit ``accept`` list of pairs, or one scalar ``quantity``
    combined with each entry of the ``unit`` list. Quantity and unit are never
    accepted independently of each other, so "25 tbsp" cannot pass a line that
    accepts "25 g" and "2 tbsp".
    """
    if "accept" in expected:
        return [(q, u) for q, u in expected["accept"]]
    if isinstance(expected.get("quantity"), list):
        raise ValueError(f"{expected['source']!r}: a quantity list needs explicit accept pairs")
    return [(expected["quantity"], u) for u in expected["unit"]]


def _fields_ok(pairs: list[tuple[Any, Any]], item: dict[str, Any]) -> tuple[bool, bool]:
    """(quantity_ok, unit_ok) for a produced row against the accepted pairs.

    quantity_ok: some accepted pair has this quantity. unit_ok: some accepted
    pair has this quantity AND this unit; when no pair has the quantity, any
    pair with this unit, so a wrong quantity is reported once, not twice.
    """
    got_q = parse_quantity(item.get("quantity"))
    got_u = norm_unit(item.get("unit"))
    with_quantity = [(q, u) for q, u in pairs if _quantity_equal(parse_quantity(q), got_q)]
    if with_quantity:
        return True, any(norm_unit(u) == got_u for _, u in with_quantity)
    return False, any(norm_unit(u) == got_u for _, u in pairs)


def score_ingredients(case: dict[str, Any], produced: list[dict[str, Any]]) -> dict[str, Any]:
    """One-to-one keyword matching on the structured name, in expected order.

    An expected ingredient matches a produced one when every keyword in its
    ``match`` list appears in the produced ``name`` (raw_text is not consulted,
    so a right raw line cannot hide a wrong structured name). Among several
    candidates the one whose quantity agrees wins, else the first unclaimed.
    A combined source line ("Salt and pepper") lists its other components in
    ``also``; each must appear in the matched row's name or in one further
    unclaimed produced row, which is then claimed. A component found nowhere is
    an omission. Produced rows left over are hallucinations.
    """
    claimed: set[int] = set()
    rows: list[dict[str, Any]] = []
    component_omissions: list[dict[str, Any]] = []
    for expected in case["ingredients"]:
        keywords = [_norm_text(k) for k in expected["match"]]
        candidates = [
            i
            for i, item in enumerate(produced)
            if i not in claimed and all(k in _ingredient_name(item) for k in keywords)
        ]
        row: dict[str, Any] = {"expected": expected["source"], "page": expected["page"]}
        if not candidates:
            row["matched"] = None
            rows.append(row)
            continue
        pairs = accepted_pairs(expected)
        preferred = [i for i in candidates if _fields_ok(pairs, produced[i])[0]]
        index = (preferred or candidates)[0]
        claimed.add(index)
        item = produced[index]
        quantity_ok, unit_ok = _fields_ok(pairs, item)
        row.update(
            {
                "matched": _ingredient_line(item),
                "quantity_ok": quantity_ok,
                "unit_ok": unit_ok,
                "got_quantity": item.get("quantity"),
                "got_unit": item.get("unit"),
            }
        )
        for component in expected.get("also", []):
            words = [_norm_text(k) for k in component]
            if all(w in _ingredient_name(item) for w in words):
                continue
            split = [
                i
                for i, other in enumerate(produced)
                if i not in claimed and all(w in _ingredient_name(other) for w in words)
            ]
            if split:
                claimed.add(split[0])
                row.setdefault("split_rows", []).append(_ingredient_line(produced[split[0]]))
            else:
                component_omissions.append(
                    {"source": expected["source"], "component": " ".join(component), "page": expected["page"]}
                )
        rows.append(row)

    hallucinated = [_ingredient_line(item) for i, item in enumerate(produced) if i not in claimed]
    omitted = [{"source": r["expected"], "page": r["page"]} for r in rows if r["matched"] is None]
    omitted += component_omissions
    return {
        "expected": len(rows),
        "matched": sum(1 for r in rows if r["matched"] is not None),
        "omitted": omitted,
        "omitted_page1": sum(1 for o in omitted if o["page"] == 1),
        "omitted_page2": sum(1 for o in omitted if o["page"] == 2),
        "hallucinated": hallucinated,
        "quantity_errors": [
            {"source": r["expected"], "got": r["got_quantity"]}
            for r in rows
            if r["matched"] is not None and not r["quantity_ok"]
        ],
        "unit_errors": [
            {"source": r["expected"], "got": r["got_unit"]}
            for r in rows
            if r["matched"] is not None and not r["unit_ok"]
        ],
        "rows": rows,
    }


def _step_similarity(expected: str, produced: str) -> tuple[float, float]:
    a, b = _norm_text(expected), _norm_text(produced)
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    tokens_a, tokens_b = set(a.split()), set(b.split())
    recall = len(tokens_a & tokens_b) / len(tokens_a) if tokens_a else 0.0
    return ratio, recall


def _long_enough(expected: str) -> bool:
    # The recall path lets a merged or lightly rewritten step still match, but
    # only for expected steps long enough that shared words mean something.
    return len(_norm_text(expected).split()) >= 6


def _step_matches(expected: str, ratio: float, recall: float) -> bool:
    return ratio >= 0.6 or (_long_enough(expected) and recall >= 0.75)


_NUMBER_TOKEN = re.compile(r"\d+(?:[./]\d+)?")


def _numbers_in(text: str) -> list[str]:
    for symbol, ascii_fraction in _UNICODE_FRACTIONS.items():
        text = text.replace(symbol, f" {ascii_fraction} ")
    return _NUMBER_TOKEN.findall(text)


def score_steps(case: dict[str, Any], produced: list[dict[str, Any]]) -> dict[str, Any]:
    """Text-overlap matching of produced steps to expected steps.

    First pass: greedy best-similarity one-to-one matching. Second pass: an
    expected step still unmatched is accepted as ``merged`` when a produced step
    that is already claimed contains at least 75% of its words, so a faithful
    merge of two source steps is not an omission. A match says the text
    overlaps; it does not verify every word. For matched steps the numbers in
    the expected text (temperatures, times, counts) that are missing from the
    produced text are listed under ``number_mismatches``. Expected steps flagged
    ``optional`` count neither as omissions when absent nor as hallucinations
    when present.
    """
    expected = case["steps"]
    texts = [step.get("instruction") or "" for step in produced]
    pairs: list[tuple[float, int, int]] = []
    for e_idx, exp in enumerate(expected):
        for p_idx, text in enumerate(texts):
            ratio, recall = _step_similarity(exp["text"], text)
            if _step_matches(exp["text"], ratio, recall):
                pairs.append((ratio + recall, e_idx, p_idx))
    pairs.sort(reverse=True)
    matched_expected: dict[int, int] = {}
    claimed: set[int] = set()
    for _, e_idx, p_idx in pairs:
        if e_idx in matched_expected or p_idx in claimed:
            continue
        matched_expected[e_idx] = p_idx
        claimed.add(p_idx)
    merged: set[int] = set()
    for e_idx, exp in enumerate(expected):
        if e_idx in matched_expected or not _long_enough(exp["text"]):
            continue
        best = max(
            ((_step_similarity(exp["text"], texts[p])[1], p) for p in claimed),
            default=(0.0, None),
        )
        if best[1] is not None and best[0] >= 0.75:
            matched_expected[e_idx] = best[1]
            merged.add(e_idx)

    rows = []
    number_mismatches = []
    for e_idx, exp in enumerate(expected):
        p_idx = matched_expected.get(e_idx)
        row = {
            "expected": exp["text"],
            "page": exp["page"],
            "optional": bool(exp.get("optional")),
            "matched": texts[p_idx] if p_idx is not None else None,
            "merged": e_idx in merged,
        }
        if p_idx is not None:
            missing = [n for n in _numbers_in(exp["text"]) if n not in _numbers_in(texts[p_idx])]
            if missing:
                row["numbers_missing"] = missing
                number_mismatches.append({"expected": exp["text"], "missing": missing})
        rows.append(row)
    omitted = [r for r in rows if r["matched"] is None and not r["optional"]]
    required = [r for r in rows if not r["optional"]]
    return {
        "expected_required": len(required),
        "matched": sum(1 for r in required if r["matched"] is not None),
        "merged": sum(1 for r in required if r["merged"]),
        "omitted": [{"text": r["expected"], "page": r["page"]} for r in omitted],
        "omitted_page1": sum(1 for r in omitted if r["page"] == 1),
        "omitted_page2": sum(1 for r in omitted if r["page"] == 2),
        "hallucinated": [texts[i] for i in range(len(texts)) if i not in claimed],
        "number_mismatches": number_mismatches,
        "optional_present": sum(1 for r in rows if r["optional"] and r["matched"] is not None),
        "optional_total": sum(1 for r in rows if r["optional"]),
        "rows": rows,
    }


_RANGE_EXPR = re.compile(r"\d+(?:[./]\d+)?(?:\s+\d+/\d+)?(?:\s*(?:-|–|—|to)\s*\d+(?:[./]\d+)?)?")


def _servings_value(value: Any) -> tuple[float, float] | str | None:
    """The first number or range in a servings string, as parse_quantity gives it."""
    if value is None:
        return None
    text = str(value)
    for symbol, ascii_fraction in _UNICODE_FRACTIONS.items():
        text = text.replace(symbol, f" {ascii_fraction} ")
    match = _RANGE_EXPR.search(text)
    return parse_quantity(match.group(0)) if match else parse_quantity(text)


_TIME_PART = re.compile(
    r"(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|h|minutes?|mins?|m)\b"
)


def _minutes(value: Any) -> tuple[float, float] | None:
    """A duration as a (low, high) range in minutes; "1-2 hours 15 mins" -> (75, 135)."""
    if value is None:
        return None
    text = str(value).lower()
    low = high = 0.0
    found = False
    for lo, hi, unit in _TIME_PART.findall(text):
        found = True
        factor = 60 if unit.startswith("h") else 1
        low += float(lo) * factor
        high += float(hi or lo) * factor
    if found:
        return (low, high)
    numbers = re.findall(r"\d+(?:\.\d+)?", text)
    if len(numbers) == 1:
        return (float(numbers[0]), float(numbers[0]))
    return None


def _field_ok(expected: Any, got: Any, equal) -> bool:
    if expected is None:
        return got is None
    return got is not None and equal(expected, got)


def score_meta(case: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    exp_title, got_title = _norm_text(case["title"]), _norm_text(parsed.get("title"))
    title_ok = bool(got_title) and (
        exp_title in got_title
        or got_title in exp_title
        or difflib.SequenceMatcher(None, exp_title, got_title).ratio() >= 0.6
    )
    return {
        "title_ok": title_ok,
        "servings_ok": _field_ok(
            case["servings"],
            parsed.get("servings"),
            lambda e, g: _quantity_equal(_servings_value(e), _servings_value(g)),
        ),
        "prep_time_ok": _field_ok(
            case["prep_time"], parsed.get("prep_time"), lambda e, g: _minutes(e) == _minutes(g)
        ),
        "cook_time_ok": _field_ok(
            case["cook_time"], parsed.get("cook_time"), lambda e, g: _minutes(e) == _minutes(g)
        ),
        "got": {
            "title": parsed.get("title"),
            "servings": parsed.get("servings"),
            "prep_time": parsed.get("prep_time"),
            "cook_time": parsed.get("cook_time"),
        },
    }


def score_case(case: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    mapping = parsed.get(STEP_MAPPING_KEY) or []
    return {
        "ingredients": score_ingredients(case, parsed.get("ingredients") or []),
        "steps": score_steps(case, parsed.get("steps") or []),
        "meta": score_meta(case, parsed),
        "mapping": {
            "steps": len(mapping),
            "known": sum(1 for m in mapping if isinstance(m, list) and m),
            "empty": sum(1 for m in mapping if m == []),
            "unknown": sum(1 for m in mapping if m is None),
        },
    }


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def load_cases(only: list[str] | None) -> list[dict[str, Any]]:
    cases = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(EXPECTED_DIR.glob("*.json"))]
    for case in cases:
        for expected in case["ingredients"]:
            accepted_pairs(expected)  # fails fast on a malformed expectation
    if only:
        known = {c["id"] for c in cases}
        unknown = sorted(set(only) - known)
        if unknown:
            sys.exit(f"unknown case id(s): {', '.join(unknown)}; known: {', '.join(sorted(known))}")
        cases = [c for c in cases if c["id"] in only]
    return cases


def parser_version() -> str | None:
    text = (_REPO_ROOT / "api" / "routes" / "drafts.py").read_text(encoding="utf-8")
    match = re.search(r'^PARSER_VERSION = "([^"]+)"', text, re.M)
    return match.group(1) if match else None


def run_case(case: dict[str, Any], arm: str, client: RecordingClient) -> dict[str, Any]:
    config = get_default_config()
    if arm == "baseline":
        config = dataclasses.replace(config, prompt=BASELINE_PARSE_PROMPT)
    captured: dict[str, str] = {}
    source: dict[str, Any] = {}
    parsed: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    started = time.monotonic()
    try:
        with _arm_context(arm, captured):
            if case["kind"] == "pdf":
                path = INPUTS_DIR / case["input"]
                data = path.read_bytes()
                source = {"sha256": _sha256(data), "bytes": len(data)}
                # The same two calls /api/drafts/capture makes (api/routes/drafts.py).
                parsed = canonicalize_parsed_recipe(
                    parse_recipe_images([str(path)], client=client, config=config, logger=logger)
                )
            else:
                # The same call /api/drafts/capture-url makes.
                parsed = url_extractor.extract_recipe_from_url(
                    case["input"], client=client, config=config, logger=logger
                )
    except Exception as e:  # noqa: BLE001 - a failed capture is a result, not a crash
        error = {"type": type(e).__name__, "message": str(e)[:300]}
    finally:
        if case["kind"] == "url" and "html" in captured:
            html = captured["html"]
            jsonld = url_extractor.extract_jsonld_recipe(html)
            source = {
                "sha256": _sha256(html.encode("utf-8")),
                "html_chars": len(html),
                "jsonld": jsonld is not None,
                # What the model path consumed: the JSON-LD recipe, or the
                # extracted page text the text-fallback prompt was given.
                "model_input": jsonld if jsonld is not None else url_extractor.extract_recipe_text(html),
            }
    wall_ms = int((time.monotonic() - started) * 1000)
    calls = client.drain()
    return {
        "arm": arm,
        "case": case["id"],
        "kind": case["kind"],
        "input": case["input"],
        "source": source,
        "requested_model": config.model,
        "wall_ms": wall_ms,
        "calls": calls,
        "cost_usd": cost_usd(calls),
        "error": error,
        "parsed": parsed,
        "score": score_case(case, parsed) if parsed is not None else None,
    }


def _one_line(row: dict[str, Any]) -> str:
    if row["score"] is None:
        return (
            f"run {row['run']} {row['arm']:<10} {row['case']:<32} FAILED "
            f"{row['error']['type']}: {row['error']['message'][:80]}"
        )
    ing, steps = row["score"]["ingredients"], row["score"]["steps"]
    tokens_in = sum(c.get("input_tokens", 0) for c in row["calls"] if c.get("ok"))
    tokens_out = sum(c.get("output_tokens", 0) for c in row["calls"] if c.get("ok"))
    return (
        f"run {row['run']} {row['arm']:<10} {row['case']:<32} "
        f"ing {ing['matched']}/{ing['expected']} "
        f"(p1-miss {ing['omitted_page1']} p2-miss {ing['omitted_page2']} "
        f"halluc {len(ing['hallucinated'])} qty-err {len(ing['quantity_errors'])} "
        f"unit-err {len(ing['unit_errors'])}) "
        f"steps {steps['matched']}/{steps['expected_required']} "
        f"(p1-miss {steps['omitted_page1']} p2-miss {steps['omitted_page2']} "
        f"halluc {len(steps['hallucinated'])}) "
        f"{len(row['calls'])} call(s) {tokens_in}in/{tokens_out}out "
        f"{row['wall_ms'] / 1000:.1f}s ${row['cost_usd'] if row['cost_usd'] is not None else '?'}"
    )


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct / 100 * (len(ordered) - 1))))
    return ordered[index]


def summarize(rows: list[dict[str, Any]]) -> str:
    out: list[str] = []
    arms = [a for a in ARMS if any(r["arm"] == a for r in rows)]
    out.append("| Metric | " + " | ".join(arms) + " |")
    out.append("|---|" + "---|" * len(arms))

    def line(label: str, fn) -> None:
        out.append(f"| {label} | " + " | ".join(str(fn([r for r in rows if r['arm'] == a])) for a in arms) + " |")

    def scored(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [r["score"] for r in group if r["score"] is not None]

    def ok_calls(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [c for r in group for c in r["calls"] if c.get("ok")]

    line("captures attempted", lambda g: len(g))
    line("captures failed (no draft)", lambda g: sum(1 for r in g if r["score"] is None))
    line("ingredients expected", lambda g: sum(s["ingredients"]["expected"] for s in scored(g)))
    line("ingredients omitted, page 1 (model miss)", lambda g: sum(s["ingredients"]["omitted_page1"] for s in scored(g)))
    line("ingredients omitted, page 2 (never rendered)", lambda g: sum(s["ingredients"]["omitted_page2"] for s in scored(g)))
    line("ingredients hallucinated", lambda g: sum(len(s["ingredients"]["hallucinated"]) for s in scored(g)))
    line("quantity errors on matched ingredients", lambda g: sum(len(s["ingredients"]["quantity_errors"]) for s in scored(g)))
    line("unit errors on matched ingredients", lambda g: sum(len(s["ingredients"]["unit_errors"]) for s in scored(g)))
    line("steps expected", lambda g: sum(s["steps"]["expected_required"] for s in scored(g)))
    line("steps omitted, page 1 (model miss)", lambda g: sum(s["steps"]["omitted_page1"] for s in scored(g)))
    line("steps omitted, page 2 (never rendered)", lambda g: sum(s["steps"]["omitted_page2"] for s in scored(g)))
    line("steps hallucinated", lambda g: sum(len(s["steps"]["hallucinated"]) for s in scored(g)))
    line("steps matched as a merge of two source steps", lambda g: sum(s["steps"]["merged"] for s in scored(g)))
    line("matched steps missing a number from the source", lambda g: sum(len(s["steps"]["number_mismatches"]) for s in scored(g)))
    line("optional source steps present", lambda g: f"{sum(s['steps']['optional_present'] for s in scored(g))}/{sum(s['steps']['optional_total'] for s in scored(g))}")
    line("title ok", lambda g: f"{sum(1 for s in scored(g) if s['meta']['title_ok'])}/{len(scored(g))}")
    line("servings ok", lambda g: f"{sum(1 for s in scored(g) if s['meta']['servings_ok'])}/{len(scored(g))}")
    line("prep time ok", lambda g: f"{sum(1 for s in scored(g) if s['meta']['prep_time_ok'])}/{len(scored(g))}")
    line("cook time ok", lambda g: f"{sum(1 for s in scored(g) if s['meta']['cook_time_ok'])}/{len(scored(g))}")
    line("mapping: steps known / empty / unknown", lambda g: " / ".join(str(sum(s["mapping"][k] for s in scored(g))) for k in ("known", "empty", "unknown")))
    line("model calls", lambda g: len(ok_calls(g)))
    line("input tokens", lambda g: sum(c["input_tokens"] for c in ok_calls(g)))
    line("output tokens", lambda g: sum(c["output_tokens"] for c in ok_calls(g)))
    line("latency per call, median s", lambda g: f"{statistics.median([c['latency_ms'] for c in ok_calls(g)]) / 1000:.1f}" if ok_calls(g) else "-")
    line("latency per call, p95 s", lambda g: f"{_percentile([c['latency_ms'] for c in ok_calls(g)], 95) / 1000:.1f}" if ok_calls(g) else "-")
    line("wall time per capture, median s", lambda g: f"{statistics.median([r['wall_ms'] for r in g]) / 1000:.1f}" if g else "-")
    line("cost, total USD", lambda g: f"{sum(r['cost_usd'] or 0 for r in g):.4f}")
    line("cost per capture, USD", lambda g: f"{sum(r['cost_usd'] or 0 for r in g) / len(g):.4f}" if g else "-")

    out.append("")
    out.append("| Case | Arm | Run | Ingredients matched | Omitted p1/p2 | Halluc. | Qty err | Unit err | Steps matched | Omitted p1/p2 | Halluc. | Calls | Tokens in/out | Wall s | USD |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted(rows, key=lambda r: (r["case"], r["arm"], r["run"])):
        tokens_in = sum(c.get("input_tokens", 0) for c in r["calls"] if c.get("ok"))
        tokens_out = sum(c.get("output_tokens", 0) for c in r["calls"] if c.get("ok"))
        if r["score"] is None:
            out.append(f"| {r['case']} | {r['arm']} | {r['run']} | FAILED: {r['error']['type']} | | | | | | | | {len(r['calls'])} | {tokens_in}/{tokens_out} | {r['wall_ms'] / 1000:.1f} | {r['cost_usd'] if r['cost_usd'] is not None else '?'} |")
            continue
        ing, steps = r["score"]["ingredients"], r["score"]["steps"]
        out.append(
            f"| {r['case']} | {r['arm']} | {r['run']} | {ing['matched']}/{ing['expected']} | "
            f"{ing['omitted_page1']}/{ing['omitted_page2']} | {len(ing['hallucinated'])} | "
            f"{len(ing['quantity_errors'])} | {len(ing['unit_errors'])} | "
            f"{steps['matched']}/{steps['expected_required']} | {steps['omitted_page1']}/{steps['omitted_page2']} | "
            f"{len(steps['hallucinated'])} | {len(r['calls'])} | {tokens_in}/{tokens_out} | "
            f"{r['wall_ms'] / 1000:.1f} | {r['cost_usd'] if r['cost_usd'] is not None else '?'} |"
        )
    return "\n".join(out)


def rescore(path: Path) -> list[dict[str, Any]]:
    cases = {c["id"]: c for c in load_cases(None)}
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        row = json.loads(raw)
        if row.get("parsed") is not None:
            row["score"] = score_case(cases[row["case"]], row["parsed"])
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arm", choices=(*ARMS, "all"), default="all")
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--case", action="append", help="case id from expected/; repeatable")
    parser.add_argument("--out", type=Path, help="results file (default results/fidelity_<UTC stamp>.jsonl)")
    parser.add_argument("--rescore", type=Path, help="re-score an existing results file offline; no API calls. With --out, writes the re-scored rows there (scores only change)")
    args = parser.parse_args()

    if args.rescore:
        rows = rescore(args.rescore)
        if args.out:
            # Rewrite the score fields only; parsed output and raw text are untouched.
            with args.out.open("w", encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        print(summarize(rows))
        return

    if "ANTHROPIC_API_KEY" not in os.environ:
        sys.exit("ANTHROPIC_API_KEY is not set in the environment (presence check only).")

    cases = load_cases(args.case)
    arms = ARMS if args.arm == "all" else (args.arm,)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = args.out or (RESULTS_DIR / f"fidelity_{stamp}.jsonl")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    client = RecordingClient(anthropic.Anthropic())
    version = parser_version()
    prompt_hashes = {
        arm: {name: _sha256(text.encode("utf-8")) for name, text in arm_prompts(arm).items()}
        for arm in arms
    }
    rows: list[dict[str, Any]] = []
    with out_path.open("w", encoding="utf-8") as fh:
        for run_no in range(1, args.runs + 1):
            for arm in arms:
                for case in cases:
                    row = run_case(case, arm, client)
                    row.update(
                        {
                            "run": run_no,
                            "stamp": stamp,
                            "parser_version": version,
                            "prompt_sha256": prompt_hashes[arm],
                        }
                    )
                    fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                    fh.flush()
                    rows.append(row)
                    print(_one_line(row), flush=True)

    print()
    print(summarize(rows))
    print(f"\nresults: {out_path}")


if __name__ == "__main__":
    main()
