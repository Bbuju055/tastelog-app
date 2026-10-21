# Model evaluations

Manual harnesses, separate from pytest. Prefer offline replay for scorer or save-policy changes. Live runs use Anthropic and cost money; agree the cases, run count and budget before running them.

## Offline checks

From the repository root:

```bash
api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py --rescore tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl
api/.venv/bin/python tests/eval/fidelity/check_save_policy.py
```

Rescoring reads stored parsed output, not fresh model responses. Add `--out <new-file>` to write updated scores without replacing the original evidence. Results and limitations are in the [scorecard](../../docs/SCORECARD.md).

## Live harnesses

| Script | Purpose | Default scope |
|---|---|---|
| [run_mapping_eval.py](run_mapping_eval.py) | Step-to-ingredient mapping across vision, URL text, JSON-LD and Riff | Three synthetic recipes × four paths × two runs; 24 calls |
| [run_riff_baseline.py](run_riff_baseline.py) | Single-turn adaptation response shape and content | 14 cases over three recipes |
| [fidelity/run_capture_fidelity.py](fidelity/run_capture_fidelity.py) | Real-input omissions, invention, quantities, timing and token usage | Nine inputs × two arms × two runs; calls vary with input rejection and URL path |

Export `ANTHROPIC_API_KEY` for live scripts; never print or commit it. Mapping/Riff transcripts go to ignored `runs/`. Fidelity writes to `fidelity/results/`; review raw content before committing results.

The fidelity Make target loads root `.env` and accepts `ARGS`, for example `--arm production --runs 1 --case garlic_aioli`. `--case` is repeatable. Consult the script's `--help` before selecting a paid run.

Four of the seven PDF fixtures are multi-page and are now rejected before model calls. Keep those policy failures visible in reporting. The October 18 results used the older first-page-only pipeline; they cannot be reproduced unchanged with today's capture policy.

## What passes

- **Mapping:** no false positives; expected associations on both runs; genuinely empty steps stay authoritative-empty, not unknown; valid output shape; ingredient/step extraction aligns with fixtures. Goldens live in [mapping_eval_recipes.py](mapping_eval_recipes.py); [fixtures](fixtures/) are rendered synthetic pages, not photographs.
- **Riff:** emitted recipe blocks validate and match the expected shape. Human review checks preservation, brevity, grounded substitutions, scaling notes, no filler and appropriate clarification. Mechanical fields assist that review; they do not prove recipe quality. Cases live in [riff_eval_recipes.py](riff_eval_recipes.py).
- **Fidelity:** the scorer compares structured output with [expected answers](fidelity/expected/). It records mapping state but does not grade mapping accuracy. Production and baseline use the same model; the baseline removes parse-prompt rules.

Choose the relevant harness when changing parsing, mapping or Riff prompts. Compare like-for-like cases and retain failures. None of these small suites establishes camera-photo accuracy or multi-turn Riff quality.
