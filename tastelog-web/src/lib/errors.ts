// src/lib/errors.ts

export type ApiErrorKind =
  | "network"
  | "timeout"
  | "http"
  | "validation"
  | "unknown";

export type FastApiDetail =
  | string
  | Array<unknown>
  | Record<string, unknown>
  | null
  | undefined;

export class ApiError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly status?: number;
  public readonly detail?: FastApiDetail;
  public readonly cause?: unknown;

  constructor(args: {
    message: string;
    kind: ApiErrorKind;
    status?: number;
    detail?: FastApiDetail;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.kind = args.kind;
    this.status = args.status;
    this.detail = args.detail;
    this.cause = args.cause;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * Normalize FastAPI `{ detail }` into a safe, user-displayable message.
 * - No silent fallbacks: if we can't derive a useful message, return null.
 */
export function formatFastApiDetail(detail: FastApiDetail): string | null {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail) && detail.code === "RECIPE_INCOMPLETE") return "Add at least one ingredient and one instruction from the source before saving.";
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    switch (detail.code) {
      case "PDF_MULTIPAGE_UNSUPPORTED": return "Multi-page PDFs aren't supported yet. No recipe was saved. Use the recipe's source URL instead.";
      case "PDF_PAGE_COUNT_FAILED": return "We couldn't verify this PDF's page count. No recipe was saved. Use an unencrypted single-page PDF or the recipe's source URL instead.";
    }
  }

  if (Array.isArray(detail) && detail.length > 0) {
    // Common FastAPI 422 shape: [{ loc, msg, type }, ...]
    const msgs: string[] = [];
    for (const item of detail) {
      if (
        item &&
        typeof item === "object" &&
        "msg" in item &&
        typeof (item as { msg?: unknown }).msg === "string"
      ) {
        const { msg } = item as { msg: string };
        msgs.push(msg);
      } else if (typeof item === "string" && item.trim()) {
        msgs.push(item);
      }
    }
    if (msgs.length > 0) return msgs.join("; ");
  }

  return null;
}

export function apiErrorFromHttp(args: {
  status: number;
  detail?: FastApiDetail;
  fallbackMessage?: string;
}): ApiError {
  const msg =
    formatFastApiDetail(args.detail) ??
    args.fallbackMessage ??
    `Request failed with status ${args.status}.`;

  return new ApiError({
    kind: "http",
    status: args.status,
    detail: args.detail,
    message: msg,
  });
}

export function apiErrorFromValidation(args: {
  message: string;
  cause?: unknown;
}): ApiError {
  return new ApiError({
    kind: "validation",
    message: args.message,
    cause: args.cause,
  });
}

export function apiErrorFromNetwork(args: {
  message: string;
  cause?: unknown;
}): ApiError {
  return new ApiError({
    kind: "network",
    message: args.message,
    cause: args.cause,
  });
}

export function apiErrorFromTimeout(args?: { cause?: unknown }): ApiError {
  return new ApiError({
    kind: "timeout",
    message: "Request timed out.",
    cause: args?.cause,
  });
}
