/** Keep login's user-supplied destination on this application's origin. */
export function loginRedirectPath(requested: string, origin: string): string {
  if (!requested.startsWith("/")) return "/";
  try {
    const destination = new URL(requested, origin);
    if (destination.origin !== origin) return "/";
    return destination.pathname + destination.search + destination.hash;
  } catch {
    return "/";
  }
}
