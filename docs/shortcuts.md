# iOS Shortcuts — Setup Guide

> Capture recipes from anywhere on iOS using Shortcuts and the Tastelog API.

---

## Prerequisites

1. A Tastelog account with at least one successful recipe capture.
2. iOS 16+ (Shortcuts app pre-installed).
3. A **capture token** — created from the Tastelog web app.

### Create a Capture Token

1. Open **Tastelog** in your browser.
2. Go to **Settings > Capture Tokens** (`/settings/tokens`).
3. Click **Create Token** and give it a name (e.g. "iPhone Shortcuts").
4. **Copy the token immediately.** It starts with `tl_cap_` and is shown only once.
5. If you lose it, revoke and create a new one.

---

## Store the Token in Keychain

Shortcuts needs to read your capture token securely. Store it in iCloud Keychain so all three shortcuts can access it.

### Option A: Using the Shortcuts App

1. Open **Shortcuts** and create a new shortcut.
2. Add action: **Scripting > Add to Keychain**.
3. Set:
   - **Account:** `tastelog_capture_token`
   - **Service:** `tastelog_capture_token`
   - **Password:** paste your `tl_cap_...` token
4. Run the shortcut once. Delete it after — the Keychain item persists.

### Option B: Using a Third-Party Keychain Manager

If you use an app like 1Password or the Keychain Access app on macOS:

1. Create a new password entry.
2. Set account and service to `tastelog_capture_token`.
3. Set the password to your `tl_cap_...` token.
4. Ensure iCloud Keychain sync is enabled.

---

## Shortcut 1: Save Recipe (Share Sheet)

**Name:** Save Recipe
**Trigger:** Share Sheet (accepts any image)
**What it does:** Uploads a shared image to Tastelog, notifies you, and opens the result.

### Build Steps

1. Open **Shortcuts** > tap **+** > name it **Save Recipe**.
2. Tap **i** at the top > enable **Show in Share Sheet** > under **Share Sheet Types**, select **Images** only.

Add the following actions in order:

| # | Action | Configuration |
|---|--------|---------------|
| 1 | **Receive** input from Share Sheet | If there's no input: **Stop and Respond** |
| 2 | **Set variable** | Name: `RecipeImage`, Value: **Shortcut Input** |
| 3 | **Find Keychain Password** | Account: `tastelog_capture_token` |
| 4 | **Set variable** | Name: `Token`, Value: **Keychain Password** |
| 5 | **Generate UUID** | (built-in Scripting action) |
| 6 | **Set variable** | Name: `IdempotencyKey`, Value: **Generated UUID** |
| 7 | **Get Contents of URL** | See configuration below |
| 8 | **If** | Status code **is not** 200 → **Show Notification**: "Upload failed: [Status Code]" → **Stop** |
| 9 | **Get Dictionary Value** for key `view_url` | From: **Contents of URL** |
| 10 | **Show Notification** | Title: "Recipe Saved", Body: **Dictionary Value** |
| 11 | **Open URL** | `https://api.example.com` + **Dictionary Value** |

### Step 7 — "Get Contents of URL" Configuration

| Field | Value |
|-------|-------|
| **URL** | `https://api.example.com/api/recipes/capture?source=shortcuts` |
| **Method** | POST |
| **Request Body** | Form |
| **Headers** | `Authorization`: `Bearer [Token]` |
| | `Idempotency-Key`: `[IdempotencyKey]` |
| **Form Fields** | `image` (File): `[RecipeImage]` |

> `source` is a **query parameter** (in the URL), not a form field. A form
> field named `source` is ignored by the API.

> **Timeout:** iOS Shortcuts has a default network timeout. The API may take up to 30 seconds for large images. If uploads time out frequently, try smaller images or JPEG format.

---

## Shortcut 2: Auto-Save Recipe Screenshots

**Name:** Auto-Save Recipe Screenshots
**Trigger:** Personal Automation > Screenshot
**What it does:** When you take a screenshot, waits briefly, then asks if you want to save it as a recipe.

### Build Steps

1. Open **Shortcuts** > **Automation** tab > **+** > **Screenshot**.
2. Choose **Run Immediately** (or **Ask Before Running** if preferred).

