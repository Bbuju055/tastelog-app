# Tastelog Architecture Reference

> Source of truth for codebase structure, types, and contracts.
> Last verified: 2026-02-13

---

## Project Structure

```
tastelog/
├── api/                          # FastAPI backend (Python)
│   ├── main.py                   # App factory, CORS, Sentry init, router registration
│   ├── dependencies.py           # FastAPI DI: auth, DB clients
│   ├── core/                     # Business logic (stateless, reusable)
│   │   ├── config.py             # Pydantic Settings (env vars)
│   │   ├── exceptions.py         # Custom exception hierarchy
│   │   ├── supabase_client.py    # Service-role client (singleton)
│   │   ├── supabase_user_client.py # User-scoped client (per-request, RLS)
│   │   ├── jwt.py                # JWKS-based JWT verification (RS256/ES256)
│   │   ├── token_auth.py         # Capture token auth + rate limiting
│   │   ├── idempotency.py        # Postgres-backed idempotency
│   │   ├── image_encoding.py     # Image/PDF → base64 for Claude Vision
│   │   ├── parser.py             # Claude Vision recipe parsing
│   │   ├── recipes.py            # Recipe CRUD + storage
│   │   ├── drafts.py             # Draft CRUD + confirm via RPC
│   │   ├── search.py             # FTS + fallback ILIKE search
│   │   └── grocery.py            # Grocery list operations
│   ├── models/                   # Pydantic request/response models
│   │   ├── base.py               # UTCTimestampModel base class
│   │   ├── common.py             # ErrorResponse, HealthResponse
│   │   ├── recipe.py             # Recipe types
│   │   ├── draft.py              # Draft types
│   │   ├── grocery.py            # Grocery types
│   │   ├── capture_token.py      # Token types (create, response, DB)
│   │   └── capture_response.py   # Locked capture endpoint response
│   └── routes/                   # HTTP route handlers
│       ├── health.py             # GET /health
│       ├── recipes.py            # /api/recipes/* + /api/recipes/capture
│       ├── tokens.py             # /api/tokens/*
│       ├── storage.py            # /api/storage/image/*
│       ├── drafts.py             # /api/drafts/*
│       └── grocery.py            # /api/grocery/*
├── tastelog-web/                  # Next.js frontend (TypeScript)
│   ├── src/
│   │   ├── app/                  # App Router pages
│   │   │   ├── layout.tsx        # Root layout (fonts, QueryProvider, AppHeader)
│   │   │   ├── page.tsx          # Home — recipe list + search
│   │   │   ├── login/page.tsx    # Email/password login
│   │   │   ├── add/page.tsx      # Upload recipe image/PDF
│   │   │   ├── recipes/[recipeId]/page.tsx  # Recipe detail (server component)
│   │   │   ├── review/[draftId]/page.tsx    # Draft review (server component)
│   │   │   ├── settings/tokens/page.tsx     # Capture token management
│   │   │   ├── error.tsx         # Global error boundary
│   │   │   ├── loading.tsx       # Global loading skeleton
│   │   │   ├── not-found.tsx     # 404 page
│   │   │   └── globals.css       # Tailwind v4 + theme variables + paper grain
│   │   ├── components/
│   │   │   ├── AppHeader.tsx     # Nav + auth state + sign out
│   │   │   ├── RecipeDetailView.tsx  # Recipe display + scaling + delete
│   │   │   ├── RecipeScaleControl.tsx  # Scale factor UI (presets + custom)
│   │   │   ├── RecipeCard.tsx    # Editable recipe card (controlled component)
│   │   │   ├── DraftReviewForm.tsx  # Draft review + confirm/delete
│   │   │   ├── UploadDropzone.tsx   # Drag-and-drop file upload
│   │   │   ├── TokenList.tsx     # Token list + revoke
│   │   │   ├── CreateTokenModal.tsx  # Two-step modal: form → show token
│   │   │   └── ui/              # shadcn/ui primitives (new-york style)
│   │   │       ├── button.tsx
│   │   │       ├── card.tsx
│   │   │       ├── checkbox.tsx
│   │   │       ├── input.tsx
│   │   │       └── label.tsx
│   │   ├── lib/
│   │   │   ├── api/
│   │   │   │   ├── client.ts     # apiFetch — typed HTTP client with Zod validation
│   │   │   │   ├── endpoints.ts  # All API call functions
│   │   │   │   ├── schemas.ts    # Zod schemas matching api/models/*.py
│   │   │   │   └── normalize.ts  # normalizeImageKey (image_path → image_key)
│   │   │   ├── ingredients/      # Ingredient scaling engine
│   │   │   │   ├── index.ts      # Barrel exports
│   │   │   │   ├── types.ts      # Rational, ParsedQuantity, ScaleResult
│   │   │   │   ├── rational.ts   # Exact BigInt fraction arithmetic
│   │   │   │   ├── parseQuantity.ts   # "1 1/2" → Rational
│   │   │   │   ├── classifyIngredient.ts  # Unit classification
│   │   │   │   ├── scaleIngredient.ts     # Apply scaling factor
│   │   │   │   └── formatIngredient.ts    # Format for display
│   │   │   ├── supabase/
│   │   │   │   ├── env.ts        # hasSupabaseEnv() check
│   │   │   │   ├── browser.ts    # Lazy singleton client + getAccessToken()
│   │   │   │   └── server.ts     # Server component client via @supabase/ssr
│   │   │   ├── config.ts         # Validated env vars (Zod)
│   │   │   ├── errors.ts         # ApiError class + factory functions
│   │   │   ├── useApiErrorMessage.ts  # Error → display string (pure function)
│   │   │   ├── queryKeys.ts      # TanStack Query key constants
│   │   │   └── utils.ts          # cn() — Tailwind class merger
│   │   ├── providers/
│   │   │   └── QueryProvider.tsx  # TanStack QueryClientProvider
│   │   └── middleware.ts         # Auth gate (Supabase session check)
│   ├── sentry.client.config.ts   # Sentry browser init (header scrubbing)
│   ├── sentry.server.config.ts   # Sentry server init (header scrubbing)
│   ├── next.config.ts            # API rewrite proxy → NEXT_PUBLIC_API_BASE_URL
│   ├── tsconfig.json             # strict: true, path alias @/* → ./src/*
│   └── package.json              # Scripts: dev, build, start, lint, test, test:watch
├── migrations/                   # SQL migration files (see docs/migrations.md)
├── tests/                        # Python tests (pytest)
├── docs/                         # Documentation
│   ├── architecture.md           # This file
│   └── shortcuts.md              # iOS Shortcuts setup guide
├── capture.py                    # CLI: photo → parse → store → display
├── parser.py                     # CLI: photo → parse → JSON
├── search.py                     # CLI: search recipes
├── grocery.py                    # CLI: grocery list operations
├── Makefile                      # deps, sync, test, dev targets
├── Procfile                      # Railway: uvicorn start command
├── railway.toml                  # Railway: nixpacks builder, health check
├── nixpacks.toml                 # System deps: python312, poppler_utils
├── requirements.in               # Python deps (human-edited)
├── requirements.txt               # Python lockfile (generated)
└── pytest.ini                    # Test config
```

