import { buildShareCaptureDeepLink, parseShareCaptureDeepLink } from "../../lib/shareExtension/deeplink";

describe("share extension deep links", () => {
  test("builds minimal link", () => {
    const url = buildShareCaptureDeepLink({ captureId: "abc123" });
    expect(url).toBe("tastelog://review/abc123");
  });

  test("builds link with params", () => {
    const url = buildShareCaptureDeepLink({
      captureId: "abc123",
      recipeId: "r1",
      status: "complete",
      viewUrl: "https://example.com/x?q=1&z=2",
    });

    // Parse to verify encoding round-trip
    const parsed = parseShareCaptureDeepLink(url);
    expect(parsed).toEqual({
      captureId: "abc123",
      recipeId: "r1",
      status: "complete",
      viewUrl: "https://example.com/x?q=1&z=2",
    });
  });

  test("rejects non-tastelog scheme", () => {
    expect(parseShareCaptureDeepLink("https://review/abc123")).toBeNull();
  });

  test("rejects wrong host", () => {
    expect(parseShareCaptureDeepLink("tastelog://notreview/abc123")).toBeNull();
  });
});
