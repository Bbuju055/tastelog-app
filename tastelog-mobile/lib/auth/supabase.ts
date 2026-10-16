import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { env } from "../config";

let _supabase: SupabaseClient | null = null;

/**
 * Get the Supabase client singleton.
 * Uses AsyncStorage for session persistence across app restarts.
 */
export function getSupabaseClient(): SupabaseClient {
  if (_supabase) return _supabase;

  _supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      storage: AsyncStorage,
      storageKey: "tastelog:supabase",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  return _supabase;
}

/**
 * Get current session access token for API calls.
 * Returns null if not authenticated or on any error (fail closed).
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const client = getSupabaseClient();
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
