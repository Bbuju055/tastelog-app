/**
 * Server Supabase client tests.
 *
 * Notes:
 * - createSupabaseServerClient() is async because Next.js cookies() is async in App Router.
 * - We mock next/headers cookies() to return a minimal cookie store.
 * - We stub @supabase/ssr createServerClient so we don't require real Supabase internals.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock next/headers cookies() as async (Next.js App Router)
vi.mock("next/headers", () => {
  return {
    cookies: () =>
      Promise.resolve({
        get: () => undefined,
        set: () => undefined,
      }),
  };
});

// Stub createServerClient so the test is stable and doesn't depend on Supabase implementation
vi.mock("@supabase/ssr", () => {
  return {
    createServerClient: vi.fn(() => ({ __mockSupabase: true })),
  };
});

describe("createSupabaseServerClient", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("builds without throwing", async () => {
    // These are required by src/lib/config.ts which validates on import.
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8001";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    const mod = await import("./server");

    await expect(mod.createSupabaseServerClient()).resolves.toBeDefined();
  });
});
