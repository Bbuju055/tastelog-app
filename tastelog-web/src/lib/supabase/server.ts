/**
 * Server-side Supabase client.
 *
 * - For Server Components, Route Handlers, and Middleware
 * - Uses cookie-based auth via @supabase/ssr
 * - Must NOT be imported in client components
 * - Throws if Supabase env is not configured
 */

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { hasSupabaseEnv } from "@/lib/supabase/env";

type CookieOptions = Record<string, unknown>;

export async function createSupabaseServerClient() {
  if (!hasSupabaseEnv()) {
    throw new Error(
      "Supabase env not configured (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY)."
    );
  }

  // Next.js App Router cookies() is async
  const cookieStore = await cookies();

  // Safe to assert: hasSupabaseEnv() guarantees these are set
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          cookieStore.set({ name, value: "", ...options });
        },
      },
    }
  );
}
