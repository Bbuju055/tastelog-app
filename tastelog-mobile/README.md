# Tastelog Mobile

React Native mobile app for Tastelog recipe capture.

---

## Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Framework | Expo (managed workflow) | SDK 54 | New Architecture enabled |
| Build | EAS Build | — | Dev/preview/production profiles |
| Navigation | Expo Router | v4 (SDK-bundled) | File-based routing |
| Data fetching | TanStack Query | 5.x | Matches web |
| Validation | Zod | 4.x | Matches web |
| Styling | NativeWind | 4.x | Tailwind 3.x (not 4.x) |
| Session storage | AsyncStorage | — | Supabase session persistence |
| Token storage | expo-secure-store | — | Capture token only |
| Auth | @supabase/supabase-js | ^2.x | Email/password, JWT |
| Recipe detail | react-native-webview | — | Renders web app URL |

---

## Threat Model

- The iOS Share Extension **never** uses the user's Supabase JWT.
- Extension auth uses **capture tokens only** (`tl_cap_*`).
- Capture tokens are stored in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
- Capture tokens are device-scoped and may be revoked server-side at any time.
- Supabase session is stored in AsyncStorage (app-only, not shared with extension).
- Token CRUD (list, create, revoke) uses user JWT auth.
- Capture calls use capture token auth + `Idempotency-Key` header.
- Draft capture (app and share extension) sends an `Idempotency-Key` per attempt; the API replays the same draft on a retry (migration 028).

---

## Auth Modes

| Context | Auth header | Storage |
|---------|------------|---------|
| App (recipe list, token CRUD) | `Bearer <supabase_jwt>` | AsyncStorage |
| Capture (extension, Shortcuts) | `Bearer tl_cap_*` | SecureStore |

---

## Dev Commands

```bash
# Start dev server
npx expo start

# iOS simulator
npx expo start --ios

# Type check
npx tsc --noEmit

# Run tests
npm test

# Install Expo-compatible dependency
npx expo install <package>
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_API_BASE_URL` | Yes | Backend API URL |
| `EXPO_PUBLIC_WEB_BASE_URL` | No | Web app URL (optional — enables "Open in Browser") |
| `EXPO_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `EXPO_PUBLIC_SENTRY_DSN` | No | Sentry DSN (planned) |

`EXPO_PUBLIC_API_BASE_URL` is used for all `/api/*` calls.
`EXPO_PUBLIC_WEB_BASE_URL` is optional. When set, enables "Open in Browser" for recipe detail. Not required for core app functionality.
