import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/** Mock result shape for middleware tests */
type MockMiddlewareResult =
  | { cookies: { set: (...args: unknown[]) => void } }
  | { __redirect: true; location: string };

vi.mock("@/lib/supabase/env", () => ({
  hasSupabaseEnv: () => true,
}));

const getUserMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: getUserMock,
    },
  })),
}));

// Minimal NextRequest/NextResponse shims for unit testing
vi.mock("next/server", async () => {
  return {
    NextResponse: {
      next: (): MockMiddlewareResult => ({
        cookies: { set: vi.fn() },
      }),
      redirect: (url: { pathname: string; searchParams: URLSearchParams }): MockMiddlewareResult => ({
        __redirect: true,
        location: `${url.pathname}?${url.searchParams.toString()}`,
      }),
    },
  };
});

import { middleware } from "./middleware";

function makeReq(pathname: string): NextRequest {
  return {
    nextUrl: {
      pathname,
      clone() {
        return {
          pathname: "/login",
          searchParams: new URLSearchParams(),
          clone: this.clone,
        };
      },
      searchParams: new URLSearchParams(),
    },
    cookies: {
      getAll: () => [],
    },
  } as unknown as NextRequest;
}

describe("middleware auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows /login through without auth", async () => {
    // Even if auth would fail, /login should pass through due to prefix check.
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const res = (await middleware(makeReq("/login"))) as unknown as MockMiddlewareResult;
    expect("__redirect" in res).toBe(false);
  });

  it("redirects unauthenticated protected route to /login with next", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const res = (await middleware(makeReq("/"))) as unknown as MockMiddlewareResult;
    if (!("__redirect" in res)) throw new Error("expected redirect");
    expect(res.__redirect).toBe(true);
    expect(res.location).toContain("/login?");
    expect(res.location).toContain("next=%2F");
  });

  it("allows authenticated protected route", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    const res = (await middleware(makeReq("/"))) as unknown as MockMiddlewareResult;
    expect("__redirect" in res).toBe(false);
  });

  it("fail-closed: redirects on auth error", async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: new Error("boom"),
    });
    const res = (await middleware(makeReq("/"))) as unknown as MockMiddlewareResult;
    if (!("__redirect" in res)) throw new Error("expected redirect");
    expect(res.__redirect).toBe(true);
  });
});
