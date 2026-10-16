import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithTheme } from "../test-utils";

/**
 * 15.3.S-CF7: Settings Debug section is dev-only.
 *
 * The section is gated at render time on
 * `typeof __DEV__ !== "undefined" && __DEV__`. Under jest (NODE_ENV=test)
 * babel-preset-expo does NOT inline `__DEV__` (it inlines it to literal
 * `false` only in production bundles), so the component reads the runtime
 * global on every render. These tests toggle that global between fresh
 * mounts of the SAME cached Settings module: if the gate were captured at
 * module scope instead of read per render, the visible -> hidden sequence
 * below would fail, so module caching cannot produce a false pass.
 */

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
}));

jest.mock("../../lib/api/endpoints", () => ({
  listCaptureTokens: jest.fn(async () => []),
  revokeCaptureToken: jest.fn(async () => undefined),
}));

jest.mock("../../lib/auth/storage", () => ({
  removeCaptureToken: jest.fn(async () => undefined),
  getCaptureTokenId: jest.fn(async () => null),
}));

jest.mock("../../lib/auth/tokenOrchestrator", () => ({
  provisionAndStoreCaptureToken: jest.fn(async () => ({ ok: true })),
}));

jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ signOut: jest.fn(async () => undefined) })),
}));

import SettingsScreen from "../../app/(app)/(tabs)/settings";

const globalWithDev = globalThis as { __DEV__?: boolean };

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderWithTheme(
    <QueryClientProvider client={queryClient}>
      <SettingsScreen />
    </QueryClientProvider>,
  );
}

describe("Settings Debug section gating (15.3.S-CF7)", () => {
  const originalDev = globalWithDev.__DEV__;

  afterEach(() => {
    globalWithDev.__DEV__ = originalDev;
  });

  it("shows the Debug section when __DEV__ is true", () => {
    globalWithDev.__DEV__ = true;
    const { getByText, unmount } = renderSettings();
    expect(getByText("Debug")).toBeTruthy();
    expect(getByText(/^API: /)).toBeTruthy();
    expect(getByText(/^Web: /)).toBeTruthy();
    unmount();
  });

  it("hides the Debug section when __DEV__ is false", () => {
    globalWithDev.__DEV__ = false;
    const { queryByText, unmount } = renderSettings();
    expect(queryByText("Debug")).toBeNull();
    expect(queryByText(/^API: /)).toBeNull();
    expect(queryByText(/^Web: /)).toBeNull();
    unmount();
  });

  it("fails closed when __DEV__ is absent (undefined)", () => {
    // Deleting the global is not simulatable under jest: React Native's own
    // source references bare `__DEV__` and would throw before our gate runs.
    // `undefined` exercises the same typeof-guard branch at the gate site;
    // the truly-undeclared case is covered by the guard's language semantics
    // and, in release bundles, by babel-preset-expo inlining `__DEV__` to a
    // literal `false` (the section is compiled away entirely).
    globalWithDev.__DEV__ = undefined;
    const { queryByText, unmount } = renderSettings();
    expect(queryByText("Debug")).toBeNull();
    expect(queryByText(/^API: /)).toBeNull();
    unmount();
  });

  it("reads the flag per render, not at module load (cache-safety)", () => {
    globalWithDev.__DEV__ = true;
    const first = renderSettings();
    expect(first.getByText("Debug")).toBeTruthy();
    first.unmount();

    globalWithDev.__DEV__ = false;
    const second = renderSettings();
    expect(second.queryByText("Debug")).toBeNull();
    second.unmount();

    globalWithDev.__DEV__ = true;
    const third = renderSettings();
    expect(third.getByText("Debug")).toBeTruthy();
    third.unmount();
  });
});
