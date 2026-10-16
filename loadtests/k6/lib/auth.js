// Phase 14.2B — JWT helpers for k6 scenarios.
// JWT minting and rotation belong to 14.2C seed/tooling; this module only
// consumes an env-injected token. The JWT value is never logged.

export function bearerHeader(jwt) {
  if (typeof jwt !== "string" || jwt.trim() === "") {
    throw new Error(
      "LOADTEST_JWT is required but missing or empty. Refusing to send authenticated requests.",
    );
  }
  return { Authorization: `Bearer ${jwt}` };
}

export function requireJwtFromEnv() {
  const jwt = __ENV.LOADTEST_JWT;
  if (typeof jwt !== "string" || jwt.trim() === "") {
    throw new Error("LOADTEST_JWT env var is required but missing or empty.");
  }
  return jwt;
}
