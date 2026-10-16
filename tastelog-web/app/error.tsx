// app/error.tsx
"use client";

import * as React from "react";
import Link from "next/link";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  // MUST NOT swallow stack traces silently.
  // Next.js will also surface some errors in overlays/logs, but we log explicitly.
  React.useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  const isDev = process.env.NODE_ENV !== "production";
  const digest = error?.digest ? `Digest: ${error.digest}` : null;

  return (
    <div className="min-h-[60vh] w-full px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-balance">Something went wrong</CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We hit an unexpected error. You can try again, or go back home.
            </p>

            {digest ? (
              <p className="text-xs text-muted-foreground">{digest}</p>
            ) : null}

            {isDev ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer select-none text-sm">
                  Technical details (dev only)
                </summary>
                <pre className="mt-3 overflow-auto text-xs leading-relaxed">
                  {String(error?.stack || error?.message || error)}
                </pre>
              </details>
            ) : null}
          </CardContent>

          <CardFooter className="flex flex-wrap gap-2">
            <Button type="button" onClick={reset}>
              Retry
            </Button>

            <Button asChild type="button" variant="secondary">
              <Link href="/">Go home</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