---

## Database Schema

### `recipes`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default gen_random_uuid() |
| `user_id` | UUID | NOT NULL, FK → auth.users(id) |
| `title` | TEXT | NOT NULL |
| `image_path` | TEXT | Storage key (e.g. `{user_id}/{uuid}.jpg`) |
| `servings` | TEXT | Nullable |
| `prep_time` | TEXT | Nullable |
| `cook_time` | TEXT | Nullable |
| `confidence_score` | REAL | 0.0-1.0, nullable |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

**Note:** The DB column is `image_path`. The Python model aliases it as `image_storage_key` via `validation_alias="image_path"`. The frontend Zod schema accepts both names and normalizes to `image_key` via `normalizeImageKey()`.

### `recipe_ingredients`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `recipe_id` | UUID | NOT NULL, FK → recipes(id) |
| `position` | INT | Order in recipe (1-based) |
| `quantity` | TEXT | e.g. "2", "1/2" |
| `unit` | TEXT | e.g. "cups", "tsp" |
| `name` | TEXT | NOT NULL, ingredient name |
| `prep` | TEXT | e.g. "chopped", "minced" |
| `raw_text` | TEXT | Original line from source |

### `recipe_steps`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `recipe_id` | UUID | NOT NULL, FK → recipes(id) |
| `position` | INT | Step number (1-based) |
| `instruction` | TEXT | NOT NULL |