Add the following actions:

| # | Action | Configuration |
|---|--------|---------------|
| 1 | **Wait** | 2 seconds |
| 2 | **Find Photos** | Filter: **Album is Screenshots**, **Sort by Date Taken (Latest First)**, **Limit: 1** |
| 3 | **Show Alert** | Title: "Save as Recipe?", Message: "Save this screenshot to Tastelog?", Show Cancel Button: **On** |
| 4 | **Run Shortcut** | Shortcut: **Save Recipe**, Input: **Photos** |

> If you tap **Cancel** at step 3, the automation stops. No upload happens.

### Notes

- This automation triggers on every screenshot. The confirmation dialog (step 3) prevents accidental uploads.
- If you want fully automatic capture without asking, remove step 3 — but every screenshot will be uploaded.
- The 2-second wait ensures the screenshot is saved to Photos before the query runs.

---

## Shortcut 3: Hey Siri, Save This Recipe

**Name:** Save This Recipe
**Trigger:** Siri voice command ("Hey Siri, save this recipe")
**What it does:** Opens the photo picker, lets you select an image, and uploads it.

### Build Steps

1. Open **Shortcuts** > tap **+** > name it **Save This Recipe**.
2. Siri will use the shortcut name as the trigger phrase. Saying "Hey Siri, save this recipe" will invoke it.

Add the following actions:

| # | Action | Configuration |
|---|--------|---------------|
| 1 | **Select Photos** | Selection Limit: **1** |
| 2 | **If** | **Selected Photos** has any value |
| 3 | **Run Shortcut** | Shortcut: **Save Recipe**, Input: **Selected Photos** |
| 4 | **Otherwise** | |
| 5 | **Show Notification** | "No photo selected." |
| 6 | **End If** | |

### Custom Siri Phrase (Optional)

If you want a different trigger phrase:

1. Open the shortcut > tap **i** > **Add to Siri**.
2. Record a custom phrase (e.g. "Capture recipe" or "Log this recipe").

---

## API Reference

All three shortcuts call the same endpoint.

### Endpoint

```
POST https://api.example.com/api/recipes/capture
```

### Headers

| Header | Required | Value |
|--------|----------|-------|
| `Authorization` | Yes | `Bearer tl_cap_...` (your capture token) |
| `Idempotency-Key` | Yes | UUID v4 recommended. 1-100 chars, no whitespace. |

### Body (multipart/form-data)

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `image` | Yes | File | JPEG, PNG, GIF, WebP, or PDF. Max 10 MB. |

### Query Parameters

| Parameter | Required | Notes |
|-----------|----------|-------|
| `source` | No | One of `web`, `shortcuts`, `mobile_app`, `share_extension`. Defaults to `web`. Use `?source=shortcuts` in the URL; a form field named `source` is ignored. |

### Response (JSON)

