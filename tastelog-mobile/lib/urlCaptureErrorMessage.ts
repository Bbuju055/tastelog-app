import { type ApiError, isApiError } from "./errors";

export type URLCaptureErrorInfo = {
  title: string;
  body: string;
  retryable: boolean;
  /** For 409 duplicate responses — contains recipe_id or draft_id + title. */
  duplicate?: {
    type: "recipe" | "draft";
    id: string;
    title: string;
  };
};

/**
 * Map an error from the URL capture flow to a user-facing message.
 * URL-specific — separate from the photo capture error mapper.
 */
export function urlCaptureErrorMessage(err: unknown): URLCaptureErrorInfo {
  if (!isApiError(err)) {
    return {
      title: "Something went wrong",
      body: "An unexpected error occurred. Try again.",
      retryable: true,
    };
  }

  switch (err.kind) {
    case "timeout":
      return {
        title: "Page took too long",
        body: "The recipe page didn\u2019t respond in time. Try again.",
        retryable: true,
      };

    case "network":
      return {
        title: "No connection",
        body: "Check your internet and try again.",
        retryable: true,
      };

    case "validation":
      return {
        title: "Unexpected response",
        body: "Something unexpected happened. Try again.",
        retryable: true,
      };

    case "http":
      return mapHttpError(err);

    default:
      return {
        title: "Something went wrong",
        body: "An unexpected error occurred. Try again.",
        retryable: true,
      };
  }
}

/**
 * PROVIDER-S1: stable machine-readable capture error code, when present.
 * Returns null for string details, list details, and code-less objects
 * (including the 409 duplicate payload, which has no `code` key).
 */
function stableErrorCode(err: ApiError): string | null {
  const detail = err.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** Honest provider-outage copy — never blames the link or the user. */
const PROVIDER_UNAVAILABLE_INFO: URLCaptureErrorInfo = {
  title: "Recipe importer unavailable",
  body: "Recipe import is unavailable right now. Please try again later.",
  retryable: true,
};

const NO_RECIPE_INFO: URLCaptureErrorInfo = {
  title: "No recipe found",
  body: "We couldn\u2019t find a recipe on that page. Try a different link, or use photo capture instead.",
  retryable: false,
};

function mapHttpError(err: ApiError): URLCaptureErrorInfo {
  const status = err.status ?? 0;

  // PROVIDER-S1: prefer the stable machine-readable contract.
  const code = stableErrorCode(err);
  if (code !== null) {
    switch (code) {
      case "RECIPE_UNREADABLE":
        return NO_RECIPE_INFO;
      case "RECIPE_PROVIDER_UNAVAILABLE":
      case "RECIPE_PROVIDER_RATE_LIMITED":
      case "RECIPE_PROVIDER_TIMEOUT":
      case "RECIPE_PROVIDER_BAD_RESPONSE":
        return PROVIDER_UNAVAILABLE_INFO;
      default:
        return {
          title: "Something went wrong",
          body: "An unexpected error occurred. Try again.",
          retryable: true,
        };
    }
  }

  // FastAPI request-validation errors ship list-shaped detail — an
  // invalid/unexpected request, never a content judgment.
  if (Array.isArray(err.detail)) {
    return {
      title: "Unexpected request",
      body: "Something unexpected happened. Try again.",
      retryable: true,
    };
  }

  if (status === 400) {
    return {
      title: "Invalid URL",
      body: "Paste a full link starting with https://",
      retryable: false,
    };
  }

  if (status === 409) {
    return parse409(err);
  }

  if (status === 422) {
    // Legacy pre-PROVIDER-S1 string contract only.
    const detail = typeof err.detail === "string" ? err.detail.toLowerCase() : "";
    if (detail.includes("could not extract")) {
      return NO_RECIPE_INFO;
    }
    return {
      title: "Something went wrong",
      body: "An unexpected error occurred. Try again.",
      retryable: true,
    };
  }

  if (status === 429) {
    return {
      title: "Too many captures",
      body: "Wait a minute and try again.",
      retryable: true,
    };
  }

  if (status === 502) {
    // Code-less 502 with a string detail is the pre-existing page-fetch
    // failure (URLFetchError) — a problem with the page, not the provider.
    return {
      title: "Couldn\u2019t open page",
      body: "We couldn\u2019t load that page. Check the URL and try again.",
      retryable: true,
    };
  }

  if (status === 503 || status === 504) {
    // Provider-shaped statuses without a machine code.
    return PROVIDER_UNAVAILABLE_INFO;
  }

  if (status >= 500) {
    return {
      title: "Something went wrong",
      body: "Our servers hit a problem. Try again in a moment.",
      retryable: true,
    };
  }

  return {
    title: "Something went wrong",
    body: "An unexpected error occurred. Try again.",
    retryable: true,
  };
}

/**
 * Parse a 409 duplicate response. The backend returns:
 *   { detail: "Recipe already saved", recipe_id: "...", title: "..." }
 * or:
 *   { detail: "Pending draft exists", draft_id: "...", title: "..." }
 */
function parse409(err: ApiError): URLCaptureErrorInfo {
  const detail = err.detail;

  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const obj = detail as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title : "this recipe";

    if (typeof obj.recipe_id === "string") {
      return {
        title: "Already saved",
        body: `You already saved \u201C${title}\u201D.`,
        retryable: false,
        duplicate: { type: "recipe", id: obj.recipe_id, title },
      };
    }

    if (typeof obj.draft_id === "string") {
      return {
        title: "Pending draft",
        body: `You have a pending draft from this URL: \u201C${title}\u201D.`,
        retryable: false,
        duplicate: { type: "draft", id: obj.draft_id, title },
      };
    }
  }

  return {
    title: "Already saved",
    body: "You already have this recipe.",
    retryable: false,
  };
}