### `recipe_drafts`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default gen_random_uuid() |
| `user_id` | UUID | NOT NULL, FK → auth.users(id) ON DELETE CASCADE |
| `image_storage_key` | TEXT | NOT NULL, storage reference |
| `title` | TEXT | NOT NULL |
| `servings` | TEXT | Nullable |
| `prep_time` | TEXT | Nullable |
| `cook_time` | TEXT | Nullable |
| `confidence_score` | REAL | 0.0-1.0 |
| `ingredients` | JSONB | NOT NULL, default [] |
| `steps` | JSONB | NOT NULL, default [] |
| `raw_model_json` | JSONB | Full AI response |
| `model_version` | TEXT | NOT NULL |
| `parser_version` | TEXT | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL, auto-updated via trigger |
| `expires_at` | TIMESTAMPTZ | NOT NULL, default now() + 7 days |

RLS: Users can SELECT/INSERT/DELETE own drafts. No UPDATE policy (drafts are immutable until confirm).

### `capture_tokens`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL, FK → auth.users(id) ON DELETE CASCADE |
| `token_hash` | TEXT | NOT NULL, UNIQUE — SHA-256 of plaintext |
| `name` | TEXT | NOT NULL, UNIQUE per user |
| `scope` | TEXT | NOT NULL, default 'capture' |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `expires_at` | TIMESTAMPTZ | Optional expiration |
| `revoked_at` | TIMESTAMPTZ | Soft delete |
| `last_used_at` | TIMESTAMPTZ | Best-effort usage tracking |

### `capture_rate_limits`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `token_hash` | TEXT | NOT NULL |
| `request_at` | TIMESTAMPTZ | NOT NULL, default now() |

Index: `(token_hash, request_at DESC)` for sliding window queries.

### `capture_idempotency_keys`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `token_id` | UUID | NOT NULL, FK → capture_tokens(id) ON DELETE CASCADE |
| `idempotency_key` | TEXT | NOT NULL, UNIQUE with token_id |
| `payload_hash` | TEXT | NOT NULL, SHA-256 of image bytes |
| `response_json` | JSONB | NOT NULL, cached response |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `expires_at` | TIMESTAMPTZ | NOT NULL, default now() + 24 hours |

### `grocery_lists`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL, FK → auth.users(id) |
| `name` | TEXT | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |
| `completed_at` | TIMESTAMPTZ | Nullable |

### `grocery_items`
| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK |
| `list_id` | UUID | NOT NULL, FK → grocery_lists(id) |
| `recipe_id` | UUID | FK → recipes(id), nullable |
| `position` | INT | 1-based |
| `quantity` | TEXT | Nullable |
| `unit` | TEXT | Nullable |
| `name` | TEXT | NOT NULL |
| `checked` | BOOLEAN | Default false |

### Materialized View: `recipe_search_index`
- Weighted tsvector: title (A) + ingredients (B)
- GIN index on search_vector
- Auto-refreshed via triggers on `recipes` and `recipe_ingredients`

### RPC Functions
| Function | Purpose | Auth |
|----------|---------|------|
| `confirm_recipe_draft(...)` | Atomic draft → recipe conversion | User JWT (`auth.uid()`) |
| `search_recipes_fts(...)` | Full-text search with ranking | Service role |

### Storage Bucket
- Name: `recipe-images`
- Path pattern: `{user_id}/{uuid}.{ext}`
- Signed URL TTL: 1 hour

---

## API Endpoints

### Authentication: Supabase JWT
All endpoints below require `Authorization: Bearer <supabase_jwt>` unless noted.

| Method | Path | Request | Response | Notes |
|--------|------|---------|----------|-------|
| GET | `/health` | — | `{ status: "ok" }` | No auth |
| **Recipes** |
| GET | `/api/recipes` | `?limit=&offset=` | `RecipeSearchResult[]` | |
| GET | `/api/recipes/search` | `?q=&limit=` | `RecipeSearchResult[]` | |
| GET | `/api/recipes/{id}` | — | `RecipeDetailResponse` | 404 if not found/owned |
| DELETE | `/api/recipes/{id}` | — | 204 | Deletes recipe + storage |
| POST | `/api/recipes/capture` | `FormData(image)` | `CaptureResponse` | **Capture token auth only** (not JWT) |
| **Drafts** |
| POST | `/api/drafts/capture` | `FormData(image)` | `DraftResponse` | JWT auth |
| GET | `/api/drafts/{id}` | — | `DraftResponse` | |
| POST | `/api/drafts/{id}/confirm` | `DraftConfirmRequest?` | `RecipeDetailResponse` | 410 if expired |
| DELETE | `/api/drafts/{id}` | — | 204 | |
| **Tokens** |
| POST | `/api/tokens` | `CaptureTokenCreate` | `CaptureTokenCreated` (201) | Plaintext token shown once |
| GET | `/api/tokens` | — | `CaptureTokenResponse[]` | No secrets returned |
| DELETE | `/api/tokens/{id}` | — | 204 | Sets revoked_at |
| **Storage** |
| GET | `/api/storage/image/{path}` | — | 302 → signed URL | Path must start with user_id/ |
| **Grocery** |
| GET | `/api/grocery/lists` | `?limit=` | `GroceryListResponse[]` | |
| POST | `/api/grocery/remake` | `RemakeRequest` | `GroceryListDetailResponse` (201) | Creates list from recipe |
| GET | `/api/grocery/lists/{id}` | — | `GroceryListDetailResponse` | |
| DELETE | `/api/grocery/lists/{id}` | — | 204 | |
| PATCH | `/api/grocery/items/{id}` | `ToggleItemRequest` | `GroceryItemResponse` | |

