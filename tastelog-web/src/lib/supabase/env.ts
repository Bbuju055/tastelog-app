/**
 * Supabase environment detection.
 *
 * Shared module safe for both browser and server imports.
 */

/**
 * Check if Supabase env vars are configured (safe, no throw).
 * Treats empty/whitespace-only strings as missing (Railway may set "").
 */
export function hasSupabaseEnv(): boolean {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  return url.length > 0 && key.length > 0;
}
