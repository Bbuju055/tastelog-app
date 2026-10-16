import { type ApiError, isApiError } from "./errors";

export type CaptureErrorInfo = {
  title: string;
  body: string;
  retryable: boolean;
};

/**
 * Map an error from the capture flow to a user-facing message with guidance.
 * Capture-specific — not a replacement for the generic `apiErrorMessage`.
 */
export function captureErrorMessage(err: unknown): CaptureErrorInfo {
  if (!isApiError(err)) {
    return {
      title: "Something went wrong",
      body: "An unexpected error occurred. Try again, and if it keeps happening, contact support.",
      retryable: true,
    };
  }

  return mapApiError(err);
}

function mapApiError(err: ApiError): CaptureErrorInfo {
  switch (err.kind) {
    case "timeout":
      return {
        title: "Taking too long",
        body: "The upload timed out. Check your connection and try again.",
        retryable: true,
      };

    case "network":
      return {
        title: "No connection",
        body: "Couldn\u2019t reach the server. Check your internet and try again.",
        retryable: true,
      };

    case "validation":
      return {
        title: "Unexpected response",
        body: "Something unexpected happened. Try again, and if it keeps happening, contact support.",
        retryable: true,
      };

    case "http":
      return mapHttpError(err);

    default:
      return {
        title: "Something went wrong",
        body: "An unexpected error occurred. Please try again.",
        retryable: true,
      };
  }
}

/**
 * PROVIDER-S1: stable machine-readable capture error code, when present.
 * The server returns `detail: { code, message }` for route-owned capture
 * failures; anything else (string, list, code-less object) returns null.
 */
function stableErrorCode(err: ApiError): string | null {
  const detail = err.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** Honest provider-outage copy — never blames the user's photo. */
const PROVIDER_UNAVAILABLE_INFO: CaptureErrorInfo = {
  title: "Recipe reader unavailable",
  body: "Recipe capture is unavailable right now. Please try again later.",
  retryable: true,
};

const UNREADABLE_INFO: CaptureErrorInfo = {
  title: "Couldn\u2019t read recipe",
  body: "We couldn\u2019t find a recipe in this image. Try a clearer photo with the full recipe visible.",
  retryable: false,
};

function mapHttpError(err: ApiError): CaptureErrorInfo {
  const status = err.status ?? 0;

  // PROVIDER-S1: prefer the stable machine-readable contract.
  const code = stableErrorCode(err);
  if (code !== null) {
    switch (code) {
      case "RECIPE_UNREADABLE":
        return UNREADABLE_INFO;
      case "RECIPE_PROVIDER_UNAVAILABLE":
      case "RECIPE_PROVIDER_RATE_LIMITED":
      case "RECIPE_PROVIDER_TIMEOUT":
      case "RECIPE_PROVIDER_BAD_RESPONSE":
        return PROVIDER_UNAVAILABLE_INFO;
      default:
        // Unknown object code — fall back safely, never blame the photo.
        return {
          title: "Something went wrong",
          body: "An unexpected error occurred. Please try again.",
          retryable: true,
        };
    }
  }

  // FastAPI request-validation errors ship list-shaped detail. That is
  // an invalid/unexpected request — never the user\u2019s photo quality.
  if (Array.isArray(err.detail)) {
    return {
      title: "Unexpected request",
      body: "Something unexpected happened. Try again, and if it keeps happening, contact support.",
      retryable: true,
    };
  }

  const detail = typeof err.detail === "string" ? err.detail : "";

  const d = detail.toLowerCase();
  if (status === 400 && (d.includes("file type") || d.includes("unsupported"))) {
    return {
      title: "Unsupported image",
      body: "This image format isn\u2019t supported. Try taking a screenshot of the recipe and uploading that.",
      retryable: false,
    };
  }

  if (status === 401) {
    return {
      title: "Session expired",
      body: "Your login session has expired. Please sign in again.",
      retryable: false,
    };
  }

  if (status === 413) {
    return {
      title: "Image too large",
      body: "This image is over 10 MB. Try a smaller image or a screenshot.",
      retryable: false,
    };
  }

  if (status === 422) {
    // Legacy pre-PROVIDER-S1 string contract only. An arbitrary
    // string-shaped 422 must not blame the photo.
    if (d.includes("failed to parse recipe image")) {
      return UNREADABLE_INFO;
    }
    return {
      title: "Something went wrong",
      body: "An unexpected error occurred. Please try again.",
      retryable: true,
    };
  }

  if (status === 429) {
    return {
      title: "Too many captures",
      body: "You\u2019ve captured a lot of recipes recently. Wait a few minutes and try again.",
      retryable: true,
    };
  }

  if (status === 502 || status === 503 || status === 504) {
    // Provider-shaped statuses without a machine code.
    return PROVIDER_UNAVAILABLE_INFO;
  }

  if (status >= 500) {
    return {
      title: "Something went wrong",
      body: "Our servers hit a problem. This usually resolves quickly \u2014 try again in a moment.",
      retryable: true,
    };
  }

  return {
    title: "Something went wrong",
    body: "An unexpected error occurred. Please try again.",
    retryable: true,
  };
}