### Capture Endpoint Details (`POST /api/recipes/capture`)
- Auth: `Bearer tl_cap_...` (capture token, NOT Supabase JWT)
- Required header: `Idempotency-Key` (1-100 chars, no whitespace)
- Optional query: `source` (web|shortcuts|mobile_app|share_extension)
- Max upload: 10MB
- Accepted types: JPEG, PNG, GIF, WEBP, PDF
- Flow: token verify → idempotency check → rate limit (60/hr) → parse → store
- Response: `{ capture_id, recipe_id, status: "complete", view_url }`

---

## Frontend → Backend Contract

### Image Key Aliasing
The DB column is `image_path`. The backend Pydantic model renames it to `image_storage_key` via `validation_alias`. The frontend accepts both names in Zod schemas and normalizes to `image_key` via `normalizeImageKey()`.

```
DB column:     image_path
Python model:  image_storage_key (validation_alias="image_path")
Zod schema:    accepts both image_storage_key and image_path
Normalized:    image_key (via normalizeImageKey)
```

### API Proxy
`next.config.ts` rewrites `/api/*` → `${NEXT_PUBLIC_API_BASE_URL}/api/*`. The frontend calls `/api/...` paths and Next.js proxies to the FastAPI backend.

### Type Mapping (Python → TypeScript)
| Python (api/models/) | TypeScript (lib/api/schemas.ts) |
|----------------------|-------------------------------|
| `RecipeDetailResponse` | `recipeDetailResponseSchema` / `RecipeDetailResponse` |
| `RecipeSearchResult` | `recipeSearchResultSchema` / `RecipeSearchResult` |
| `DraftResponse` | `draftResponseSchema` / `DraftResponse` |
| `DraftConfirmRequest` | `draftConfirmRequestSchema` / `DraftConfirmRequest` |
| `CaptureTokenResponse` | `captureTokenResponseSchema` / `CaptureTokenResponse` |
| `CaptureTokenCreated` | `captureTokenCreatedSchema` / `CaptureTokenCreated` |
| `CaptureTokenCreate` | `captureTokenCreateSchema` / `CaptureTokenCreate` |
| `GroceryListResponse` | `groceryListResponseSchema` / `GroceryListResponse` |
| `GroceryListDetailResponse` | `groceryListDetailResponseSchema` / `GroceryListDetailResponse` |
| `GroceryItemResponse` | `groceryItemResponseSchema` / `GroceryItemResponse` |
| `RemakeRequest` | `remakeRequestSchema` / `RemakeRequest` |
| `ToggleItemRequest` | `toggleItemRequestSchema` / `ToggleItemRequest` |
| `CaptureResponse` | No frontend Zod schema (capture endpoint uses token auth, not web UI) |

---

## Error Handling

### Backend (Python)
```
TastelogError (base)
├── ParsingError          # Claude parse failures
├── ImageProcessingError  # Image/PDF encoding failures
├── RecipeNotFoundError
├── DraftNotFoundError
├── DraftExpiredError
├── GroceryListNotFoundError
├── StorageError          # Supabase storage/DB failures
├── TokenAuthError (base)
│   ├── InvalidTokenError
│   ├── RateLimitExceededError
│   └── RateLimitUnavailableError
├── IdempotencyError (base)
│   ├── IdempotencyConflictError   # Same key, different payload (409)
│   └── IdempotencyServiceError    # DB unavailable (503)
└── JWTVerificationError
```

### Frontend (TypeScript)
```
ApiError (class)
  kind: "network" | "timeout" | "http" | "validation" | "unknown"
  status?: number
  detail?: FastApiDetail
  cause?: unknown

Factory functions:
  apiErrorFromHttp()       # HTTP response errors
  apiErrorFromNetwork()    # Fetch failures
  apiErrorFromTimeout()    # Request timeouts
  apiErrorFromValidation() # Zod schema mismatches
```

