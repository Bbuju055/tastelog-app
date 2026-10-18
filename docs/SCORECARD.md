# Capture fidelity scorecard

**Descriptive, small N.** Nine real inputs, two prompt arms, two runs each: 36
captures, 40 model calls, 65 cents. These numbers say what happened to these
inputs on 2026-10-18; they are not a benchmark and they do not generalise.
Every score and every cost or latency figure below is computed from the
committed results file and can be recomputed offline; what the model was shown
is preserved for the PDFs (the files) and for the Wikibooks page (its extracted
text), but only as a hash for the Cooking Classy page.

| | |
|---|---|
| Model | `claude-sonnet-4-6` (`DEFAULT_CLAUDE_MODEL`, `api/core/anthropic_client.py`), response `stop_reason` `end_turn` on every call |
| Prompt version | `PARSER_VERSION` `"1.1"` (`api/routes/drafts.py`); prompt SHA-256s are stored per row |
| Code paths | exactly what `/api/drafts/capture` and `/api/drafts/capture-url` run: `parse_recipe_images` + `canonicalize_parsed_recipe` for a PDF, `extract_recipe_from_url` for a URL |
| Inputs | 7 PDFs printed from recipe sites (4 are two pages long; 3 of those have ingredients or steps on page 2), 1 URL with JSON-LD, 1 URL without; `tests/eval/fidelity/inputs/` |
| Expected answers | hand-written from the source text, whole recipe including page 2; `tests/eval/fidelity/expected/` |
| Results | `tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl`, one row per capture with every call's raw model text |
| Run | 2026-10-18 21:38 UTC |
| Prices | $3.00 input / $15.00 output per million tokens for Sonnet 4.6, Anthropic's first-party rate as listed in the Claude API reference that ships with Claude Code (model table dated 2026-10-06). Not re-checked against platform.claude.com in this session. No prompt caching is used on these paths. |

## Headline

On clean printed recipe pages the production prompt kept every ingredient it
was shown and invented none: across 202 expected ingredient instances there
were zero page-1 omissions, zero hallucinations and zero unit errors, and
title, servings, prep and cook time were right in 18 of 18 captures. The 4
quantity errors are one pattern twice over: "Juice from 1/4 lemon" and "Juice
from 1 lemon" came back as `lemon juice` with no quantity, the amount kept in
`raw_text` but lost from the structured field, in both arms and both runs.
Every loss in the ingredient and step counts traces to one pipeline limit: a
PDF is rendered as its first page only, so 2 ingredient instances and 38 step
instances that sit on page 2 never reached the model. The one model failure is
real and repeatable: shown a page with ingredient-group headers and no
instructions, the production prompt wrote 7 and then 6 plausible steps that are
not in the source, with confidence 0.82. The baseline prompt, the same prompt
with its rules removed, returned no steps on that page both times. What the
rules buy is cleaner unit fields, 16 baseline unit errors against 0, at about
345 extra input tokens per call.

## Results, production arm, N = 18 captures

| Metric | Production | Baseline |
|---|---|---|
| Captures that produced a draft | 18 / 18 | 18 / 18 |
| Ingredient instances expected | 202 | 202 |
| Ingredients omitted, on the rendered page (model miss) | 0 | 0 |
| Ingredients omitted, on page 2 (never rendered) | 2 | 2 |
| Ingredients hallucinated | 0 | 0 |
| Quantity errors on matched ingredients | 4 | 4 |
| Unit errors on matched ingredients | 0 | 16 |
| Step instances expected | 104 | 104 |
| Steps omitted, on the rendered page (model miss) | 0 | 0 |
| Steps omitted, on page 2 (never rendered) | 38 | 38 |
| Steps hallucinated | 13 | 0 |
| Matched steps missing a number from the source (temperature, time, count) | 0 | 0 |
| Title / servings / prep time / cook time correct | 18 / 18 each | 18 / 18 each |
| Step mapping recorded: known / empty / unknown | 59 / 20 / 2 | 50 / 16 / 2 |

A "matched" step means the produced text overlaps the source step (sequence
ratio 0.6 or word recall 0.75); it is not a word-for-word check. Numbers in the
source step that are missing from the matched output are counted separately,
in the row below the hallucinations, and the match stands. Step mapping is recorded,
not scored: `tests/eval/run_mapping_eval.py` owns that gate. The two unknowns are the same step both times, "Repeat the process to
make the other sandwiches", which the four-state contract says should be
unknown rather than guessed.

## Cost and latency, production arm

| | PDF capture (1 call) | URL with JSON-LD (2 calls) | URL without JSON-LD (1 call) | All |
|---|---|---|---|---|
| Captures | 14 | 2 | 2 | 18 |
| Input tokens per capture | 2,142 every time (page image about 1,590 + prompt) | 1,454 | 2,541 | |
| Output tokens per capture | 233 to 1,826, by recipe length | 781 | 1,425 to 1,432 | |
| Cost per capture, USD | 0.0099 to 0.0338, mean 0.0179 | 0.0161 | 0.0290 to 0.0291 | mean 0.0189 |
| Wall time per capture, s | 4.5 to 24.8 | 8.5 to 8.9 | 15.4 to 15.5 | median 11.2 |

