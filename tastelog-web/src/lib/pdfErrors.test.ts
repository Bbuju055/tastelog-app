import { describe, it, expect } from "vitest";
import { apiErrorFromHttp } from "./errors";
import { apiErrorMessage } from "./useApiErrorMessage";

describe("PDF capture rejection", () => {
  it.each(["PDF_MULTIPAGE_UNSUPPORTED", "PDF_PAGE_COUNT_FAILED"])("shows actionable copy for %s", (code) => {
    const message = apiErrorMessage(apiErrorFromHttp({ status: 422, detail: { code, message: "untrusted text" } }));
    expect(message).toContain("No recipe was saved.");
    expect(message).toContain("source URL");
    expect(message).not.toContain("untrusted text");
  });
});
