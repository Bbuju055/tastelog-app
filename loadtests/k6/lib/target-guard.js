// Phase 14.2B — load-target guard. Refuses production host literals so
// scenarios cannot be pointed at the live Railway service.
//
// Errors reference the env-var NAME only; the URL value is never echoed.

const PROD_HOST_LITERAL = "tastelog-production.example.com";
const PROD_HOST_FRAGMENT = "tastelog-production";

export function assertLoadTarget(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new Error(
      "LOADTEST_API_BASE_URL is required but missing or empty. Refusing to run.",
    );
  }

  const normalized = baseUrl.trim();
  const lower = normalized.toLowerCase();

  if (lower.includes(PROD_HOST_LITERAL) || lower.includes(PROD_HOST_FRAGMENT)) {
    throw new Error(
      "LOADTEST_API_BASE_URL points at a production-like host. Refusing to run against production.",
    );
  }

  return normalized;
}
