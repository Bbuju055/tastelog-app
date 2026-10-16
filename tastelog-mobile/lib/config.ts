import { z } from "zod";

const EnvSchema = z.object({
  EXPO_PUBLIC_API_BASE_URL: z.string().trim().url(),
  // Phase 13.5 feature flag: when EXACTLY "true" (no trim, no case fold),
  // mobile clients route Riff turns to POST /api/recipes/{id}/riff/stream
  // (SSE) via react-native-sse. Default off; sync /riff endpoint is used
  // otherwise. Strict equality is intentional: "TRUE", " true ", "1",
  // "yes", "false", "", and unset all resolve to false. This avoids
  // silently enabling streaming on capitalization or whitespace mistakes.
  EXPO_PUBLIC_RIFF_STREAMING: z.preprocess(
    (v) => v === "true",
    z.boolean(),
  ),
  EXPO_PUBLIC_WEB_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().url().optional(),
  ),
  EXPO_PUBLIC_SUPABASE_URL: z.string().trim().url(),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
  EXPO_PUBLIC_SENTRY_DSN: z.string().trim().optional().default(""),
  // Build 5 Class B diagnostic flag (docs/build5-classb-native-back-
  // diagnostic-plan.md section 4.B.8): diagnostics exist ONLY when the value
  // is exactly "1" (Build 6 diagnostic profile). Default "0" keeps every
  // customer build free of diagnostic UI, listeners and storage access.
  EXPO_PUBLIC_NAV_DIAGNOSTICS: z.string().default("0"),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  // On Expo, EXPO_PUBLIC_* are available via process.env at runtime.
  const raw = {
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_RIFF_STREAMING: process.env.EXPO_PUBLIC_RIFF_STREAMING,
    EXPO_PUBLIC_WEB_BASE_URL: process.env.EXPO_PUBLIC_WEB_BASE_URL,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
    EXPO_PUBLIC_NAV_DIAGNOSTICS: process.env.EXPO_PUBLIC_NAV_DIAGNOSTICS,
  };

  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[tastelog-mobile] Invalid env:\n${issues}`);
  }
  return parsed.data;
}

export const env = parseEnv();
