import React from "react";
import { AccessibilityInfo, Modal } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// 15.2 Gate A (F1) — integration regression across the REAL query boundary.
//
// The original stranding bug was invisible to the screen-state tests
// because useDraft/useDraftConfirm were mocked statically. This file uses
// the real hooks and a real production-configured QueryClient; only the
// API/network boundary (lib/api/endpoints) plus device seams (router,
// haptics, reduced-motion, screen-reader query) are mocked.
//
// Sequence under test: confirm succeeds → the draft is deleted server-side
// → the hook's awaited invalidateQueries(["drafts"]) refetches the active
// ["drafts", id] detail query which 404s (retry: false) → removeQueries
// strips the cache → the held presentation must survive all of it, the
// beat must stay mounted, and router.replace must fire exactly once.
// ---------------------------------------------------------------------------

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "draft-int-1" })),
  useRouter: jest.fn(() => ({
    replace: mockRouterReplace,
    push: mockRouterPush,
    back: jest.fn(),
  })),
}));

// The API/network boundary — the ONLY data-layer mock in this file.
const mockGetDraft = jest.fn();
const mockConfirmDraft = jest.fn();
const mockDeleteDraft = jest.fn();
jest.mock("../../lib/api/endpoints", () => ({
  getDraft: (...args: unknown[]) => mockGetDraft(...args),
  confirmDraft: (...args: unknown[]) => mockConfirmDraft(...args),
  deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
}));

// F2: with the hooks real, any success haptic recorded here is the single
// one the flow produces — SuccessBeat's own.
const mockHapticSuccess = jest.fn();
const mockHapticWarning = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
  hapticWarning: (...args: unknown[]) => mockHapticWarning(...args),
}));

jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: jest.fn(() => false),
}));

import DraftReviewScreen from "../../app/(app)/draft/[id]";
import { ApiError } from "../../lib/errors";
import type { DraftResponse } from "../../lib/api/schemas";

// No screen reader: the beat dwell shortens to 700ms. Module-scope spy,
// never restored (preset-mock restore hazard — see sibling suites).
jest
  .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
  .mockResolvedValue(false);

const HIDDEN = { includeHiddenElements: true } as const;

const DRAFT: DraftResponse = {
  id: "draft-int-1",
  user_id: "user-1",
  title: "Integration Draft",
  servings: null,
  prep_time: null,
  cook_time: null,
  confidence_score: 0.9,
  ingredients: [],
  steps: [],
  image_storage_keys: ["user/p1.jpg"],
  source_url: null,
  raw_model_json: null,
  model_version: "test-model",
  parser_version: "1.0",
  expires_at: "2026-08-01T00:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

function notFoundError() {
  return new ApiError({
    message: "Draft not found.",
    kind: "http",
    status: 404,
  });
}

/** Mirrors providers/QueryProvider.tsx guardrails exactly. */
function makeProductionConfiguredClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Flush microtasks AND due zero-delay timers: React Query's notifyManager
 * batches state notifications through setTimeout(0), which a pure
 * microtask flush never fires under fake timers.
 */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
}

// The beat runs with waitForDismiss: the replace fires only from the native
// Modal onDismiss. Drive it explicitly (see __tests__/app/recipe/cook.test.tsx).
function driveBeatDismiss() {
  act(() => {
    screen
      .UNSAFE_getByType(Modal as unknown as React.ComponentType)
      .props.onDismiss();
  });
}

/** The held presentation is intact and no loading/error surface leaked. */
function expectHeldFrame() {
  expect(screen.getByText("Review Draft", HIDDEN)).toBeTruthy();
  expect(screen.getByDisplayValue("Integration Draft", HIDDEN)).toBeTruthy();
  expect(screen.queryByText("Loading draft…", HIDDEN)).toBeNull();
  expect(screen.queryByText("Draft not found.", HIDDEN)).toBeNull();
  expect(screen.queryByText("Failed to load draft.", HIDDEN)).toBeNull();
}

describe("DraftReviewScreen — confirm-flow integration across the real query boundary (F1)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRouterReplace.mockClear();
    mockRouterPush.mockClear();
    mockHapticSuccess.mockClear();
    mockHapticWarning.mockClear();
    mockGetDraft.mockReset();
    mockConfirmDraft.mockReset();
    mockDeleteDraft.mockReset();
    queryClient = makeProductionConfiguredClient();
  });

  afterEach(() => {
    queryClient.clear();
    jest.useRealTimers();
  });

  it("save → real 404 invalidation + cache removal → held screen, mounted beat, one haptic, one replace", async () => {
    // (1) Initial load succeeds; (2)+ every refetch after the confirm sees
    // the real post-save world: the draft row is gone → 404.
    mockGetDraft.mockResolvedValueOnce(DRAFT).mockRejectedValue(notFoundError());
    mockConfirmDraft.mockResolvedValue({ id: "recipe-int-9" });

    const view = renderWithTheme(
      <QueryClientProvider client={queryClient}>
        <DraftReviewScreen />
      </QueryClientProvider>,
    );
    await settle();
    await settle();
    expect(screen.getByDisplayValue("Integration Draft")).toBeTruthy();
    expect(mockGetDraft).toHaveBeenCalledTimes(1);

    // (2) Confirm succeeds — the real hook then awaits the RECIPES and
    // DRAFTS invalidations ((3) the active detail query refetches and
    // 404s) and removes the detail cache ((4) removal/loading transition).
    fireEvent.press(screen.getByText("Save Recipe"));
    // Flush the whole callback chain in bounded rounds, asserting at each
    // flushed frame that no loading/error/blank surface appears (5)(6).
    for (let round = 0; round < 6; round++) {
      await settle();
      expectHeldFrame();
    }

    expect(mockConfirmDraft).toHaveBeenCalledTimes(1);
    // The invalidation really did refetch and 404.
    expect(mockGetDraft.mock.calls.length).toBeGreaterThanOrEqual(2);

    // (7) The beat is mounted over the held screen.
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();

    // (5) Held content is non-interactive: pressing Save again does not
    // re-confirm.
    fireEvent.press(screen.getByText("Save Recipe", HIDDEN));
    expect(mockConfirmDraft).toHaveBeenCalledTimes(1);

    // (8) Exactly one success haptic — the beat's (the hooks are real and
    // no longer fire their own).
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    expect(mockHapticWarning).not.toHaveBeenCalled();

    // (9) Dwell expiry → exactly one replace to the saved recipe.
    advance(700);
    await settle();
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/(app)/recipe/[id]",
      params: { id: "recipe-int-9" },
    });

    // Post-completion, pre-unmount: still locked, still held, no repeats.
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DraftReviewScreen />
      </QueryClientProvider>,
    );
    await settle();
    expectHeldFrame();
    fireEvent.press(screen.getByText("Save Recipe", HIDDEN));
    expect(mockConfirmDraft).toHaveBeenCalledTimes(1);
    advance(10_000);
    await settle();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
  });
});
