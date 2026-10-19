# Tastelog, a case study

What was built, what was wrong with it when the code was opened up, what
changed, and what the numbers say now. The [README](../README.md)
says what the product does; the [scorecard](SCORECARD.md) has the measurements.

## The problem

Recipes arrive as photos of cookbook pages, screenshots, PDFs and links, and
end up scattered or retyped. Tastelog captures a recipe from any of those,
parses it with Claude Vision into structured ingredients and steps, lets the
user correct the draft, and files it in a personal cookbook with grocery
lists, exact-fraction scaling, a cook mode and a conversational "riff" mode for
adapting a recipe.

## Constraints

- One developer. Three clients (a Next.js web app, an Expo iOS app with a
  native Swift share extension, an iOS Shortcuts flow) on one FastAPI backend,
  with Supabase for Postgres, Auth and Storage.
- This repository is a snapshot of a private one, taken on 2026-10-16 with the
  history squashed and planning documents removed. Fixes made here reach the
  production app only when ported by hand; the hosted database has not had
  migration 028 applied.
- Every model call costs money, and the evals that existed ran on synthetic
  fixtures. Anything claimed about capture quality had to be measured on real
  inputs or left unsaid.
- No invented traction. There are no user or growth figures here because there
  are none to report. The evidence is tests, a database proof and a scorecard.

## Three decisions

**1. Prove the flagship journey before anything else.** An independent review
of the first plan found that the web review form silently dropped the draft's
content, so the capture, review, edit, confirm journey did not actually work on
web. The plan was reordered around that: repair and prove the journey first
(commits `d6c66d8`, `c67faf2`), then the two cheap holes on URL capture, SSRF
and missing rate limits, then make the whole stack runnable by a stranger with
no accounts (`make demo`: local Supabase, a deterministic Claude stub, three
seeded recipes), then the idempotency work. Hardening a journey that does not
work proves nothing to a reader.

**2. Put idempotency in the database, keyed by user, insert-first.** The
existing helper was scoped to capture tokens and did check-then-store, so two
concurrent retries could both create a draft. Migration 028 reserves a key
atomically inside one RPC. The API mints the draft id before reserving, so a
retry after a lost response recovers that exact draft by id instead of making
a second one; a retry that races the first attempt gets 409 with `Retry-After`
rather than waiting; there is no time-based takeover of a pending key. The
header stays optional until all three clients send one, because requiring it
first would break share extensions already installed. Correctness under
concurrency belongs where the transaction is. Clients only have to keep one
key per attempt.

**3. Measure capture on real inputs, against a baseline, and publish the
failures.** Nine real inputs (seven recipe PDFs, two live URLs, one with
JSON-LD and one without), hand-written expected answers, and a second arm with
the same model and the prompt's rules removed. Results are committed and
re-scorable offline; three failures are shown with the raw model output; the
small N is the first sentence. A reader cannot tell a good parser from a demo
without numbers, and a number without its failures is marketing.

## Two honest failures, and what changed

**The web review form threw edits away.** It rendered ingredients only when
they arrived as strings or `{text}` objects, but the API sends `{name, …}` and
`{instruction}`, so both lists showed empty, and confirm sent only the title.
Fixed in two commits: an adapter that maps the API shapes to editable lines and
a patch builder that sends changed ingredients, steps, servings and times;
then a second fix so untouched rows keep their structure instead of being
re-sent as plain text. Covered by the vitest cases in `reviewPatch.test.ts`
(nineteen today) and seven pytest confirm tests. One gap is declared rather
than hidden: clearing servings, prep or cook
time on confirm is impossible for any client, because the confirm RPC keeps
the draft's value when the override is null. The web form now refuses to
confirm with such a field blank and says why; mobile still keeps the value
silently.

**The README claimed a retried share-extension upload "never creates two
drafts", and that was false.** The extension posted to a route with no
idempotency at all, and the one route that had it could still duplicate under
a race. The claim was reworded to the truth on day one. Then migration 028,
both draft capture routes, and the three clients that use them in this public
copy (web, mobile, the Swift share extension) got the real thing, proven on
real PostgreSQL 17.6 in CI (ownership, recovery, no takeover, and a race
battery) and by hand on the local demo stack. Implemented and proven here;
not deployed: the hosted app has not had migration 028 applied, and the older
Shortcuts route keeps its token-scoped helper, which can still duplicate under
a race. The claim is back, qualified: same key and same bytes within 24 hours,
with the client keeping one key per input.

