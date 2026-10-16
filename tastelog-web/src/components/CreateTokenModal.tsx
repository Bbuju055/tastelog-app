// src/components/CreateTokenModal.tsx
"use client";

/**
 * Create Capture Token Modal
 *
 * UX Rules:
 * - Token value shown ONCE at creation, never again
 * - Must copy token before closing (or acknowledge loss)
 * - No editing existing tokens (create-only)
 *
 * Parent must remount modal on open (e.g., via key) to reset internal state.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type SyntheticEvent,
} from "react";

import { createCaptureToken } from "@/lib/api/endpoints";
import type { CaptureTokenCreated } from "@/lib/api/schemas";
import { TOKENS_QUERY_KEY } from "@/lib/queryKeys";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CreateTokenModalProps = {
  open: boolean;
  onClose: () => void;
};

type ModalState =
  | { step: "form" }
  | { step: "success"; token: CaptureTokenCreated; copied: boolean };

export default function CreateTokenModal({
  open,
  onClose,
}: CreateTokenModalProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ModalState>({ step: "form" });
  const [name, setName] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // Dialog open/close lifecycle (no state writes)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [open]);

  // Focus management (no state writes)
  useEffect(() => {
    if (!open) return;

    if (state.step === "form") {
      nameInputRef.current?.focus();
    } else if (state.step === "success") {
      tokenInputRef.current?.focus();
      tokenInputRef.current?.select();
    }
  }, [open, state.step]);

  const createMutation = useMutation({
    mutationFn: () => createCaptureToken({ name: name.trim() }),
    onMutate: () => {
      setErrorMsg(null);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
      setState({ step: "success", token: data, copied: false });
    },
    onError: (err) => {
      setErrorMsg(apiErrorMessage(err));
    },
  });

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      setErrorMsg(null);

      const trimmedName = name.trim();
      if (!trimmedName) {
        setErrorMsg("Token name is required.");
        return;
      }

      if (trimmedName.length > 100) {
        setErrorMsg("Token name must be 100 characters or less.");
        return;
      }

      createMutation.mutate();
    },
    [name, createMutation]
  );

  const handleCopy = useCallback(async () => {
    if (state.step !== "success") return;

    if (!navigator.clipboard?.writeText) {
      setErrorMsg(
        "Copy not supported here. Please select the token and copy manually."
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(state.token.token);
      setState((prev) =>
        prev.step === "success" ? { ...prev, copied: true } : prev
      );
    } catch {
      setErrorMsg(
        "Failed to copy. Please select the token and copy manually."
      );
    }
  }, [state]);

  const handleClose = useCallback(() => {
    if (state.step === "success" && !state.copied) {
      const confirmed = window.confirm(
        "You haven't copied the token. Are you sure you want to close? " +
          "The token value will be lost forever."
      );
      if (!confirmed) return;
    }
    onClose();
  }, [state, onClose]);

  // Handle native dialog cancel event (Escape key via browser)
  const handleCancel = useCallback(
    (e: SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      handleClose();
    },
    [handleClose]
  );

  // Handle backdrop click
  const handleDialogClick = useCallback(
    (e: MouseEvent<HTMLDialogElement>) => {
      if (e.target === dialogRef.current) {
        handleClose();
      }
    },
    [handleClose]
  );

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleDialogClick}
      onCancel={handleCancel}
      className="fixed inset-0 z-50 m-0 h-full w-full max-h-full max-w-full bg-black/50 p-4 backdrop:bg-transparent"
    >
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-lg">
          {state.step === "form" ? (
            <>
              <h2 className="text-lg font-semibold text-neutral-900">
                Create Capture Token
              </h2>
              <p className="mt-1 text-sm text-neutral-600">
                Create a token to enable iOS Shortcuts or other integrations to
                capture recipes.
              </p>

              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="token-name">Token Name</Label>
                  <Input
                    ref={nameInputRef}
                    id="token-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. iPhone Shortcuts"
                    disabled={createMutation.isPending}
                    autoComplete="off"
                  />
                  <p className="text-xs text-neutral-500">
                    A descriptive name to identify this token.
                  </p>
                </div>

                {errorMsg ? (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                    role="alert"
                  >
                    {errorMsg}
                  </div>
                ) : null}

                <div className="flex justify-end gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleClose}
                    disabled={createMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending ? "Creating…" : "Create Token"}
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-neutral-900">
                Token Created
              </h2>

              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-sm font-medium text-amber-800">
                  Copy this token now. You will not see it again.
                </p>
              </div>

              <div className="mt-4 space-y-1.5">
                <Label htmlFor="token-value">Token Value</Label>
                <div className="flex gap-2">
                  <Input
                    ref={tokenInputRef}
                    id="token-value"
                    type="text"
                    value={state.token.token}
                    readOnly
                    className="font-mono text-sm"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    type="button"
                    variant={state.copied ? "outline" : "default"}
                    onClick={handleCopy}
                    className="shrink-0"
                  >
                    {state.copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
                <p className="text-xs text-neutral-600">
                  <strong>iOS Shortcuts Setup:</strong> Open Keychain, add a new
                  password with name{" "}
                  <code className="rounded bg-neutral-200 px-1">
                    tastelog_capture_token
                  </code>
                  , and paste this token as the value.
                </p>
              </div>

              {errorMsg ? (
                <div
                  className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                  role="alert"
                >
                  {errorMsg}
                </div>
              ) : null}

              <div className="mt-4 flex justify-end">
                <Button type="button" onClick={handleClose}>
                  {state.copied ? "Done" : "Close Anyway"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