Per model call: median 10.8 s, p95 24.0 s. Wall time includes the PDF render
or the page fetch. Output length drives both cost and latency; the 24 s cases
are the Bourguignon's 19 ingredients and 5 long steps, about 1,800 output
tokens. Total for the production arm: 37,978 input tokens, 15,087 output
tokens, $0.3402. Both arms together: $0.6483.

## Baseline: what the prompt rules buy

The baseline arm is the production prompt cut at its "Rules:" line, so the
model sees the same schema example and nothing else (the URL text prompt also
loses its paragraph about ignoring blog noise; the ingredient-structuring
prompt on the JSON-LD path is cut the same way; the step mapper is unchanged).

- **Same ingredient recall and precision.** Ingredient omissions,
  hallucinations and quantity errors, and the four metadata fields, are
  identical in both arms. On these inputs the rules did not change which
  ingredients the model found. Steps differ: see the third point.
- **Cleaner unit fields.** Without the rules the model packs parentheticals
  into the unit: `medium (12 oz)`, `cups (500g)`, `tbsp (15g)`, `liters
  (roughly 5¼ cups)`, `slice per person`. 16 such units across 18 captures,
  all on the Wikibooks text and the cucumber line; production had none.
  Cleaner is not the same as scalable. The web app's ingredient classifier
  (`tastelog-web/src/lib/ingredients/classifyIngredient.ts`) knows volume and
  weight units, eggs and containers, so all 16 baseline values fall through as
  "unparsed", but so do production's counterparts on 6 of those 16 lines (the
  cucumber with no unit, the bread in `slice`). The scaling gain is the other
  10 lines, where production's `cups`, `tbsp`, `liters` and `cup` scale and the
  baseline's `cups (500g)` and `tbsp (15g)` do not.
- **No invented steps.** On the page with headers and no instructions the
  baseline returned an empty step list both times; production invented steps
  both times. One case, two runs, so this is an observation, not a finding
  about prompts in general.
- **Price of the rules.** 345 more input tokens per PDF call (2,142 against
  1,797), about $0.001; cost per capture $0.0189 against $0.0171.

## Three real failures, with raw output

### 1. Invented steps from ingredient-group headers

`french_onion_soup.pdf`, production arm, both runs. Page 1 holds 14 ingredient
lines under two headers that read like instructions, "Sauté the Onions to
caramelize them before you add them to the soup:" and "In the Soup Pot:", and
no steps; the six real steps are on page 2. The model returned this, confidence
0.82 (run 1, `steps` field verbatim):

```json
"steps":[
 {"position":1,"instruction":"Sauté the onions to caramelize them: heat sweet butter and extra virgin olive oil in a pan, then add the onions and shallots and cook until caramelized.","ingredient_positions":[1,2,3,4]},
 {"position":2,"instruction":"In the soup pot, melt the unsalted sweet butter, then add the flour and cook briefly to make a roux.","ingredient_positions":[5,6]},
 {"position":3,"instruction":"Add the leeks to the soup pot and sauté until softened.","ingredient_positions":[7]},
 {"position":4,"instruction":"Deglaze with the Sherry Wine and Port Wine.","ingredient_positions":[8,9]},
 {"position":5,"instruction":"Add the caramelized onions and shallots to the soup pot along with the Beef Stock and Vegetable or Chicken Stock.","ingredient_positions":[3,4,10,11]},
 {"position":6,"instruction":"Season with salt and pepper to taste and simmer the soup.","ingredient_positions":[12]},
 {"position":7,"instruction":"Ladle the soup into bowls, top with slices of French Bread and grated Swiss Cheese, then broil until the cheese is melted and bubbly.","ingredient_positions":[13,14]}
]
```

None of these sentences exists in the source. "Deglaze with the Sherry Wine
and Port Wine" and "broil until the cheese is melted and bubbly" are culinary
knowledge, not extraction. The prompt's rule "Keep step instructions as
complete sentences from the original" did not hold, and the mapping was then
assigned with full confidence. Run 2 produced six steps of the same kind. The
user would see a complete-looking draft with a wrong method.

### 2. A truncated recipe that looks finished

`beef_bourguignon.pdf`, production arm, both runs. All 19 ingredients and steps
1 to 5 are on page 1; steps 6 to 14 are on page 2 and were never rendered. The
model did its job on what it saw: 19 of 19 ingredients, 5 of 5 visible steps,
servings `3-8 people`, prep `15 mins`, cook `3 hrs`, confidence 0.88. The draft
ends at:

```
Add the pearl onions, wine and enough stock so that the meat is barely covered.
Then add the tomato paste, bullion and herbs. Bring to a simmer on the stove.
```

