# Tastelog Web

Next.js 16 / React 19 frontend for Tastelog. Talks to the FastAPI backend through an `/api/*` rewrite (see `next.config.ts`), validates every response with Zod, and uses TanStack Query for data fetching.

## Run

```bash
npm ci
cp .env.example .env.local   # points at http://localhost:8000 by default
npm run dev                  # http://localhost:3000
```

## Test

```bash
npm test        # vitest, 151 tests
npm run lint
```

Notable code: `src/lib/ingredients/` is an exact-fraction ingredient scaling engine (BigInt rationals, no floats). `src/lib/api/schemas.ts` mirrors the Python Pydantic models.
