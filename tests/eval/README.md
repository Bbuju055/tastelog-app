# tests/eval — model-path evals (manual, not pytest)

Two hand-run harnesses that call the real model through the production
code paths and write a JSONL transcript per run. Neither is collected by
pytest; both need `ANTHROPIC_API_KEY` and spend money. Their results are
reported separately and must not be added together: the mapping gate
scores step-to-ingredient associations, the riff baseline scores the
chat prompt's output shape.

| Harness | What it scores | Calls per run | Cases |
|---|---|---|---|
| `run_mapping_eval.py` | the four production paths that attach ingredients to steps | 24 | 3 recipes × 4 paths × 2 runs |
| `run_riff_baseline.py` | `RIFF_SYSTEM_PROMPT_TEMPLATE` in `api/core/riff.py` | 14 | 14 single-turn cases over 3 recipes |

The model is `DEFAULT_CLAUDE_MODEL` in `api/core/anthropic_client.py`.
Transcripts land in `runs/` (gitignored: they hold raw model output).

---

## Files

| File | Purpose |
|---|---|
| `mapping_eval_recipes.py` | Three adversarial recipes with golden step → ingredient sets (`MAPPING_EVAL_RECIPES`), plus the renderers the paths consume. |
| `fixtures/R*.png` | The same three recipes rendered to PNG for the vision path. Fixtures of record; `make_mapping_fixture_images.py` regenerates them. |
| `run_mapping_eval.py` | Mapping quality gate. Prints a per-cell verdict table and PASS/FAIL; exit code follows the gate. |
| `riff_eval_recipes.py` | Three source recipes in the `get_recipe` shape plus the 14-case registry (`EVAL_CASES`, `RECIPES_BY_ID`). |
| `run_riff_baseline.py` | Riff prompt baseline. Runs every case once through the production `run_riff_turn` and records mechanical signals. |
| `runs/` | JSONL transcripts, created on first run. |

---

## Required environment

`ANTHROPIC_API_KEY` must be set in the environment that runs a harness.
The Anthropic SDK reads it directly. Both scripts:

- never read the key value into a local variable
- never print it
- never write it to disk
- never include any environment dump in JSONL output

**Do not echo, log, or commit secrets.** Avoid commands that print env
values (`env`, `printenv ANTHROPIC_API_KEY`, `echo $ANTHROPIC_API_KEY`).

---

## Mapping quality gate

```bash
api/.venv/bin/python tests/eval/run_mapping_eval.py
```

Runs the four real mapping-producing paths over the fixture corpus:

| Path | Production function | Input |
|---|---|---|
| `vision` | `parse_recipe_image` | `fixtures/<recipe>.png` |
| `url_text` | `parse_recipe_from_text` with `URL_TEXT_PARSE_PROMPT` | `recipe_text(recipe)`; nothing is fetched |
| `jsonld_mapper` | `map_ingredients_to_steps` | structured rows with `raw_text` (JSON-LD shape) |
| `riff_mapper` | `map_ingredients_to_steps` | structured rows without `raw_text` (riff shape) |

Each step's golden is a list of accepted sets of fixture ingredient
positions; a produced set passes only if it equals one of them. The
corpus covers exact names, shorthand, collective references ("the dry
ingredients"), repeats, near-duplicate rows, same-head traps (white vs
brown sugar), ranges, "to taste", non-ASCII names, genuine no-ingredient
steps and a step with more than four ingredients.

The gate is binding and the script exits 1 when it fails:

- **a.** zero false positives anywhere (a superset or a foreign ingredient fails);
- **b.** expected associations present on **both** runs of every cell;
- **c.** golden-empty steps come back authoritative-empty, never unknown;
- **d.** malformed output never surfaces as authoritative (the production four-state validators run in-path; the harness additionally asserts only list or `None` shapes appear);
- **e.** extraction equivalence on `vision` and `url_text`: every fixture ingredient aligns to exactly one extracted ingredient and step counts match.

Each row of `runs/mapping_<UTC-timestamp>.jsonl` is one (run, recipe,
path) cell:

| Field | Type | Description |
|---|---|---|
| `run` | int | 1 or 2. |
| `recipe` | string | `R1_cookies`, `R2_noodles` or `R3_alfredo`. |
| `path` | string | One of the four paths above. |
| `produced` | list | Per-step ingredient positions as the path returned them, `null` for unknown. |
| `extraction_ok` | bool | Criterion e (always true for the mapper paths). |
| `shape_ok` | bool | Criterion d. |
| `false_positives`, `misses`, `empty_wrong`, `unknown_steps` | int | Counts behind the verdict. |
| `step_verdicts` | list | Per step: `got`, `accepted`, and `pass` / `miss` / `false_positive` / `fp_on_empty` / `unknown`. |
| `pass` | bool | Cell verdict. |
| `debug` | object | Extracted ingredient names and quantities for the extraction paths. |

