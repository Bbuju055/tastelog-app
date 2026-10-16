/**
 * Environment configuration with Zod validation.
 *
 * Validates required env vars at import time to fail fast on misconfiguration.
 * All public env vars use NEXT_PUBLIC_ prefix (exposed to browser).
 */

import { z } from "zod";

const envSchema = z.object({
  // Backend API base URL for rewrites
  NEXT_PUBLIC_API_BASE_URL: z.string().url().min(1),

  // Supabase client config (optional: app runs unauthenticated when missing)
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // Observability (optional)
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().min(1).optional(),
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  NEXT_PUBLIC_SENTRY_RELEASE: z.string().min(1).optional(),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,

    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  });

  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  return parsed.data;
}

/**
 * Validated environment variables.
 * Import this instead of accessing process.env directly.
 */
export const env = validateEnv();
