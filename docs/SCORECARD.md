# Capture evaluation

## Current safeguards

PDF capture accepts only verified single-page files. Both capture paths reject multi-page or unverifiable PDFs before model calls. Offline checks accepted three single-page fixtures and rejected four two-page fixtures: [PDF policy results](../tests/eval/fidelity/results/pdf_policy_20261021.json).

Saving a captured recipe requires a nonblank ingredient and instruction. Drafts can remain incomplete for correction. Applied offline to 36 historical outputs, this rule blocked six empty-instruction outputs, but allowed the two production outputs containing invented instructions: [save-policy results](../tests/eval/fidelity/results/save_policy_20261021.json).

These are structural safeguards, not new extraction accuracy results. Nonempty content can still be wrong or incomplete; review asks users to compare it with the source. Existing saved records are not revalidated. No paid evaluation was rerun for these changes.

## Historical results — October 18, 2026

**Small sample, not a benchmark:** nine inputs, two prompt arms, two runs each; 36 captures and 40 model calls with `claude-sonnet-4-6`, parser version 1.1. Seven PDFs were printed web pages; two inputs were live URLs. No camera photos, handwriting, glare or angled pages were tested.

The old pipeline rendered only page 1. Four PDFs had two pages; three contained recipe content on page 2. Current capture rejects those files. These historical scores therefore do not describe the current input policy.

| Metric | Production prompt | Baseline without parse rules |
|---|---:|---:|
| Captures producing a draft | 18/18 | 18/18 |
| Expected ingredient instances | 202 | 202 |
| Ingredients omitted on visible pages | 0 | 0 |
| Ingredients omitted on unrendered page 2 | 2 | 2 |
| Invented ingredients | 0 | 0 |
| Quantity errors | 4 | 4 |
| Unit errors | 0 | 16 |
| Expected step instances | 104 | 104 |
| Steps omitted on visible pages | 0 | 0 |
| Steps omitted on unrendered page 2 | 38 | 38 |
| Invented steps | 13 | 0 |
| Title, servings, prep and cook time correct | 18/18 each | 18/18 each |

Production captures averaged an estimated $0.0189 and had median wall time 11.2 seconds. Both arms totaled $0.6483 using the harness's historical $3/input and $15/output per million-token assumptions, not a current price quote.

## Failures to inspect

- **French onion soup:** the visible page had ingredients but no method. Production invented seven steps in one run and six in the other, both at confidence 0.82. Baseline returned no steps. A nonempty-content check cannot catch this.
- **Beef bourguignon:** all 19 ingredients but only five of 14 steps reached the model. Confidence 0.88 did not reveal the missing second page.
- **Halal Guys sauces:** 15 ingredients and no instructions, confidence 0.82. Both lemon-juice amounts were lost from structured quantities despite appearing in raw text.

The [committed results](../tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl) preserve parsed output, raw model responses, token usage and timing. [Inputs](../tests/eval/fidelity/inputs/) and [hand-written expected answers](../tests/eval/fidelity/expected/) support inspection.

## Interpretation and reproduction

The baseline keeps the schema but removes parse-prompt rules; the step mapper is unchanged. The production rules improved unit formatting on this sample but did not prevent invented instructions.

The [scorer](../tests/eval/fidelity/run_capture_fidelity.py) uses ingredient-name keywords, accepted quantity/unit pairs, step text overlap and numeric checks. These are mechanical matches, not semantic proof; expected answers can also be wrong. JSON-LD steps come from page data, not the model. The historical Cooking Classy source was preserved only as a hash; the Wikibooks text snapshot is committed. New runs store extracted URL content.

Run from the repository root, without model calls:

```bash
api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py --rescore tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl
api/.venv/bin/python tests/eval/fidelity/check_save_policy.py
```

See [evaluation tooling](../tests/eval/README.md) for harness scope. Do not count refused inputs as successful extractions or silently drop them from a reported denominator.
