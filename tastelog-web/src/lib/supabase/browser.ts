// src/lib/supabase/browser.ts
/**
 * Browser Supabase client.
 *
 * IMPORTANT:
 * - Client-only: do not call from server components / middleware.
 * - Lazy initialization: avoids env validation at module load time (Next build analysis).
 * - Strict: throws on first access if required NEXT_PUBLIC_* env vars are missing.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { hasSupabaseEnv } from "./env";
export { hasSupabaseEnv };

let _supabase: SupabaseClient | null = null;

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new Error(
      "supabase/browser.ts was accessed on the server. Use the server Supabase client instead."
    );
  }
}

function getRequiredPublicEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY"): string {
  // Next inlines NEXT_PUBLIC_* for the client bundle at build time.
  // IMPORTANT: Must use literal property access, NOT bracket notation, for Next.js to inline.
  // Trim to handle Railway/Vercel empty-string or whitespace-only env vars.
  let raw: string | undefined;
  if (name === "NEXT_PUBLIC_SUPABASE_URL") {
    raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    raw = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. This value must be set for the browser bundle (NEXT_PUBLIC_*).`
    );
  }
  return value;
}

/**
 * Get the browser Supabase client singleton (lazy-created).
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  assertBrowser();

  if (_supabase) return _supabase;

  const url = getRequiredPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = getRequiredPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  // Middleware and server components read cookies, not localStorage.
  // Use the matching SSR client so a successful login survives navigation.
  _supabase = createBrowserClient(url, anonKey);

  return _supabase;
}

/**
 * Safe variant: returns null if Supabase env is not configured.
 * Still throws if called on the server.
 */
export function tryGetSupabaseBrowserClient(): SupabaseClient | null {
  assertBrowser();
  if (!hasSupabaseEnv()) return null;
  return getSupabaseBrowserClient();
}

/**
 * Back-compat export: many files may import { supabase }.
 * This Proxy defers client creation until first property access.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    assertBrowser();

    if (!hasSupabaseEnv()) {
      throw new Error(
        "Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). " +
          "This app supports unauthenticated mode. " +
          "Guard with hasSupabaseEnv() before accessing supabase.*, or use tryGetSupabaseBrowserClient() for optional auth."
      );
    }

    const client = getSupabaseBrowserClient();
    const value = client[prop as keyof SupabaseClient];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * Get current session access token for API calls.
 * Returns null if not authenticated or if Supabase is unavailable.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!hasSupabaseEnv()) return null;

  const client = getSupabaseBrowserClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}
