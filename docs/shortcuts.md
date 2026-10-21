# Shortcuts capture API

This is an HTTP integration reference; the repository does not include an installable, device-verified Apple Shortcut. For editable capture, use the web or iOS app.

## Request

Create a capture token in the web app at `/settings/tokens`. Keep it private and revoke it there if exposed.

Send a multipart request to the **API** origin:

| Field | Value |
|---|---|
| Method/path | `POST /api/recipes/capture?source=shortcuts` |
| `Authorization` header | `Bearer tl_cap_…` |
| `Idempotency-Key` header | One UUID retained for retries of this input |
| Multipart field | `image`: one JPEG, PNG, GIF, WebP or verified single-page PDF, at most 10 MB |

In a Shortcut, accept the shared file, build this request, parse its JSON response, then open the returned path on the **web app** origin. Let the HTTP client set the multipart boundary. Do not include a private token in a shared Shortcut.

## Response and errors

Success is synchronous and returns `capture_id`, `recipe_id`, `status: "complete"` and `view_url: "/recipes/<id>"`. Resolve `view_url` against the web origin, which can differ from the API origin. The schema reserves other statuses, but this route currently has no polling workflow.

| Status/code | Meaning |
|---|---|
| 401 | Token missing, invalid or revoked |
| 409 | Idempotency key reused with different content |
| 413 | File exceeds 10 MB |
| 422 `PDF_MULTIPAGE_UNSUPPORTED` | Nothing saved; use a single-page source or capture the recipe URL in the app |
| 422 `PDF_PAGE_COUNT_FAILED` | PDF page count could not be verified; use another source |
| 422 `RECIPE_INCOMPLETE` | Missing ingredients or instructions; use draft capture to correct the extraction |
| 429 | Capture-token rate limit reached; wait before retrying |
| 5xx | Provider or infrastructure failure; retain the same key for retry |

Typed errors carry their code/message under `detail`; other errors may have a string detail. See [the route](../api/routes/recipes.py) for the full contract.

The nominal limit is 60 attempts per token per hour. Successful cached replays bypass the limit. This legacy route's cache does not prevent duplicates from concurrent first requests or a failure to persist the response cache. Draft capture has stronger atomic retry handling; see [architecture](architecture.md).
