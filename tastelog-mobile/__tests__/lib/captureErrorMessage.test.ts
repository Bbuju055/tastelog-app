import { ApiError } from "../../lib/errors";
import { captureErrorMessage } from "../../lib/captureErrorMessage";

/**
 * PROVIDER-S1 — photo capture error contract.
 *
 * Locked copy:
 * - RECIPE_UNREADABLE (only): "try a clearer photo" guidance;
 * - every RECIPE_PROVIDER_* code: honest service-unavailable copy that
 *   never blames the user's photo;
 * - FastAPI list-shaped detail: generic invalid-request copy;
 * - the app's own user-volume 429 stays distinct from provider limits.
 */

function httpError(
  status: number,
  detail?: string | Array<unknown> | Record<string, unknown>,
): ApiError {
  return new ApiError({ message: "http error", kind: "http", status, detail });
}

const PROVIDER_TITLE = "Recipe reader unavailable";
const PROVIDER_BODY =
  "Recipe capture is unavailable right now. Please try again later.";

describe("captureErrorMessage — stable machine codes (PROVIDER-S1)", () => {
  it("RECIPE_UNREADABLE maps to the clearer-photo copy, not retryable", () => {
    const info = captureErrorMessage(
      httpError(422, { code: "RECIPE_UNREADABLE", message: "safe" }),
    );
    expect(info.title).toBe("Couldn’t read recipe");
    expect(info.body).toContain("clearer photo");
    expect(info.retryable).toBe(false);
  });

  it.each([
    ["RECIPE_PROVIDER_UNAVAILABLE", 503],
    ["RECIPE_PROVIDER_RATE_LIMITED", 503],
    ["RECIPE_PROVIDER_TIMEOUT", 504],
    ["RECIPE_PROVIDER_BAD_RESPONSE", 502],
  ])("%s maps to the honest provider copy and is retryable", (code, status) => {
    const info = captureErrorMessage(httpError(status, { code, message: "safe" }));
    expect(info.title).toBe(PROVIDER_TITLE);
    expect(info.body).toBe(PROVIDER_BODY);
    expect(info.retryable).toBe(true);
    // Provider failures never blame the photo.
    expect(info.body).not.toContain("photo");
  });

  it("provider rate limiting never reuses the app user-volume 429 copy", () => {
    const info = captureErrorMessage(
      httpError(503, { code: "RECIPE_PROVIDER_RATE_LIMITED", message: "safe" }),
    );
    expect(info.title).not.toBe("Too many captures");
  });

  it("an unknown object code falls back safely and retryably", () => {
    const info = captureErrorMessage(
      httpError(422, { code: "SOMETHING_NEW", message: "safe" }),
    );
    expect(info.retryable).toBe(true);
    expect(info.body).not.toContain("clearer photo");
  });
});

describe("captureErrorMessage — legacy and FastAPI shapes", () => {
  it("the exact legacy parse string still maps to clearer-photo copy", () => {
    const info = captureErrorMessage(httpError(422, "Failed to parse recipe image"));
    expect(info.body).toContain("clearer photo");
    expect(info.retryable).toBe(false);
  });

  it("an arbitrary string-shaped 422 does NOT blame the photo", () => {
    const info = captureErrorMessage(httpError(422, "some other condition"));
    expect(info.body).not.toContain("clearer photo");
    expect(info.retryable).toBe(true);
  });

  it("FastAPI list-shaped detail maps to invalid-request copy, never clearer-photo", () => {
    const info = captureErrorMessage(
      httpError(422, [{ loc: ["body", "image"], msg: "field required" }]),
    );
    expect(info.title).toBe("Unexpected request");
    expect(info.body).not.toContain("clearer photo");
  });

  it("code-less provider statuses fall back to the provider copy", () => {
    for (const status of [502, 503, 504]) {
      const info = captureErrorMessage(httpError(status));
      expect(info.title).toBe(PROVIDER_TITLE);
      expect(info.retryable).toBe(true);
    }
  });

  it("the app's own user-volume 429 copy is unchanged", () => {
    const info = captureErrorMessage(httpError(429, "Rate limit exceeded"));
    expect(info.title).toBe("Too many captures");
    expect(info.retryable).toBe(true);
  });

  it("existing 400 unsupported-file branch is unchanged", () => {
    const info = captureErrorMessage(httpError(400, "Invalid file type: text/plain"));
    expect(info.title).toBe("Unsupported image");
    expect(info.retryable).toBe(false);
  });

  it("500 keeps the existing server-problem copy", () => {
    const info = captureErrorMessage(httpError(500, "Internal server error"));
    expect(info.title).toBe("Something went wrong");
    expect(info.retryable).toBe(true);
  });

  it("non-ApiError input keeps the generic fallback", () => {
    const info = captureErrorMessage(new Error("boom"));
    expect(info.retryable).toBe(true);
  });
});

it.each(["PDF_MULTIPAGE_UNSUPPORTED", "PDF_PAGE_COUNT_FAILED"])("explains %s without offering a same-file retry", (code) => {
  const info = captureErrorMessage(httpError(422, { code, message: "untrusted text" }));
  expect(info.body).toContain("No recipe was saved.");
  expect(info.body).toContain("source URL");
  expect(info.body).not.toContain("untrusted text");
  expect(info.retryable).toBe(false);
});
