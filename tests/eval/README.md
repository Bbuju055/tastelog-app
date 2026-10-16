# tests/eval — Riff prompt evals (Phase 13.4.C)

This directory holds the eval harness used to score `RIFF_SYSTEM_PROMPT_TEMPLATE`
(`api/core/riff.py`) against the case set defined in
`docs/phase13-4-A-riff-prompt-audit.md` (§9 / §10).

It is **not** part of the pytest suite. Eval runs are manual, iterative,
and gated by user review.

---

## Files

| File | Purpose |
|---|---|
| `riff_eval_recipes.py` | Three deterministic source recipes + the case registry (`EVAL_CASES`, `RECIPES_BY_ID`). Hand-authored fixtures, schema-aligned with what `core.recipes.get_recipe` returns. |
| `run_riff_baseline.py` | Harness script. Imports the production prompt + production `run_riff_turn` + production `extract_recipe_block`. Runs every case once against the current prompt and writes a JSONL transcript to `runs/`. |
| `runs/` | JSONL transcripts and (optionally) committed scorecard markdown. Created on first run. |

`runs/` is intended for committed scorecards only — JSONL transcripts may
contain raw model output and are not required to be committed. Add to
`.gitignore` if your workflow benefits.

---

## Required environment

`ANTHROPIC_API_KEY` must be set in the environment that runs the harness.
The Anthropic SDK reads it directly. The script:

- never reads the key value into a local variable
- never prints it
- never writes it to disk
- never includes any environment dump in JSONL output

**Do not echo, log, or commit secrets.** Avoid commands that print env
values (e.g. `env`, `printenv ANTHROPIC_API_KEY`, `echo $ANTHROPIC_API_KEY`).

---

## Running the baseline

From the repo root:

```bash
api/.venv/bin/python tests/eval/run_riff_baseline.py
```

The script will:

1. Verify `ANTHROPIC_API_KEY` is present (presence check only — value is
   never read).
2. Load every case in `EVAL_CASES`.
3. For each case, build the system prompt via the production
   `build_riff_system_prompt`, call `run_riff_turn` once with a single-turn
   user message, and extract any fenced recipe-json block via the
   production `extract_recipe_block`.
4. Write one JSONL row per case to
   `tests/eval/runs/baseline_<UTC-timestamp>.jsonl`.

A typical run is ~14 calls and finishes in 2–5 minutes. Cost is
negligible at Sonnet 4 pricing for the corpus volume here.

The harness uses **single-turn history only** (the user message is the
only entry). Multi-turn conversation behavior is not in scope for the
13.4.C baseline.

---

## JSONL row schema

Each line in `baseline_*.jsonl` is one case:

| Field | Type | Description |
|---|---|---|
| `recipe_id` | string | One of the three source-recipe IDs in `RECIPES_BY_ID`. |
| `case_id` | string | Stable case identifier (`C01`–`C14`). |
| `anchor` | string | The 13.4.A §9 case anchor (`E1`–`E12`, `E_DIAB`). |
| `user_turn` | string | The single-turn user message sent to Claude. |
| `expected_shape` | enum | `recipe_json` / `prose_only` / `either`. |
| `raw_text` | string | Full assistant reply as returned by `run_riff_turn`. |
| `raw_text_excerpt` | string | Whitespace-collapsed first ~280 chars for spot-checks. |
| `block_present` | bool | Whether the assistant text contains an opening recipe-json fence. |
| `block_validates` | bool | Whether `extract_recipe_block` returned a validated `ParsedRecipe` dict. |
| `response_word_count_outside_block` | int | Word count of prose with the fenced block stripped. |
| `response_paragraph_count_outside_block` | int | Number of non-empty `\n\n`-separated chunks in the same prose. |
| `banned_phrasing_hits` | string[] | Subset of the §4 banned phrasings present (lowercased substring match). |
| `question_mark_present_in_prose` | bool | Whether the prose contains any `?`. |

The JSONL file does **not** include any environment data, the API key,
or any internal IDs beyond the deterministic case / recipe IDs above.

---

## Scoring (manual for the first revision pass)

13.4.A §9 explicitly calls for manual scoring on the first pass:

> Each case is scored manually for the first revision pass; future automation deferred (Phase 13.6+ or post-Riff).

The scorecard sits in `runs/baseline_<timestamp>.scorecard.md` (or in
chat for the first session) and tags each case against the eight
acceptance gates G1–G8 from 13.4.A §10. Mechanical signals from the
JSONL fields drive G1, G2, G4, G7, and G8 partially; G3, G5, G6, and the
qualitative dimensions of G4/G7 require a human read of `raw_text`.

A revision is accepted (per 13.4.A §11 step 5) only when **all** G1–G8
gates pass and **no** baseline-passing case regresses.

---

## Hard scope reminders for this directory

This eval scaffolding is for prompt revision only. It must not:

- modify `RIFF_SYSTEM_PROMPT_TEMPLATE` before the baseline scorecard is reported and accepted
- modify the recipe-json fence syntax or `_RECIPE_BLOCK_PATTERN`
- modify the `ParsedRecipe` schema
- modify the mobile `RECIPE_BLOCK_REGEX`
- introduce new dependencies
- write streaming code
- touch any production file outside `api/core/riff.py` (and that file is
  off-limits until baseline acceptance)
