import { ApiError } from "../../lib/errors";
import { urlCaptureErrorMessage } from "../../lib/urlCaptureErrorMessage";

/**
 * PROVIDER-S1 — URL capture error contract.
 *
 * Locked copy:
 * - RECIPE_UNREADABLE: the existing "No recipe found" page guidance;
 * - every RECIPE_PROVIDER_* code: honest importer-unavailable copy;
 * - the 409 duplicate contract (code-less object detail) is unchanged;
 * - a code-less string 502 remains the page-fetch failure copy.
 */

function httpError(
  status: number,
  detail?: string | Array<unknown> | Record<string, unknown>,
): ApiError {
  return new ApiError({ message: "http error", kind: "http", status, detail });
}

const PROVIDER_TITLE = "Recipe importer unavailable";
const PROVIDER_BODY =
  "Recipe import is unavailable right now. Please try again later.";

describe("urlCaptureErrorMessage — stable machine codes (PROVIDER-S1)", () => {
  it("RECIPE_UNREADABLE maps to the no-recipe-found copy", () => {
    const info = urlCaptureErrorMessage(
      httpError(422, { code: "RECIPE_UNREADABLE", message: "safe" }),
    );
    expect(info.title).toBe("No recipe found");
    expect(info.retryable).toBe(false);
  });

  it.each([
    ["RECIPE_PROVIDER_UNAVAILABLE", 503],
    ["RECIPE_PROVIDER_RATE_LIMITED", 503],
    ["RECIPE_PROVIDER_TIMEOUT", 504],
    ["RECIPE_PROVIDER_BAD_RESPONSE", 502],
  ])("%s maps to the honest importer copy and is retryable", (code, status) => {
    const info = urlCaptureErrorMessage(
      httpError(status, { code, message: "safe" }),
    );
    expect(info.title).toBe(PROVIDER_TITLE);
    expect(info.body).toBe(PROVIDER_BODY);
    expect(info.retryable).toBe(true);
    expect(info.duplicate).toBeUndefined();
  });

  it("an unknown object code falls back safely", () => {
    const info = urlCaptureErrorMessage(
      httpError(503, { code: "SOMETHING_NEW", message: "safe" }),
    );
    expect(info.retryable).toBe(true);
    expect(info.title).toBe("Something went wrong");
  });
});

describe("urlCaptureErrorMessage — duplicate, legacy, and FastAPI shapes", () => {
  it("the 409 duplicate recipe contract is unchanged", () => {
    const info = urlCaptureErrorMessage(
      httpError(409, {
        detail: "Recipe already saved",
        recipe_id: "r-1",
        title: "Carbonara",
      }),
    );
    expect(info.duplicate).toEqual({
      type: "recipe",
      id: "r-1",
      title: "Carbonara",
    });
    expect(info.retryable).toBe(false);
  });

  it("the 409 duplicate draft contract is unchanged", () => {
    const info = urlCaptureErrorMessage(
      httpError(409, {
        detail: "Pending draft exists",
        draft_id: "d-1",
        title: "Carbonara",
      }),
    );
    expect(info.duplicate).toEqual({
      type: "draft",
      id: "d-1",
      title: "Carbonara",
    });
  });

  it("the exact legacy extract string still maps to no-recipe-found", () => {
    const info = urlCaptureErrorMessage(
      httpError(422, "Could not extract a recipe from this page"),
    );
    expect(info.title).toBe("No recipe found");
  });

  it("an arbitrary string-shaped 422 does not blame the page content", () => {
    const info = urlCaptureErrorMessage(httpError(422, "weird condition"));
    expect(info.title).toBe("Something went wrong");
    expect(info.retryable).toBe(true);
  });

  it("FastAPI list-shaped detail maps to invalid-request copy", () => {
    const info = urlCaptureErrorMessage(
      httpError(422, [{ loc: ["body", "url"], msg: "field required" }]),
    );
    expect(info.title).toBe("Unexpected request");
  });

  it("a code-less string 502 remains the page-fetch failure copy", () => {
    const info = urlCaptureErrorMessage(
      httpError(502, "URL fetch failed: connect timeout"),
    );
    expect(info.title).toBe("Couldn’t open page");
    expect(info.retryable).toBe(true);
  });

  it("code-less 503/504 fall back to the importer copy", () => {
    for (const status of [503, 504]) {
      const info = urlCaptureErrorMessage(httpError(status));
      expect(info.title).toBe(PROVIDER_TITLE);
    }
  });

  it("the user-volume 429 copy is unchanged", () => {
    const info = urlCaptureErrorMessage(httpError(429, "Rate limit exceeded"));
    expect(info.title).toBe("Too many captures");
  });

  it("400 invalid URL copy is unchanged", () => {
    const info = urlCaptureErrorMessage(httpError(400, "Invalid URL"));
    expect(info.title).toBe("Invalid URL");
  });
});