---

## Riff prompt baseline

```bash
api/.venv/bin/python tests/eval/run_riff_baseline.py
```

For each case the script builds the system prompt with the production
`build_riff_system_prompt`, calls `run_riff_turn` once with a single-turn
history, and extracts any fenced `recipe-json` block with the production
`extract_recipe_block`. One JSONL row per case goes to
`runs/baseline_<UTC-timestamp>.jsonl`. Multi-turn behaviour is out of
scope.

The 14 cases are anchored to the edit kinds the prompt must handle, spread
over three source recipes (Italian pasta, sheet-pan chicken, cornmeal
fish) so cuisine drift is visible. Every anchor runs once except E11,
which runs on two recipes:

| Anchor | User turn (shape expected) |
|---|---|
| E1 | make it dairy-free (block) |
| E2 | make this gluten-free (block) |
| E3 | double this for 8 people (block) |
| E4 | I only have chicken thighs, not breasts (either) |
| E5 | make it spicier (either) |
| E6 | can I bake this instead of pan-frying? (block) |
| E7 | what can I use instead of heavy cream? (prose) |
| E8 | make it vegetarian (block) |
| E9 | I only have 30 minutes (either) |
| E10 | make this less salty (either) |
| E11 | turn this into meal prep (block) |
| E12 | what should I serve with this? (prose) |
| E_DIAB | make it diabetic-friendly (either) |

Each row:

| Field | Type | Description |
|---|---|---|
| `recipe_id` | string | One of the three source-recipe IDs in `RECIPES_BY_ID`. |
| `case_id` | string | Stable case identifier (`C01`–`C14`). |
| `anchor` | string | The anchor above. |
| `user_turn` | string | The single-turn user message sent. |
| `expected_shape` | enum | `recipe_json` / `prose_only` / `either`. |
| `raw_text` | string | Full assistant reply. |
| `raw_text_excerpt` | string | Whitespace-collapsed first ~280 chars for spot-checks. |
| `block_present` | bool | The reply contains an opening `recipe-json` fence. |
| `block_validates` | bool | `extract_recipe_block` returned a validated `ParsedRecipe` dict. |
| `response_word_count_outside_block` | int | Word count of the prose with the fenced block stripped. |
| `response_paragraph_count_outside_block` | int | Non-empty `\n\n`-separated chunks in that prose. |
| `banned_phrasing_hits` | string[] | Which of the banned phrasings below appear (lowercased substring match). |
| `question_mark_present_in_prose` | bool | The prose contains a `?`. |

### Scoring

Scoring is manual on a read of `raw_text`; the mechanical fields narrow
the read. A prompt revision is accepted only when every gate passes and
no case that passed on the baseline regresses:

| Gate | Criterion | Mechanical signal |
|---|---|---|
| G1 block validity | every emitted block parses and validates as `ParsedRecipe` | `block_present` ⇒ `block_validates` |
| G2 block expectations | blocks appear exactly when `expected_shape` says so (`either` is not gated) | `block_present` vs `expected_shape` |
| G3 preservation | no unrelated ingredient or step rewritten; cuisine and flavour kept unless the user asked to change them | human read |
| G4 brevity | prose-only replies ≤3 short paragraphs; around a block ≤2 | paragraph count, plus a read |
| G5 substitution grounding | a swap is explained by the ingredient's role in this recipe, not a generic list | human read |
| G6 scaling completeness | a timing or equipment note whenever the change is material (doubling or halving a pan-cooked recipe; 3× or more in the oven) | human read |
| G7 no filler | zero banned phrasings | `banned_phrasing_hits` empty |
| G8 clarification discipline | no clarifying question except on a deliberately ambiguous case | `question_mark_present_in_prose` |

Banned phrasings (the list in `run_riff_baseline.py`): "Certainly!",
"Of course!", "Great question", "Absolutely!", "Here are several
options", "It depends", "I'd suggest considering", "Feel free to".

---

## Scope

Both harnesses are regression suites for the model paths they exercise.
Rerun the relevant one before changing `RIFF_SYSTEM_PROMPT_TEMPLATE`,
the `recipe-json` fence handling, the `ParsedRecipe` schema, the mapping
prompt or the four-state mapping validators, and compare against the
previous transcript. They introduce no dependencies and touch no
production file.
