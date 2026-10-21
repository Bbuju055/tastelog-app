# Code guide

For setup, use the [root README](../README.md). The local demo uses fixed model output with real Supabase Auth, Storage and Postgres.

## Where things live

| Area | Entry points |
|---|---|
| API | [api/main.py](../api/main.py), [routes](../api/routes/), [models](../api/models/) |
| Capture and parsing | [parser.py](../api/core/parser.py), [image_encoding.py](../api/core/image_encoding.py), [url_extractor.py](../api/core/url_extractor.py) |
| Draft persistence and retries | [drafts.py](../api/core/drafts.py), [draft_idempotency.py](../api/core/draft_idempotency.py) |
| Search, groceries, cooking and Riff | [api/core](../api/core/) and matching routes |
| Web pages | [tastelog-web/app](../tastelog-web/app/); [components](../tastelog-web/src/components/) |
| Web API contracts and scaling | [src/lib](../tastelog-web/src/lib/); Zod schemas and BigInt fraction arithmetic |
| iOS app and share extension | [mobile setup](../tastelog-mobile/README.md), [app](../tastelog-mobile/app/), [Swift extension](../tastelog-mobile/ios/TastelogShareExtension/) |
| Database | [bootstrap](../db/bootstrap/), [migrations](../migrations/); [migration workflow](migrations.md) |

## Capture → review → save

1. Web, mobile and the share extension submit files to `/api/drafts/capture`; URL capture uses `/api/drafts/capture-url`.
2. The API validates input, extracts structured content and stores a draft. PDFs must have exactly one verifiable page. A rejected PDF rejects the whole batch before model calls. URL capture checks destinations against SSRF and uses JSON-LD when available, falling back to page text.
3. Review edits are submitted to `/api/drafts/{id}/confirm`. Untouched ingredient rows retain their structure; edited text becomes unstructured. Saving requires at least one nonblank ingredient and instruction. Incomplete drafts remain editable.
4. Confirmation saves the recipe and its ingredient/step rows. Search, groceries, scaling, cook mode and Riff use the saved recipe.

Review warnings ask users to check the source. Nonempty fields and model confidence do not prove completeness or accuracy. See the [evaluation evidence](SCORECARD.md).

The older [Shortcuts endpoint](shortcuts.md) saves directly without draft review; it rejects extraction missing ingredients or instructions.

## Auth and retries

The app uses Supabase JWTs. Share extensions and Shortcuts use revocable capture tokens (`tl_cap_*`), not the user's JWT. Draft capture accepts either; normal cookbook access requires JWT auth. Service-role database calls must enforce user ownership themselves; user-scoped clients also rely on RLS.

Migration 028 reserves draft idempotency keys atomically per user. Clients retain one key per attempt; the same key and payload can recover the original draft within the retention window. Concurrent pending requests receive 409 with `Retry-After`; pending keys are not taken over on a timer. The older direct-capture route uses a token-scoped cache and can still duplicate under concurrent first attempts.

## Checks and limitations

The root README lists backend, web and real-Postgres checks. [CI](../.github/workflows/ci.yml) also runs TypeScript, web lint/build and mobile tests. With the demo running and Playwright installed:

```bash
node scripts/web-journey.mjs output/playwright/journey
```

This checks PDF rejection, capture, review validation, reset, save, reload and search against the local database. If Playwright is installed elsewhere, set `NODE_PATH` to its `node_modules`; optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium binary. Browser coverage is currently manual, not a CI job.

Known limits: confirmation cannot clear existing servings/prep/cook metadata to null; the web form explains this, while mobile retains the value. Some async handlers use synchronous Supabase calls. Native navigation behavior still needs device testing. Camera-photo extraction fidelity has not been measured.

Further reference: [deployment configuration](deploy-topology.md), [manual evaluations](../tests/eval/README.md), [load-test tooling](../loadtests/README.md).
