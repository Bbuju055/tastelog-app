// app/login/page.tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { hasSupabaseEnv } from "@/lib/supabase/env";
import { loginRedirectPath } from "@/lib/supabase/loginRedirect";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const searchParams = useSearchParams();

  const nextPath = searchParams.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // If already signed in, redirect immediately (prevents useless login screen).
  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Belt + suspenders: guard even inside async
      if (!hasSupabaseEnv()) {
        setCheckingSession(false);
        return;
      }

      try {
        const { supabase } = await import("@/lib/supabase/browser");
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;

        if (data.session) {
          window.location.replace(loginRedirectPath(nextPath, window.location.origin));
        }
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [nextPath]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);

    // Belt + suspenders: guard even inside handler
    if (!hasSupabaseEnv()) {
      setErrorMsg("Authentication is disabled for this deployment.");
      setSubmitting(false);
      return;
    }

    try {
      const { supabase } = await import("@/lib/supabase/browser");
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      // Discard prefetched logged-out redirects after the session cookie changes.
      window.location.replace(loginRedirectPath(nextPath, window.location.origin));
    } catch (err) {
      setErrorMsg(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSession) {
    return (
      <div className="text-sm text-neutral-700" aria-live="polite">
        Checking session…
      </div>
    );
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          required
        />
      </div>

      {errorMsg ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {errorMsg}
        </div>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>

      <div className="text-xs text-neutral-500">
        After sign-in, you&apos;ll be redirected to{" "}
        <code className="rounded bg-neutral-100 px-1 py-0.5">{nextPath}</code>.
      </div>
    </form>
  );
}

function AuthUnavailable() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in unavailable</CardTitle>
          <p className="text-sm text-neutral-600">
            Authentication is disabled because Supabase isn&apos;t configured
            for this deployment.
          </p>
        </CardHeader>
        <CardContent>
          <Link className="text-sm underline" href="/">
            Go back home
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  if (!hasSupabaseEnv()) {
    return <AuthUnavailable />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <p className="text-sm text-neutral-600">
            Sign in to access Tastelog.
          </p>
        </CardHeader>

        <CardContent>
          <Suspense
            fallback={
              <div className="text-sm text-neutral-700">Loading…</div>
            }
          >
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
