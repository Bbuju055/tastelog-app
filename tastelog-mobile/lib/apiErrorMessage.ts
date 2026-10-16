import type { ZodError } from "zod";

/**
 * Normalizes unknown error shapes into a safe, user-displayable message.
 * - Does NOT assume backend response shapes.
 * - Prefers explicit messages when present.
 * - Avoids leaking stacks / internals into UI.
 */
export function apiErrorMessage(err: unknown): string {
  if (!err) return "Something went wrong.";

  // Standard JS Error
  if (err instanceof Error) {
    return err.message || "Something went wrong.";
  }

  // ZodError (runtime validation)
  if (isZodError(err)) {
    const issue = err.issues?.[0];
    if (!issue) return "Invalid response format.";
    const path = issue.path?.length ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  }

  // Common "fetch wrapper" or "HTTP error" shapes
  if (isRecord(err)) {
    if (typeof err.message === "string" && err.message.trim()) return err.message;
    if (typeof err.error === "string" && err.error.trim()) return err.error;

    const status = typeof err.status === "number" ? err.status : null;
    const statusText = typeof err.statusText === "string" ? err.statusText : null;
    if (status && statusText) return `${status} ${statusText}`;
    if (status) return `Request failed (${status}).`;
  }

  return "Something went wrong.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isZodError(v: unknown): v is ZodError {
  if (!isRecord(v)) return false;
  return Array.isArray(v.issues);
}
