import { renderHook, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Mocks — must be declared before require() of the module under test
// ---------------------------------------------------------------------------

const mockSignOut = jest.fn().mockResolvedValue({ error: null });
const mockSignUp = jest.fn().mockResolvedValue({
  data: { user: { id: "u1" }, session: null },
  error: null,
});
const mockGetSession = jest.fn().mockResolvedValue({
  data: { session: { user: { id: "u1" }, access_token: "tok" } },
  error: null,
});
const mockOnAuthStateChange = jest.fn().mockReturnValue({
  data: { subscription: { unsubscribe: jest.fn() } },
});

jest.mock("../../../lib/auth/supabase", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: mockGetSession,
      signOut: mockSignOut,
      signUp: mockSignUp,
      onAuthStateChange: mockOnAuthStateChange,
    },
  }),
}));

const mockGetCaptureTokenId = jest.fn().mockResolvedValue(null);
const mockRemoveCaptureToken = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../lib/auth/storage", () => ({
  __esModule: true,
  getCaptureTokenId: (...args: unknown[]) => mockGetCaptureTokenId(...args),
  removeCaptureToken: (...args: unknown[]) => mockRemoveCaptureToken(...args),
}));

const mockRevokeCaptureToken = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../lib/api/endpoints", () => ({
  __esModule: true,
  revokeCaptureToken: (...args: unknown[]) => mockRevokeCaptureToken(...args),
}));

const mockProvision = jest.fn().mockResolvedValue({
  success: true,
  token: "tl_cap_test123",
  tokenId: "tok-id",
});

jest.mock("../../../lib/auth/tokenOrchestrator", () => ({
  __esModule: true,
  provisionAndStoreCaptureToken: (...args: unknown[]) => mockProvision(...args),
}));

// Import after mocks are in place
const { SessionProvider, useSession } = require("../../../lib/auth/context");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SessionProvider consumes useQueryClient (15.3.3 sign-out cache isolation),
// so the test tree needs a real QueryClientProvider above it. Fresh client
// per test — cache assertions must never leak across cases.
let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}

