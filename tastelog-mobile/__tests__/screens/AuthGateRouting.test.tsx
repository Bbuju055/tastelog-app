import React from "react";
import { act, render } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  HAS_ONBOARDED_KEY,
  POST_AUTH_DESTINATION_KEY,
} from "../../constants/keys";
import { resetOnboardingStateForTests } from "../../lib/onboarding/onboardingState";
import { resetPostAuthDestinationMemoForTests } from "../../lib/onboarding/postAuthDestination";

/**
 * 15.3.1 — the AuthGate routing machine, MOUNTED.
 *
 * The pure `decideAuthGateRoute` tests cover the decision matrix, but they
 * cannot see the part that actually broke: the effect that resolves the
 * durable destination re-runs on every fresh `session` object identity
 * (INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED) and on onboarding-flag
 * settlement. A run cancelled mid-read must not cost the user their Add
 * intent. That is only observable with the real root layout mounted.
 *
 * The root layout holds module-level state (one-shot onboarding hydration,
 * memoised destination read). Unlike the pure unit tests it CANNOT be reloaded
 * with jest.isolateModules: a second module registry supplies a second copy of
 * React, and every hook call in the mounted tree becomes invalid. So this file
 * keeps one registry, drives a fully controlled storage double, and resets the
 * module state between tests.
 */

const mockReplace = jest.fn();
let mockSegments: string[] = [];
let mockPathname = "/";
let mockGlobalParams: Record<string, string | string[]> = {};

jest.mock("expo-router", () => {
  const React_ = require("react");
  const { Text } = require("react-native");
  return {
    Slot: () => React_.createElement(Text, null, "APP_SLOT"),
    useRouter: () => ({ replace: mockReplace }),
    useSegments: () => mockSegments,
    usePathname: () => mockPathname,
    useGlobalSearchParams: () => mockGlobalParams,
  };
});

type TestSession = { user: { id: string } };
let mockGetSessionPromise: Promise<{ data: { session: TestSession | null } }> =
  Promise.resolve({ data: { session: null } });
let mockAuthCallback:
  | ((event: string, session: TestSession | null) => void)
  | null = null;

jest.mock("../../lib/auth/supabase", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: () => mockGetSessionPromise,
      onAuthStateChange: (cb: (e: string, s: TestSession | null) => void) => {
        mockAuthCallback = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
      signOut: jest.fn(async () => ({ error: null })),
    },
  }),
}));

jest.mock("../../lib/auth/tokenOrchestrator", () => ({
  provisionAndStoreCaptureToken: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/api/endpoints", () => ({
  revokeCaptureToken: jest.fn(async () => undefined),
}));
jest.mock("../../lib/auth/storage", () => ({
  getCaptureTokenId: jest.fn(async () => null),
  removeCaptureToken: jest.fn(async () => undefined),
}));

jest.mock("expo-font", () => ({ useFonts: () => [true] }));
jest.mock("@expo-google-fonts/cormorant-garamond", () => ({
  CormorantGaramond_400Regular: "f1",
  CormorantGaramond_500Medium: "f2",
  CormorantGaramond_600SemiBold: "f3",
  CormorantGaramond_700Bold: "f4",
  CormorantGaramond_400Regular_Italic: "f5",
}));
jest.mock("@expo-google-fonts/karla", () => ({
  Karla_400Regular: "k1",
  Karla_500Medium: "k2",
  Karla_600SemiBold: "k3",
  Karla_700Bold: "k4",
}));
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));
jest.mock("@sentry/react-native", () => ({
  wrap: (component: unknown) => component,
}));
jest.mock("../../lib/sentry", () => ({ initSentry: jest.fn() }));
jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return { GestureHandlerRootView: View };
});

import RootLayout from "../../app/_layout";

const ADD_HREF = "/(app)/(tabs)/add";
const TABS_HREF = "/(app)/(tabs)";

const storage = AsyncStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
};

/**
 * Storage double under full test control. The official AsyncStorage mock's
 * methods are already jest.fn instances, so an override would leak across
 * tests (repo gotcha) — this reinstalls a deterministic implementation every
 * test instead, and lets a test hold the durable read open on demand.
 */