```json
{
  "capture_id": "uuid",
  "recipe_id": "uuid or null",
  "status": "complete",
  "view_url": "/recipes/<recipe_id>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `capture_id` | UUID | Unique ID for this capture request. |
| `recipe_id` | UUID or null | Recipe ID if parsing succeeded. Null if queued/failed. |
| `status` | String | `queued`, `processing`, `complete`, or `failed`. |
| `view_url` | String | Relative path to view the recipe or review the draft. |

### Rate Limits

- **60 requests per hour** per capture token.
- Retries with the same `Idempotency-Key` do not count against the limit.

### Error Payload Shape

Capture-processing failures (the image could not be read, or the parsing
provider failed) return a structured `detail` object with a stable
machine-readable code:

```json
{
  "detail": {
    "code": "RECIPE_UNREADABLE",
    "message": "We couldn’t read a recipe from this image."
  }
}
```

| Code | Status | Meaning |
|------|--------|---------|
| `RECIPE_UNREADABLE` | 422 | The image itself could not be read as a recipe. Not retryable with the same image. |
| `RECIPE_PROVIDER_UNAVAILABLE` | 503 | Parsing service unavailable. Retry later with the same `Idempotency-Key`. |
| `RECIPE_PROVIDER_RATE_LIMITED` | 503 | Parsing service busy. Retry later with the same `Idempotency-Key`. |
| `RECIPE_PROVIDER_TIMEOUT` | 504 | Parsing timed out. Retry with the same `Idempotency-Key`. |
| `RECIPE_PROVIDER_BAD_RESPONSE` | 502 | Parsing produced an unusable response. Retry with the same `Idempotency-Key`. |

Other failures use two further `detail` shapes; branch on the HTTP status
for both:

- Route-owned failures (authentication, idempotency conflicts, size
  limits, rate limits, storage) return a plain-string `detail`.
- Requests that fail FastAPI validation itself (for example a missing
  `Idempotency-Key` header or missing `image` field) return 422 with a
  list-valued `detail` (FastAPI's standard validation shape).

A Shortcuts "Show Alert" wired to the raw `detail` will display objects
and lists as text; wire it to `detail.message` if you want just the
sentence for capture-processing failures.

---

## Troubleshooting

### Authentication Errors (401)

| Message | Cause | Fix |
|---------|-------|-----|
| "Capture token required" | Missing `Authorization` header. | Add `Authorization: Bearer tl_cap_...` header. |
| "Invalid or expired token" | Token revoked, expired, or mistyped. | Check the token in Keychain. Create a new one if needed. |

**Common Keychain issues:**
- Account name must be exactly `tastelog_capture_token` (case-sensitive).
- The token value must include the `tl_cap_` prefix.
- If you regenerated a token on the web, update the Keychain entry.

### Upload Errors (4xx)

| Status | Message | Fix |
|--------|---------|-----|
| 400 | "Invalid file type" | Only JPEG, PNG, GIF, WebP, PDF accepted. Convert the image first. |
| 400 | "Invalid Idempotency-Key" | Ensure the UUID action is wired to the header. No spaces or empty values. |
| 409 | "Idempotency key already used with different payload" | Generate a new UUID. This means you reused a key with a different image. |
| 413 | "File too large" | Image exceeds 10 MB. Resize or compress before uploading. |
| 422 | `RECIPE_UNREADABLE` (structured detail, see Error Payload Shape) | The image itself could not be read as a recipe. Retrying the same image will fail again; try a clearer photo. |
| 429 | Rate limited | Wait and retry later. Max 60 uploads/hour. |

### Server Errors (5xx)

| Status | Meaning | Fix |
|--------|---------|-----|
| 502 | Parsing produced an unusable response (`RECIPE_PROVIDER_BAD_RESPONSE`). | Retry with the same `Idempotency-Key`. |
| 503 | Parsing service unavailable or busy (structured codes above), or a storage/idempotency persistence failure (plain-string detail). | Retry with the same `Idempotency-Key`. |
| 504 | Parsing timed out (`RECIPE_PROVIDER_TIMEOUT`). | Retry with the same `Idempotency-Key`. |
| 500 | Unexpected error. | If persistent, check the Tastelog status page or revoke/recreate your token. |

**Retry rule:** On any 5xx error, retry the request with the **same** `Idempotency-Key`. When the failure happened before the recipe was saved (the normal case), this prevents duplicates. Rare duplicate windows exist: if the server saved the recipe but failed to persist the idempotency record, or a failure's automatic cleanup itself failed, a retry can create a duplicate or leave a partial recipe. If a 5xx retry succeeds, check your recipe list before assuming there is exactly one copy.

### Photos Permission

If Shortcuts cannot access photos:

1. Go to **Settings > Privacy & Security > Photos**.
2. Ensure **Shortcuts** has access (at minimum "Limited Access" for the albums you use).

### Shortcut Not Appearing in Share Sheet

1. Open the shortcut > tap **i** > verify **Show in Share Sheet** is enabled.
2. Verify **Share Sheet Types** includes **Images**.
3. Restart the Shortcuts app (swipe up to close, reopen).

---

## Token Management

- **Create tokens:** Tastelog web > Settings > Capture Tokens > Create Token.
- **Revoke tokens:** Same page > click Revoke on any token. Revocation is immediate and permanent.
- **One token per device** is recommended (easier to revoke if a device is lost).
- Tokens do not expire by default. Set an expiry if you prefer time-limited access.
- `last_used_at` updates on each successful capture — check the web UI to verify your shortcut is working.