async function flushMicrotasks() {
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Sign-out — cleanup sequence
// ---------------------------------------------------------------------------

describe("signOut — cleanup sequence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
    mockGetCaptureTokenId.mockResolvedValue("stored-tok-id");
    mockRemoveCaptureToken.mockResolvedValue(undefined);
    mockRevokeCaptureToken.mockResolvedValue(undefined);
  });

  test("sign-out ordering: read ID → revoke → clear → signOut", async () => {
    const callOrder: string[] = [];
    mockGetCaptureTokenId.mockImplementation(async () => {
      callOrder.push("getCaptureTokenId");
      return "stored-tok-id";
    });
    mockRevokeCaptureToken.mockImplementation(async () => {
      callOrder.push("revokeCaptureToken");
    });
    mockRemoveCaptureToken.mockImplementation(async () => {
      callOrder.push("removeCaptureToken");
    });
    mockSignOut.mockImplementation(async () => {
      callOrder.push("signOut");
      return { error: null };
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockGetCaptureTokenId).toHaveBeenCalledTimes(1);
    expect(mockRevokeCaptureToken).toHaveBeenCalledWith("stored-tok-id");
    expect(mockRemoveCaptureToken).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);

    // Revoke is fire-and-forget so it may resolve after removeCaptureToken,
    // but getCaptureTokenId must come first and signOut must come last.
    expect(callOrder[0]).toBe("getCaptureTokenId");
    expect(callOrder[callOrder.length - 1]).toBe("signOut");
  });

  test("revoke is skipped when no stored tokenId", async () => {
    mockGetCaptureTokenId.mockResolvedValue(null);

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockRevokeCaptureToken).not.toHaveBeenCalled();
    expect(mockRemoveCaptureToken).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("revoke failure does not block sign-out", async () => {
    mockRevokeCaptureToken.mockRejectedValue(new Error("revoke 500"));

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    // Sign-out still completes
    expect(mockRemoveCaptureToken).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("signOut still runs when removeCaptureToken throws", async () => {
    mockRemoveCaptureToken.mockRejectedValue(new Error("SecureStore fail"));

    const { result } = renderHook(() => useSession(), { wrapper });

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.signOut();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("SecureStore fail");
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("signOut error takes priority over token clear error", async () => {
    mockRemoveCaptureToken.mockRejectedValue(new Error("token error"));
    mockSignOut.mockResolvedValue({ error: new Error("signOut error") });

    const { result } = renderHook(() => useSession(), { wrapper });

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.signOut();
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("signOut error");
  });

  test("getCaptureTokenId failure does not block sign-out", async () => {
    mockGetCaptureTokenId.mockRejectedValue(new Error("read fail"));

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    // Revoke skipped (no ID), but cleanup + signOut proceed
    expect(mockRevokeCaptureToken).not.toHaveBeenCalled();
    expect(mockRemoveCaptureToken).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Sign-up — explicit outcome (15.3.3)
// ---------------------------------------------------------------------------

describe("signUp — explicit outcome", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  test("email confirmation required: resolves sessionCreated=false", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: "u1" }, session: null },
      error: null,
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    let outcome: { sessionCreated: boolean } | null = null;
    await act(async () => {
      outcome = await result.current.signUp("a@b.c", "pw");
    });

    expect(outcome).toEqual({ sessionCreated: false });
  });

  test("confirmation disabled: resolves sessionCreated=true", async () => {
    mockSignUp.mockResolvedValue({
      data: {
        user: { id: "u1" },
        session: { user: { id: "u1" }, access_token: "tok" },
      },
      error: null,
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    let outcome: { sessionCreated: boolean } | null = null;
    await act(async () => {
      outcome = await result.current.signUp("a@b.c", "pw");
    });

    expect(outcome).toEqual({ sessionCreated: true });
  });

  test("supabase error still throws", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error("email taken"),
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.signUp("a@b.c", "pw");
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("email taken");
  });
});

// ---------------------------------------------------------------------------
// Sign-out — cache isolation (15.3.3)
// ---------------------------------------------------------------------------

describe("signOut — query cache isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
    mockGetCaptureTokenId.mockResolvedValue(null);
    mockRemoveCaptureToken.mockResolvedValue(undefined);
  });

  test("confirmed sign-out clears every cached query", async () => {
    queryClient.setQueryData(["recipes"], [{ id: "r1", title: "Prev acct" }]);
    queryClient.setQueryData(["grocery", "lists"], [{ id: "g1" }]);

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await result.current.signOut();
    });

    expect(queryClient.getQueryData(["recipes"])).toBeUndefined();
    expect(queryClient.getQueryData(["grocery", "lists"])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("failed sign-out keeps the session's cache", async () => {
    mockSignOut.mockResolvedValue({ error: new Error("network down") });
    queryClient.setQueryData(["recipes"], [{ id: "r1" }]);

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      try {
        await result.current.signOut();
      } catch {
        // expected
      }
    });

    expect(queryClient.getQueryData(["recipes"])).toEqual([{ id: "r1" }]);
  });

  test("cache clears even when local token clear failed", async () => {
    mockRemoveCaptureToken.mockRejectedValue(new Error("SecureStore fail"));
    queryClient.setQueryData(["recipes"], [{ id: "r1" }]);

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      try {
        await result.current.signOut();
      } catch {
        // expected — token clear error re-thrown after confirmed sign-out
      }
    });

    expect(queryClient.getQueryData(["recipes"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache isolation across identity transitions (15.3.3)
//
// The explicit signOut() helper above is only one way an identity leaves.
// Revocation, refresh failure, and account switches arrive as auth events and
// never pass through it — so isolation is keyed on the authenticated user ID
// changing, not on the event name.
// ---------------------------------------------------------------------------

describe("cache isolation across identity transitions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "u1" }, access_token: "tok" } },
      error: null,
    });
  });

  async function bootWithUserA() {
    const rendered = renderHook(() => useSession(), { wrapper });
    await act(async () => {
      await flushMicrotasks();
    });
    return { rendered, callback: mockOnAuthStateChange.mock.calls[0][0] };
  }

  test("server-driven SIGNED_OUT (revocation / refresh failure) clears the cache", async () => {
    const { callback } = await bootWithUserA();
    queryClient.setQueryData(["recipes"], [{ id: "r1", title: "Account A" }]);

    await act(async () => {
      callback("SIGNED_OUT", null as any);
      await flushMicrotasks();
    });

    expect(queryClient.getQueryData(["recipes"])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("account switch A → B: no prior-account data survives into B's session", async () => {
    const { rendered, callback } = await bootWithUserA();
    queryClient.setQueryData(["recipes"], [{ id: "r1", title: "Account A" }]);

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u2" }, access_token: "tok2" } as any);
      await flushMicrotasks();
    });

    // The clear runs before setSession commits B, so by the time B's session
    // is observable there is nothing of A's left to render.
    expect(rendered.result.current.session?.user.id).toBe("u2");
    expect(queryClient.getQueryData(["recipes"])).toBeUndefined();
  });

  test("token refresh for the SAME user keeps the cache warm", async () => {
    const { callback } = await bootWithUserA();
    queryClient.setQueryData(["recipes"], [{ id: "r1", title: "Account A" }]);

    await act(async () => {
      callback("TOKEN_REFRESHED", { user: { id: "u1" }, access_token: "t2" } as any);
      await flushMicrotasks();
    });

    expect(queryClient.getQueryData(["recipes"])).toEqual([
      { id: "r1", title: "Account A" },
    ]);
  });

  test("boot with no prior identity does not clear anything", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    queryClient.setQueryData(["recipes"], [{ id: "seeded" }]);

    renderHook(() => useSession(), { wrapper });
    await act(async () => {
      await flushMicrotasks();
    });
    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("INITIAL_SESSION", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(queryClient.getQueryData(["recipes"])).toEqual([{ id: "seeded" }]);
  });
});

// ---------------------------------------------------------------------------
// Auto-provision capture token on auth event
// ---------------------------------------------------------------------------

describe("auto-provision capture token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockProvision.mockResolvedValue({
      success: true,
      token: "tl_cap_test123",
      tokenId: "tok-id",
    });
    mockSignOut.mockResolvedValue({ error: null });
    mockRemoveCaptureToken.mockResolvedValue(undefined);
    mockGetCaptureTokenId.mockResolvedValue(null);
    mockRevokeCaptureToken.mockResolvedValue(undefined);
  });

  test("provisions token via orchestrator on SIGNED_IN", async () => {
    renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });

    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(mockProvision).toHaveBeenCalledTimes(1);
    expect(mockProvision).toHaveBeenCalledWith();
  });

  test("does not provision when session is null (SIGNED_OUT)", async () => {
    renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });

    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("SIGNED_OUT", null as any);
      await flushMicrotasks();
    });

    expect(mockProvision).not.toHaveBeenCalled();
  });

  test("captureTokenError is set on provisioning failure", async () => {
    mockProvision.mockResolvedValue({
      success: false,
      error: "Provisioning request failed: Network timeout",
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });

    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(result.current.captureTokenError).toBe(
      "Provisioning request failed: Network timeout",
    );
  });

  test("captureTokenError is cleared on provisioning success", async () => {
    // First: fail
    mockProvision.mockResolvedValueOnce({
      success: false,
      error: "fail",
    });

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });

    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(result.current.captureTokenError).toBe("fail");

    // Second: succeed
    mockProvision.mockResolvedValueOnce({
      success: true,
      token: "tl_cap_test123",
      tokenId: "tok-id",
    });

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(result.current.captureTokenError).toBeNull();
  });

  test("unexpected orchestrator throw sets error state", async () => {
    mockProvision.mockRejectedValue(new Error("unexpected crash"));

    const { result } = renderHook(() => useSession(), { wrapper });

    await act(async () => {
      await flushMicrotasks();
    });

    const callback = mockOnAuthStateChange.mock.calls[0][0];

    await act(async () => {
      callback("SIGNED_IN", { user: { id: "u1" }, access_token: "tok" } as any);
      await flushMicrotasks();
    });

    expect(result.current.captureTokenError).toContain("Unexpected provisioning error");
  });
});