**And one found while writing this page.** The journey check for the review
form was deliberately done without a browser: pure-function tests for the
adapter and the patch builder, plus mocked-route tests for confirm. Taking the
[README screenshots](../README.md#what-it-looks-like) meant driving the real
web app for the first time from a fresh checkout, and the review page did not load any draft at all: Next 16
hands route params to a page as a Promise, both dynamic pages read them
synchronously, and the API was asked for `/api/drafts/undefined`. The recipe
detail page had the same bug. Two one-line fixes, and a lesson the plan had
already written down as a declared gap: tests that never render the page
cannot see the page.

**Two more from the same pass.** First, the web recipe page printed each
ingredient's preparation twice ("…then sliced, cut into quarters through the
length then sliced"). The mobile copy of the same formatter already suppressed
that, with a comment explaining why; the web copy never received the change.
One line and two tests, and a reminder that two clients sharing a rule by copy
will drift. Second, the app's known flaky bug: after confirming a draft, the
iOS recipe screen's back button sometimes did nothing. Nothing in the screen's
own code intercepts the tap. The suspected cause is an overlap: the "saved"
beat is a native Modal, and the route swap to the recipe ran in the same tick
the Modal began dismissing. The beat component already had a mode that defers
completion until UIKit reports the Modal gone, used by the cook screen; the
draft screen now uses it too, which removes the overlap, and the tests drive
that order explicitly. Whether that was the cause is unverified: the symptom
was intermittent, one afternoon cannot show it gone, and nothing reproduces
the dead header in a test.

## What the scorecard says

On nine real inputs, 36 captures, 65 cents: the production prompt missed or
invented no ingredient on any rendered page (200 of 202 expected instances
matched; the other two sat on second pages that are never rendered), got every title,
servings and time right, and lost one quantity pattern (two "juice from a
lemon" lines). It invented six to seven steps on one page that showed
ingredient headers and no instructions, with confidence 0.82, and the pipeline
renders only a PDF's first page, which silently cost 38 step instances. A
capture costs about two cents and eleven seconds. The prompt's rules buy clean
unit fields (16 baseline unit errors against 0) for about a tenth of a cent
per call. Details, raw output and caveats: [docs/SCORECARD.md](SCORECARD.md).

## What is not here

- Camera photos in the eval. Every input was a printed page or a web page;
  handwriting, glare and angle are untested.
- Decimal quantities on the recipe page. The exact-fraction scaler renders a
  printout's "5.33 oz" as "5 33/100 oz" at 1x. Correct arithmetic, odd to
  read; showing the source line at 1x is the obvious change and is not made.
- Clearing a field on confirm, as above.
- The hosted app on migration 028: not applied there, not checked from here.
- Persistence through a real database as an automated test in CI. It is
  checked on the local demo stack by a browser script that logs in, uploads,
  reviews, edits the title, confirms, and reads the edit back after a reload
  (`scripts/web-journey.mjs`, run by hand).
- Two known, deferred smells: the riff route is about 1,500 lines, and async
  route handlers call a synchronous Supabase client. Real; the cost at any
  given traffic is unmeasured.

## How to check any of this

Prerequisites and the one-time setup (venv, `npm ci`, Docker, Supabase CLI)
are in the [README](../README.md#run-it-locally). Then:

```bash
make test                                   # 948 backend tests, no network (venv active)
(cd tastelog-web && npm test)               # 174 web tests
(cd tastelog-mobile && npm test)            # 1311 mobile tests, Node 24

# the journey, no accounts: three terminals
make demo                                   # 1: local Supabase, schema, demo user, seed, env files
cp .env.demo .env && make demo-api          # 2: API on :8000 with the Claude stub
cp tastelog-web/.env.demo.local tastelog-web/.env.local && (cd tastelog-web && npm run dev)   # 3: web on :3000
# then log in as demo@tastelog.local / demo-password, or drive it headless:
NODE_PATH=/path/to/node_modules/with/playwright node scripts/web-journey.mjs /tmp/shots

# re-score the committed capture-fidelity results offline, no API call
api/.venv/bin/python tests/eval/fidelity/run_capture_fidelity.py \
  --rescore tests/eval/fidelity/results/fidelity_20261018T213818Z.jsonl
```

Pushes to `main` and pull requests run the backend, web (lint, strict
TypeScript, tests, production build), mobile (strict TypeScript, tests) and
real-PostgreSQL proof jobs in [CI](https://github.com/Bbuju055/tastelog-app/actions/workflows/ci.yml).
