import { describe, expect, it } from "vitest";
import { loginRedirectPath } from "./loginRedirect";

describe("login destination", () => {
  it.each(["/", "/add", "/recipes/123?view=cook#step-2"])("preserves local path %s", (path) => {
    expect(loginRedirectPath(path, "https://tastelog.test")).toBe(path);
  });
  it.each(["https://other.test", "//other.test", "/\\other.test", "javascript:alert(1)", "", "//user@other.test"])("rejects external or invalid destination %s", (path) => {
    expect(loginRedirectPath(path, "https://tastelog.test")).toBe("/");
  });
});
