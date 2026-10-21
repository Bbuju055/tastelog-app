# Web client

Next.js / React, with TanStack Query and Zod. Start with the [root demo instructions](../README.md) for a working backend and login.

To connect to another backend, run these commands here:

```bash
npm ci
cp -n .env.example .env.local
```

Edit `.env.local`: set the API URL and Supabase URL/anon key for authenticated cookbook access, then run `npm run dev`. The `/api/*` rewrite is in [next.config.ts](next.config.ts). Never put service-role keys in frontend settings.

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Pages are in [app/](app/), response schemas in [src/lib/api/schemas.ts](src/lib/api/schemas.ts), and exact-fraction scaling in [src/lib/ingredients/](src/lib/ingredients/).
