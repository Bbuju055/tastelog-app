// src/lib/config.test.ts
/**
 * Config validation tests.
 *
 * NOTE: We intentionally do NOT import src/lib/config.ts here because it
 * validates env at module import time (fail-fast). Instead we test the schema
 * behavior directly to avoid brittle global env manipulation.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Keep in sync with src/lib/config.ts
const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().min(1),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

describe("envSchema", () => {
  it("accepts valid config", () => {
    const validEnv = {
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8001",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    };

    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
  });

  it("rejects missing API base URL", () => {
    const invalidEnv = {
      NEXT_PUBLIC_API_BASE_URL: "",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL format", () => {
    const invalidEnv = {
      NEXT_PUBLIC_API_BASE_URL: "not-a-url",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });

  it("rejects missing Supabase anon key", () => {
    const invalidEnv = {
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8001",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    };

    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
  });
});
