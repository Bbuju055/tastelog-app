# iOS client

Expo with a native iOS project and Swift share extension. Requires Node 24, macOS and Xcode. Expo Go cannot load the native modules.

Run the backend using the [root demo instructions](../README.md), then from this directory:

```bash
npm ci
cp -n .env.example .env
```

Set the API and Supabase URL/anon key in `.env`; local demo values are in the generated root `.env.demo`. Use addresses reachable from your simulator/device. `localhost` on a physical phone points to the phone, not your Mac. See [.env.example](.env.example) for optional settings. Never use the service-role key in this app.

Build and launch:

```bash
SENTRY_DISABLE_AUTO_UPLOAD=true npx expo run:ios
```

This skips Sentry uploads for local builds. For later sessions with the development build installed:

```bash
npx expo start --dev-client
```

Checks:

```bash
npx tsc --noEmit
npm test
```

Screens live in [app/](app/); API/error helpers in [lib/](lib/); native sharing in [ios/TastelogShareExtension/](ios/TastelogShareExtension/).

The app stores its Supabase session in AsyncStorage. The share extension uses a separate revocable capture token stored securely, not the user's JWT. In-app and extension draft capture retain an idempotency key per attempt. See [capture flow and limits](../docs/architecture.md).