---

## Authentication

| Method | Used By | Header |
|--------|---------|--------|
| Supabase JWT | Web UI (all endpoints except /capture) | `Authorization: Bearer <jwt>` |
| Capture token | iOS Shortcuts, mobile | `Authorization: Bearer tl_cap_...` |
| Dev bypass | Local development only | `DEV_AUTH_BYPASS=true` + `TEST_USER_ID` |

---

## Build & Dev Commands

### API (Python)
```bash
make dev            # uvicorn api.main:app --reload
make test           # pytest tests/ -v
make deps           # Regenerate requirements.txt from requirements.in
make sync           # Install locked deps
```

### Web (TypeScript)
```bash
cd tastelog-web
npm run dev          # Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm run test         # vitest run
npm run test:watch   # vitest watch
npx tsc --noEmit     # Type check (no output)
```

### Deployment
- API: Railway (auto-deploy from main, health check at `/health`)
- Web: Vercel (auto-deploy from main)

---

## Environment Variables

### API (.env)
| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service role JWT (validated on startup) |
| `SUPABASE_ANON_KEY` | For user clients | Anon key for user-scoped clients |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `TEST_USER_ID` | Dev only | UUID for dev auth bypass |
| `DEV_AUTH_BYPASS` | Dev only | Skip JWT verification (development env only) |
| `ENVIRONMENT` | No | development / staging / production (default: development) |
| `LOG_LEVEL` | No | Default: INFO |
| `CORS_ORIGINS` | No | Comma-separated origins |
| `SENTRY_DSN` | No | Sentry error tracking |

### Web (tastelog-web/.env.local)
| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | Yes | Backend URL for API proxy |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry browser DSN |

---

## Key Dependencies

### Python (requirements.in)
| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework |
| `uvicorn[standard]` | ASGI server |
| `pydantic` / `pydantic-settings` | Validation, config |
| `supabase` | Database + storage client |
| `anthropic` | Claude API |
| `python-jose[cryptography]` / `PyJWT` | JWT verification |
| `httpx` | Async HTTP (JWKS fetch) |
| `pillow` | Image processing |
| `filetype` | MIME detection |
| `pdf2image` | PDF rasterization (requires poppler) |
| `sentry-sdk[fastapi]` | Error tracking |

### TypeScript (package.json)
| Package | Purpose |
|---------|---------|
| `next` 16.1.4 | Framework (App Router) |
| `react` 19.2.3 | UI |
| `@tanstack/react-query` | Data fetching + cache |
| `@supabase/ssr` + `@supabase/supabase-js` | Auth + DB client |
| `zod` 4.x | Runtime schema validation |
| `react-hook-form` | Form handling |
| `@sentry/nextjs` | Error tracking |
| `tailwindcss` 4 | Styling |
| `lucide-react` | Icons |
| Radix UI (checkbox, label, slot) | Accessible primitives |
| `vitest` | Testing |

---

## Test Coverage

### Python (tests/)
| File | Tests | Coverage |
|------|-------|----------|
| `test_api.py` | 4 | Health check, request validation (422s) |
| `test_auth.py` | 10 | JWT verification (valid, expired, wrong aud/iss, bad kid, wrong algo, JWKS fetch fail) |
| `test_drafts.py` | 8 | Draft route validation (422s), auth requirements (401s), content type validation |
| `test_cli.py` | 1 | CLI module import verification |

### TypeScript (tastelog-web)
No frontend tests exist yet. Vitest is configured but `src/**/*.test.ts` has no matches.

---

## Design Patterns

### Ingredient Scaling (lib/ingredients/)
- **Rational arithmetic**: Exact BigInt fractions (no floating point drift)
- **Classification**: Each ingredient is categorized as `numeric` / `container` / `counted` / `qualifier` / `unparsed`
- **Scaling rules**: numeric/container scale exactly, counted items round to nearest integer, qualifiers are unscaled
- **Formatting**: Proper pluralization, "(rounded)" annotations, "not scaled" badges

### API Client (lib/api/client.ts)
- All responses validated against Zod schemas at runtime
- Timeout: 20s default via AbortController
- Auth token attached automatically from Supabase session
- Structured error types (not raw fetch errors)

### Supabase Client Strategy
- **Service-role**: Singleton, cached — for server operations that bypass RLS
- **User-scoped**: Per-request, not cached — enforces RLS via user JWT
- **Browser**: Lazy singleton via Proxy — defers creation until first property access
