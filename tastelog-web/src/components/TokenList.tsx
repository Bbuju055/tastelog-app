// src/components/TokenList.tsx
"use client";

/**
 * Capture Token Management List
 *
 * Displays existing capture tokens with metadata and revocation.
 *
 * Rules:
 * - Tokens are display-only (no editing)
 * - Revocation is permanent (no undo)
 * - Token secrets are never shown (only at creation)
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { listCaptureTokens, revokeCaptureToken } from "@/lib/api/endpoints";
import type { CaptureTokenResponse } from "@/lib/api/schemas";
import { TOKENS_QUERY_KEY } from "@/lib/queryKeys";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type TokenItemProps = {
  token: CaptureTokenResponse;
  onRevoke: (tokenId: string) => void;
  revoking: boolean;
};

function formatDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

function getExpiryStatus(
  expiresAt: string | null,
  revokedAt: string | null
): { label: string; variant: "active" | "expired" | "revoked" } {
  if (revokedAt !== null) {
    return { label: "Revoked", variant: "revoked" };
  }

  if (expiresAt === null) {
    return { label: "Active (no expiry)", variant: "active" };
  }

  const expiry = new Date(expiresAt);
  const now = new Date();

  if (expiry <= now) {
    return { label: "Expired", variant: "expired" };
  }

  return { label: `Expires ${formatDateTime(expiresAt)}`, variant: "active" };
}

function TokenItem({ token, onRevoke, revoking }: TokenItemProps) {
  const status = getExpiryStatus(token.expires_at, token.revoked_at);
  const isInactive = status.variant !== "active";

  return (
    <div
      className={
        isInactive
          ? "rounded-lg border border-neutral-200 bg-neutral-50 p-4"
          : "rounded-lg border border-neutral-200 bg-white p-4"
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={
                isInactive
                  ? "text-sm font-medium text-neutral-500"
                  : "text-sm font-medium text-neutral-900"
              }
            >
              {token.name}
            </span>
            <span
              className={
                status.variant === "active"
                  ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700"
                  : status.variant === "expired"
                    ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700"
                    : "rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600"
              }
            >
              {status.label}
            </span>
          </div>

          <div className="space-y-0.5 text-xs text-neutral-500">
            <div>Created: {formatDateTime(token.created_at)}</div>
            {token.last_used_at ? (
              <div>Last used: {formatDateTime(token.last_used_at)}</div>
            ) : (
              <div>Last used: Never</div>
            )}
          </div>
        </div>

        {!isInactive ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRevoke(token.id)}
            disabled={revoking}
            className="shrink-0"
          >
            {revoking ? "Revoking…" : "Revoke"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type TokenListProps = {
  onCreateClick: () => void;
};

export default function TokenList({ onCreateClick }: TokenListProps) {
  const queryClient = useQueryClient();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: TOKENS_QUERY_KEY,
    queryFn: listCaptureTokens,
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => revokeCaptureToken(tokenId),
    onMutate: (tokenId) => {
      setErrorMsg(null);
      setRevokingId(tokenId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
    },
    onError: (err) => {
      setErrorMsg(apiErrorMessage(err));
    },
    onSettled: () => {
      setRevokingId(null);
    },
  });

  // Sort tokens by created_at desc for deterministic ordering
  const tokens = [...(tokensQuery.data ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Partition into active and inactive for display ordering
  const activeTokens = tokens.filter(
    (t) =>
      t.revoked_at === null &&
      (t.expires_at === null || new Date(t.expires_at) > new Date())
  );
  const inactiveTokens = tokens.filter(
    (t) =>
      t.revoked_at !== null ||
      (t.expires_at !== null && new Date(t.expires_at) <= new Date())
  );

  return (
    <Card className="border-neutral-200 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-neutral-200 py-4">
        <CardTitle className="text-base font-medium">Capture Tokens</CardTitle>
        <Button onClick={onCreateClick} size="sm">
          Create Token
        </Button>
      </CardHeader>

      <CardContent className="p-4">
        {tokensQuery.isLoading ? (
          <div className="py-8 text-center text-sm text-neutral-500">
            Loading tokens…
          </div>
        ) : tokensQuery.error ? (
          <div
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
          >
            {apiErrorMessage(tokensQuery.error)}
          </div>
        ) : tokens.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-sm text-neutral-600">
              No capture tokens yet.
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              Create a token to enable iOS Shortcuts or other integrations.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {activeTokens.map((token) => (
              <TokenItem
                key={token.id}
                token={token}
                onRevoke={(id) => revokeMutation.mutate(id)}
                revoking={revokingId === token.id}
              />
            ))}

            {inactiveTokens.length > 0 && activeTokens.length > 0 ? (
              <div className="pt-2">
                <div className="mb-2 text-xs font-medium text-neutral-500">
                  Inactive
                </div>
              </div>
            ) : null}

            {inactiveTokens.map((token) => (
              <TokenItem
                key={token.id}
                token={token}
                onRevoke={(id) => revokeMutation.mutate(id)}
                revoking={revokingId === token.id}
              />
            ))}
          </div>
        )}

        {errorMsg ? (
          <div
            className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
          >
            {errorMsg}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