Nothing in the draft or the confidence value tells the user that nine steps,
the whole oven stage and the mushrooms, are missing. The failure is the
pipeline's page-1 limit (`api/core/image_encoding.py`, `_encode_pdf`), not the
model, and the client caps a capture at five images, so a user who shared
page 2 as a separate photo would have been served.

### 3. Fifteen ingredients, no steps, confidence 0.82

`halal_guys_sauces.pdf`, production arm, both runs. Both sauce ingredient lists
are on page 1, every instruction on page 2. The model found all 15
ingredients (two of them, the lemon-juice lines, without their quantity) and
returned an empty step list, which is the honest answer for the page it was
shown:

```json
..."raw_text":"Juice from 1 lemon"},{"quantity":"100","unit":"g","name":"water","prep":null,"raw_text":"100 g water"}],"steps":[],"confidence":0.82}
```

Same page-1 limit as failure 2, but it shows the other half of the problem:
`confidence` measures how well the page was read, not whether a recipe is
complete, so a draft with no method at all still scores 0.82. The clients do
handle the empty state once the draft is saved (the mobile recipe screen
disables its Cook button when there are no steps, the web detail view shows
"No steps provided."), but nothing at capture time tells the user that the
method existed and was never read.

## What went right that was worth checking

- The Avocado Salad PDF is the site's 2-serving scaling of the recipe, with
  quantities like `0.33 medium English cucumber` and `0.08 cup chopped
  cilantro`. Production preserved every decimal exactly on both runs, and the
  same recipe fetched live at 6 servings through the JSON-LD path was also
  13 of 13 and 3 of 3.
- The Wikibooks page has no JSON-LD, mixes the recipe with a history section
  and wiki navigation, and the text extractor puts linked words (`saucepan`,
  `fond`, `boil`) on their own lines. The text-fallback path returned 11 of 11
  ingredients and 9 of 9 steps, joined correctly, on both runs.
- Group headers inside the Halal Guys ingredient list (`White Sauce`, `Red
  Hot Sauce`) were not emitted as ingredients.

## Caveats

- Nine inputs, two runs, one model. The ingredient result is "nothing missed
  or invented on these pages, and one quantity pattern lost", not an error
  rate.
- No photographs. All seven PDFs are printed web pages: clean type, no
  handwriting, no glare, no angle. The scorecard says nothing about camera
  capture, which is the app's main input.
- Expected answers were written by hand from the PDFs' text layer and the
  pages' markup and may carry their own mistakes. The PDF transcriptions were
  checked against `pdftotext` in review; the Cooking Classy page's were taken
  from its JSON-LD on the day.
- The scoring rules were tightened after an independent review of the first
  draft, and the committed results were re-scored offline rather than re-run:
  quantity and unit are now accepted only as pairs (so `25 tbsp` cannot pass a
  line that accepts `25 g` and `2 tbsp`); the two lemon-juice lines require
  their stated amounts, which turned 0 quantity errors into 4 in both arms;
  ingredients match on the structured `name` only, so a correct `raw_text`
  cannot hide a wrong name (this changed no result); a combined source line
  such as "Salt and pepper" requires every component, in the matched row or in
  a separate one; a produced step that merges two source steps is credited to
  both; matched steps are checked for missing numbers; servings and times
  compare as values or ranges. The "knob of butter (a little less than 2 tbsp
  or 25g)" line accepts either measure, with the approximation dropped or kept
  as prep. No other number in this document moved.
- Matching rules are the scorer's, not a judge's: keyword match on the
  structured name for ingredients, text overlap plus a numbers check for steps,
  substring or sequence similarity for the title, numbers and ranges for
  servings and times. The rules are in
  `tests/eval/fidelity/run_capture_fidelity.py` and can be re-run offline.
- On the JSON-LD path the steps come from the page's structured data, not from
  the model; only the ingredient structuring and the mapping are model work
  there. Step scores on that case say nothing about the model.
- Live pages change. The Cooking Classy HTML hashed differently on each of
  its four fetches at the same length, and the parsed output differed in one
  character between the two production runs (`oz` against `oz.` on the
  tomatoes); this run kept only the hash, so the cause is not preserved. From this change on, the harness stores what the URL
  path fed the model (the JSON-LD recipe, or the extracted text) in each row.
  The Wikibooks case pins a revision by `oldid`, and its extracted text as
  produced by the production extractor is committed under `inputs/`.

## Reproduce

```bash
# full run: 2 arms x 2 runs x 9 cases, about 40 calls, under $1 (.env must hold ANTHROPIC_API_KEY)
make eval-fidelity PYTHON=api/.venv/bin/python

# one case, one arm, one run
make eval-fidelity PYTHON=api/.venv/bin/python ARGS="--arm production --runs 1 --case french_onion_soup"

# re-score the committed results offline, no API call, prints the tables above
api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py \
  --rescore tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl
```

The harness, the cases, the arms and the scoring rules are described in
`tests/eval/README.md`.
