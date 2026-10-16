import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "./supabase";
import { getCaptureTokenId, removeCaptureToken } from "./storage";
import { revokeCaptureToken } from "../api/endpoints";
import { provisionAndStoreCaptureToken } from "./tokenOrchestrator";

// Foreground re-provision intentionally deferred.
// See follow-up ticket.

/**
 * Explicit sign-up outcome (15.3.3): with email confirmation enabled,
 * Supabase returns no session — the caller must know that to show a
 * truthful "check your email" state instead of silently staying on login.
 */
export type SignUpResult = {
  sessionCreated: boolean;
};

type SessionContextValue = {
  session: Session | null;
  isLoading: boolean;
  captureTokenError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [captureTokenError, setCaptureTokenError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /**
   * The authenticated identity the cached React Query data belongs to.
   * `null` means "no authenticated user's data is cached".
   */
  const cachedUserIdRef = useRef<string | null>(null);

  /**
   * Single authoritative rule for user-scoped cache isolation (15.3.3):
   * cached data is dropped whenever the authenticated identity LEAVES — sign
   * out, server-side revocation, refresh failure, or a switch to a different
   * account. Deliberately NOT keyed on the event name, so an identity change
   * arriving by any route is covered.
   *
   * - boot with no prior identity (null → A): nothing cached to drop;
   * - token refresh for the same user (A → A): no clear, cache stays warm;
   * - A → null or A → B: clear, and always BEFORE `setSession` commits the
   *   new identity, so the replacement account can never render account A's
   *   data — not even for one frame.
   */
  const syncCachedIdentity = useCallback(
    (nextSession: Session | null) => {
      const nextUserId = nextSession?.user?.id ?? null;
      const cachedUserId = cachedUserIdRef.current;
      if (cachedUserId !== null && cachedUserId !== nextUserId) {
        queryClient.clear();
      }
      cachedUserIdRef.current = nextUserId;
    },
    [queryClient],
  );

  useEffect(() => {
    const client = getSupabaseClient();
    let isMounted = true;

    (async () => {
      try {
        const { data } = await client.auth.getSession();
        if (!isMounted) return;
        syncCachedIdentity(data.session);
        setSession(data.session);
      } finally {
        if (!isMounted) return;
        setIsLoading(false);
      }
    })();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, newSession) => {
      syncCachedIdentity(newSession);
      setSession(newSession);
      if (newSession) {
        provisionAndStoreCaptureToken()
          .then((result) => {
            if (!isMounted) return;
            if (result.success) {
              setCaptureTokenError(null);
            } else {
              setCaptureTokenError(result.error);
            }
          })
          .catch((err) => {
            if (!isMounted) return;
            setCaptureTokenError(`Unexpected provisioning error: ${String(err)}`);
          });
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [syncCachedIdentity]);

  const signIn = useCallback(async (email: string, password: string) => {
    const client = getSupabaseClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string): Promise<SignUpResult> => {
      const client = getSupabaseClient();
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      return { sessionCreated: data.session != null };
    },
    [],
  );

  const resetPassword = useCallback(async (email: string) => {
    const client = getSupabaseClient();
    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const client = getSupabaseClient();

    // 1. Read tokenId before clearing local stores
    let tokenId: string | null = null;
    try {
      tokenId = await getCaptureTokenId();
    } catch {
      // If we can't read the ID, proceed — revoke is best-effort
    }

    // 2. Best-effort server revoke (non-blocking)
    if (tokenId) {
      revokeCaptureToken(tokenId).catch(() => {});
    }

    // 3. Clear SecureStore + App Group
    let tokenClearError: unknown = null;
    try {
      await removeCaptureToken();
    } catch (e) {
      tokenClearError = e;
    }

    // 4. Supabase signOut
    const { error } = await client.auth.signOut();
    if (error) throw error;

    // 5. Confirmed sign-out: drop every cached query (15.3.3 cache
    //    isolation). Runs only after Supabase signOut succeeded — a failed
    //    sign-out keeps the session AND its cache, and must not pretend the
    //    user is signed out.
    //
    //    Supabase also emits SIGNED_OUT, which reaches `syncCachedIdentity`
    //    and clears again. That duplicate is intentional and harmless
    //    (clearing an empty cache is a no-op, and both paths are tested):
    //    this call guarantees the explicit, user-initiated sign-out clears
    //    even if the event is missed, while the listener covers the
    //    identity transitions that never come through this helper at all
    //    (revocation, refresh failure, account switch).
    syncCachedIdentity(null);
    queryClient.clear();

    // If signOut succeeded but token clear failed, surface it
    if (tokenClearError) throw tokenClearError;
  }, [queryClient, syncCachedIdentity]);

  const value = useMemo(
    () => ({ session, isLoading, captureTokenError, signIn, signUp, resetPassword, signOut }),
    [session, isLoading, captureTokenError, signIn, signUp, resetPassword, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}