let store: Record<string, string> = {};
let readGate: { promise: Promise<string | null>; resolve: (v: string | null) => void } | null =
  null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeSession(userId = "user-1"): TestSession {
  // A NEW object every call: this is what Supabase hands us on each event,
  // and it is what re-runs the AuthGate effect.
  return { user: { id: userId } };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedCompletedOnboarding() {
  store[HAS_ONBOARDED_KEY] = "true";
}

function seedDestination(href = ADD_HREF) {
  store[POST_AUTH_DESTINATION_KEY] = JSON.stringify({
    v: 1,
    href,
    ts: Date.now(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  store = {};
  readGate = null;
  mockSegments = [];
  mockPathname = "/";
  mockGlobalParams = {};
  mockAuthCallback = null;
  mockGetSessionPromise = Promise.resolve({ data: { session: null } });
  resetOnboardingStateForTests();
  resetPostAuthDestinationMemoForTests();

  storage.getItem.mockImplementation((key: string) => {
    if (key === POST_AUTH_DESTINATION_KEY && readGate) return readGate.promise;
    return Promise.resolve(store[key] ?? null);
  });
  storage.setItem.mockImplementation((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  });
  storage.removeItem.mockImplementation((key: string) => {
    delete store[key];
    return Promise.resolve();
  });
});

describe("signed-out routing", () => {
  test("waits (no navigation) while the session is still restoring", async () => {
    // getSession never settles → isLoading stays true.
    mockGetSessionPromise = new Promise(() => {});

    render(<RootLayout />);
    await flush();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  test("fresh device (flag unset) routes to onboarding", async () => {
    render(<RootLayout />);
    await flush();

    expect(mockReplace).toHaveBeenCalledWith("/onboarding");
  });

  test("completed device routes to login, never onboarding", async () => {
    seedCompletedOnboarding();

    render(<RootLayout />);
    await flush();

    expect(mockReplace).toHaveBeenCalledWith("/login");
    expect(mockReplace).not.toHaveBeenCalledWith("/onboarding");
  });
});

describe("restored session bypasses onboarding structurally", () => {
  test("a restored session never routes to onboarding, even with the flag unset", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];

    render(<RootLayout />);
    await flush();

    expect(mockReplace).not.toHaveBeenCalledWith("/onboarding");
    expect(mockReplace).toHaveBeenCalledWith(TABS_HREF);
  });

  test("a signed-in user already inside (app) stays put", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["(app)"];

    render(<RootLayout />);
    await flush();

    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("durable Add destination", () => {
  test("a restored session with a stored intent lands on Add", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];
    seedCompletedOnboarding();
    seedDestination();

    render(<RootLayout />);
    await flush();

    expect(mockReplace).toHaveBeenCalledWith(ADD_HREF);
  });

  /**
   * The two-phase ordering, end-to-end: the record must survive until the
   * navigation is actually dispatched. Reading it destructively (the pre-fix
   * behaviour) inverts this order, so this assertion fails against it.
   */
  test("the destination is acknowledged only AFTER routing is dispatched", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];
    seedCompletedOnboarding();
    seedDestination();

    const order: string[] = [];
    mockReplace.mockImplementation((href: string) => {
      if (href === ADD_HREF) order.push("replace");
    });
    storage.removeItem.mockImplementation((key: string) => {
      if (key === POST_AUTH_DESTINATION_KEY) order.push("clear");
      delete store[key];
      return Promise.resolve();
    });

    render(<RootLayout />);
    await flush();

    expect(order).toEqual(["replace", "clear"]);
    expect(store[POST_AUTH_DESTINATION_KEY]).toBeUndefined();
  });

  /**
   * Scenario cover for the email-confirmation relaunch (device matrix #4):
   * repeated fresh session identities while the durable read is in flight
   * must still land on Add.
   *
   * Honest scope note: this asserts the OUTCOME, not the cancellation race
   * itself. The exact pre-fix interleaving (run #1's destructive read resolves,
   * then the effect re-runs and cancels it before its continuation) is not
   * forceable from here — React decides when it flushes. The contract that
   * rules the race out is pinned in postAuthDestination.test.ts, whose
   * "a cancelled reader does not rob its successor" and "reading does NOT
   * clear storage" cases fail against the destructive implementation.
   */
  test("repeated fresh session identities during the read still land on Add", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];
    seedCompletedOnboarding();
    seedDestination();

    // Hold the durable read open so auth events land while it is in flight.
    const gate = deferred<string | null>();
    readGate = gate;
    const stored = store[POST_AUTH_DESTINATION_KEY];

    render(<RootLayout />);
    await flush();

    // Fresh session object identities re-run the effect and cancel run #1.
    await act(async () => {
      mockAuthCallback?.("TOKEN_REFRESHED", makeSession());
    });
    await act(async () => {
      mockAuthCallback?.("INITIAL_SESSION", makeSession());
    });

    // Now let the shared, memoised read resolve.
    await act(async () => {
      gate.resolve(stored ?? null);
    });
    await flush();

    expect(mockReplace).toHaveBeenCalledWith(ADD_HREF);
    // The pre-fix failure mode: destination consumed by a cancelled run, so
    // the surviving run fell back to the default landing.
    expect(mockReplace).not.toHaveBeenCalledWith(TABS_HREF);
  });

  test("once landed on Add, a later auth event does not bounce to the default", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];
    seedCompletedOnboarding();
    seedDestination();

    render(<RootLayout />);
    await flush();
    expect(mockReplace).toHaveBeenCalledWith(ADD_HREF);

    // The router followed that replace: the user is now inside the app group.
    mockSegments = ["(app)"];
    await act(async () => {
      mockAuthCallback?.("TOKEN_REFRESHED", makeSession());
    });
    await flush();

    // The intent was already acknowledged, so a re-read finds nothing — the
    // gate must recognise the user is already home and stay, not re-navigate.
    expect(mockReplace).not.toHaveBeenCalledWith(TABS_HREF);
  });

  test("no stored intent → the default landing", async () => {
    mockGetSessionPromise = Promise.resolve({ data: { session: makeSession() } });
    mockSegments = ["login"];
    seedCompletedOnboarding();

    render(<RootLayout />);
    await flush();

    expect(mockReplace).toHaveBeenCalledWith(TABS_HREF);
  });
});

describe("deep-link preservation across the gate", () => {
  test("a signed-out deep link keeps its full path AND query, then routes there after auth", async () => {
    mockSegments = ["(app)"];
    mockPathname = "/(app)/review/capture-1";
    mockGlobalParams = { id: "capture-1", status: "ok", recipe_id: "r-9" };
    seedCompletedOnboarding();

    render(<RootLayout />);
    await flush();

    // Signed out inside (app) → bounced to login, deep link held.
    expect(mockReplace).toHaveBeenCalledWith("/login");

    // The router followed that replace.
    mockSegments = ["login"];

    // Sign in: the held href must come back complete, query included.
    await act(async () => {
      mockAuthCallback?.("SIGNED_IN", makeSession());
    });
    await flush();

    const target = mockReplace.mock.calls.at(-1)?.[0] as string;
    expect(target).toContain("/(app)/review/capture-1");
    expect(target).toContain("status=ok");
    expect(target).toContain("recipe_id=r-9");
    // The route param is not re-appended as a query pair.
    expect(target).not.toContain("id=capture-1");
  });
});
