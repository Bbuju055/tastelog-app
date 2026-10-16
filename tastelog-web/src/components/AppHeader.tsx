// src/components/AppHeader.tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { apiErrorMessage } from "@/lib/useApiErrorMessage";
import { Button } from "@/components/ui/button";

type SessionUser = {
  email: string | null;
};

// Safe env check - does not throw, uses raw process.env
const supabaseAvailable =
  typeof process.env.NEXT_PUBLIC_SUPABASE_URL === "string" &&
  process.env.NEXT_PUBLIC_SUPABASE_URL.length > 0 &&
  typeof process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY === "string" &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.length > 0;

export default function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();

  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(supabaseAvailable);
  const [signingOut, setSigningOut] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseAvailable) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function load() {
      setErrorMsg(null);
      setLoading(true);
      try {
        const { supabase } = await import("@/lib/supabase/browser");
        const { data, error } = await supabase.auth.getUser();
        if (cancelled) return;

        if (error) {
          setErrorMsg(error.message);
          setUser(null);
        } else {
          setUser(data.user ? { email: data.user.email ?? null } : null);
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(apiErrorMessage(err));
        setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function subscribe() {
      if (cancelled) return;
      try {
        const { supabase } = await import("@/lib/supabase/browser");
        const { data: sub } = supabase.auth.onAuthStateChange(() => {
          load();
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      } catch (err) {
        // Auth subscription failed - non-fatal, dev-only warning
        if (process.env.NODE_ENV !== "production") {
          console.warn("Auth subscription failed", err);
        }
      }
    }

    load();
    subscribe();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  async function onSignOut() {
    if (!supabaseAvailable) return;

    setSigningOut(true);
    setErrorMsg(null);
    try {
      const { supabase } = await import("@/lib/supabase/browser");
      const { error } = await supabase.auth.signOut();
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      const next = pathname || "/";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      router.refresh();
    } catch (err) {
      setErrorMsg(apiErrorMessage(err));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-5">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Tastelog
          </Link>

          <nav className="flex items-center gap-3 text-sm text-neutral-600">
            <Link href="/add" className="hover:text-neutral-900">
              Add
            </Link>
            <Link href="/settings/tokens" className="hover:text-neutral-900">
              Tokens
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {!supabaseAvailable ? (
            <div className="text-xs text-amber-600">Auth unavailable</div>
          ) : loading ? (
            <div className="text-xs text-neutral-500">Loading…</div>
          ) : user ? (
            <>
              <div className="hidden text-xs text-neutral-500 sm:block">
                {user.email ?? "Signed in"}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={onSignOut}
                disabled={signingOut}
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
            </>
          ) : (
            <Button asChild size="sm">
              <Link href="/login?next=/">Sign in</Link>
            </Button>
          )}
        </div>
      </div>

      {errorMsg ? (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {errorMsg}
        </div>
      ) : null}
    </header>
  );
}
