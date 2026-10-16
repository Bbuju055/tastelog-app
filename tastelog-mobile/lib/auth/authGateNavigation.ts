/**
 * Pure AuthGate routing decisions (Phase 15.3.1).
 *
 * Extracted so the routing matrix — session restoration, device-local
 * onboarding eligibility, deep-link preservation, and post-auth destination
 * priority — is deterministic and unit-testable without mounting the root
 * layout (which has module-level splash/Sentry side effects).
 */

export type AuthGateInput = {
  isLoading: boolean;
  hasSession: boolean;
  /** `null` while the bounded device-local read is settling. */
  hasOnboarded: boolean | null;
  /** First expo-router segment, e.g. "(app)", "login", "onboarding". */
  firstSegment: string | undefined;
};

export type AuthGateDecision =
  /** Session or (signed-out) onboarding state still resolving. */
  | { kind: "wait" }
  /** Current route is already correct. */
  | { kind: "stay" }
  /** Signed-out, panels not completed on this device. */
  | { kind: "onboarding" }
  /** Signed-out, panels completed (or skipped). */
  | { kind: "login" }
  /** Signed-in but outside the app group — caller resolves the target. */
  | { kind: "signedInRedirect" };

export function decideAuthGateRoute(input: AuthGateInput): AuthGateDecision {
  const { isLoading, hasSession, hasOnboarded, firstSegment } = input;

  if (isLoading) return { kind: "wait" };

  if (hasSession) {
    // Signed-in users are NEVER routed through onboarding; the flag is
    // ignored entirely (restored-session structural bypass).
    return firstSegment === "(app)"
      ? { kind: "stay" }
      : { kind: "signedInRedirect" };
  }

  // Signed-out: eligibility depends on the device-local completion flag,
  // whose bounded hydration always settles (fail-open true).
  if (hasOnboarded === null) return { kind: "wait" };

  if (!hasOnboarded) {
    return firstSegment === "onboarding" ? { kind: "stay" } : { kind: "onboarding" };
  }

  // Completed (or skipped): login is the signed-out home. A signed-out user
  // already on login stays; one still on the onboarding route stays too —
  // the panels' own completion handler performs the replace to login, and
  // racing it here would double-navigate.
  if (firstSegment === "login" || firstSegment === "onboarding") {
    return { kind: "stay" };
  }
  return { kind: "login" };
}

/**
 * Signed-in redirect target priority (15.3.S binding plan): durable one-shot
 * post-auth destination → in-memory pending deep link → default tabs.
 */
export function resolveSignedInDestination(
  durableHref: string | null,
  pendingHref: string | null,
): string {
  return durableHref ?? pendingHref ?? "/(app)/(tabs)";
}

/**
 * Builds the preservable href for a signed-out deep link, keeping search
 * parameters (share deep links carry `recipe_id`/`status`/`view_url` in the
 * query — path-only preservation loses them).
 *
 * `params` comes from expo-router's `useGlobalSearchParams`, which merges
 * route params (e.g. the `[id]` path segment) with search params; route
 * params are excluded by dropping entries whose value already appears as a
 * pathname segment. Documented limitation: a genuine search param whose
 * value exactly equals a pathname segment is dropped with it.
 */
export function buildNavigableHref(
  pathname: string,
  params: Record<string, string | string[]>,
): string | null {
  if (!pathname || pathname === "/") return null;

  const pathSegments = new Set(pathname.split("/").filter(Boolean));
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const single of values) {
      if (typeof single !== "string") continue;
      if (pathSegments.has(single)) continue;
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(single)}`);
    }
  }

  return pairs.length > 0 ? `${pathname}?${pairs.join("&")}` : pathname;
}
