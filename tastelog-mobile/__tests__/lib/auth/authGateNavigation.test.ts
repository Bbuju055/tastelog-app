import {
  buildNavigableHref,
  decideAuthGateRoute,
  resolveSignedInDestination,
} from "../../../lib/auth/authGateNavigation";

/**
 * 15.3.1 — the AuthGate routing matrix as pure decisions. This is the
 * first deterministic coverage of fresh-install routing, restored-session
 * bypass, and onboarding eligibility.
 */

describe("decideAuthGateRoute", () => {
  test("waits while the session is restoring", () => {
    expect(
      decideAuthGateRoute({
        isLoading: true,
        hasSession: false,
        hasOnboarded: null,
        firstSegment: "(app)",
      }),
    ).toEqual({ kind: "wait" });
  });

  test("restored session inside the app group stays (structural bypass — flag ignored)", () => {
    for (const hasOnboarded of [null, false, true] as const) {
      expect(
        decideAuthGateRoute({
          isLoading: false,
          hasSession: true,
          hasOnboarded,
          firstSegment: "(app)",
        }),
      ).toEqual({ kind: "stay" });
    }
  });

  test("signed-in outside the app group redirects — even from onboarding, even with the flag unset", () => {
    for (const firstSegment of ["login", "onboarding", undefined]) {
      expect(
        decideAuthGateRoute({
          isLoading: false,
          hasSession: true,
          hasOnboarded: false,
          firstSegment,
        }),
      ).toEqual({ kind: "signedInRedirect" });
    }
  });

  test("signed-out waits for the bounded onboarding read (which always settles)", () => {
    expect(
      decideAuthGateRoute({
        isLoading: false,
        hasSession: false,
        hasOnboarded: null,
        firstSegment: "(app)",
      }),
    ).toEqual({ kind: "wait" });
  });

  test("fresh device: signed-out without completion routes to onboarding", () => {
    expect(
      decideAuthGateRoute({
        isLoading: false,
        hasSession: false,
        hasOnboarded: false,
        firstSegment: "(app)",
      }),
    ).toEqual({ kind: "onboarding" });
  });

  test("signed-out without completion already on onboarding stays", () => {
    expect(
      decideAuthGateRoute({
        isLoading: false,
        hasSession: false,
        hasOnboarded: false,
        firstSegment: "onboarding",
      }),
    ).toEqual({ kind: "stay" });
  });

  test("signed-out with completion routes to login from the app group", () => {
    expect(
      decideAuthGateRoute({
        isLoading: false,
        hasSession: false,
        hasOnboarded: true,
        firstSegment: "(app)",
      }),
    ).toEqual({ kind: "login" });
  });

  test("signed-out with completion stays on login and on onboarding (completion handler owns that replace)", () => {
    for (const firstSegment of ["login", "onboarding"]) {
      expect(
        decideAuthGateRoute({
          isLoading: false,
          hasSession: false,
          hasOnboarded: true,
          firstSegment,
        }),
      ).toEqual({ kind: "stay" });
    }
  });
});

describe("resolveSignedInDestination", () => {
  test("durable one-shot destination wins", () => {
    expect(resolveSignedInDestination("/(app)/(tabs)/add", "/recipe/r1")).toBe(
      "/(app)/(tabs)/add",
    );
  });

  test("pending deep link wins over the default", () => {
    expect(resolveSignedInDestination(null, "/review/abc?recipe_id=r1")).toBe(
      "/review/abc?recipe_id=r1",
    );
  });

  test("defaults to the tabs root", () => {
    expect(resolveSignedInDestination(null, null)).toBe("/(app)/(tabs)");
  });
});

describe("buildNavigableHref", () => {
  test("root path is not preservable", () => {
    expect(buildNavigableHref("/", {})).toBeNull();
    expect(buildNavigableHref("", {})).toBeNull();
  });

  test("path without params is preserved as-is", () => {
    expect(buildNavigableHref("/recipe/r1", {})).toBe("/recipe/r1");
  });

  test("query params are preserved; route params embedded in the path are dropped", () => {
    // Share deep link shape: /review/[id]?recipe_id=…&status=…&view_url=…
    expect(
      buildNavigableHref("/review/abc", {
        id: "abc",
        recipe_id: "r-1",
        status: "created",
        view_url: "/recipes/r-1",
      }),
    ).toBe("/review/abc?recipe_id=r-1&status=created&view_url=%2Frecipes%2Fr-1");
  });

  test("array params flatten to repeated pairs", () => {
    expect(buildNavigableHref("/recipe/r1", { tag: ["a", "b"] })).toBe(
      "/recipe/r1?tag=a&tag=b",
    );
  });

  test("values are URL-encoded", () => {
    expect(buildNavigableHref("/recipe/r1", { q: "salt & pepper" })).toBe(
      "/recipe/r1?q=salt%20%26%20pepper",
    );
  });
});
