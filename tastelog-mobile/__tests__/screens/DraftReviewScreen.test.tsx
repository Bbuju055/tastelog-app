import React from "react";
import { AccessibilityInfo, Animated, Linking, Modal } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen is imported.
// Narrow Slice I scope: covers only the new Riff entry-row affordance.
// ---------------------------------------------------------------------------

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();

// Controllable route params — the F1 route-isolation regression changes
// the active id mid-test; the top-level beforeEach restores the default.
const mockUseLocalSearchParams = jest.fn((): { id: string } => ({ id: "draft-1" }));
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: jest.fn(() => ({
    replace: mockRouterReplace,
    push: mockRouterPush,
    back: mockRouterBack,
  })),
}));

const mockUseDraftFn = jest.fn();
jest.mock("../../lib/hooks/useDraft", () => ({
  useDraft: (...args: unknown[]) => mockUseDraftFn(...args),
}));

// useDraftConfirm + useDraftDelete return mutation-shaped stubs so the
// screen renders the action area without crashing. Slice I doesn't press
// Save or Discard, so the mutate fns can stay no-op.
const mockConfirmMutation = {
  mutate: jest.fn(),
  isPending: false,
  isSuccess: false,
  error: null,
};
const mockDeleteMutation = {
  mutate: jest.fn(),
  isPending: false,
  error: null,
};
jest.mock("../../lib/hooks/useDraftConfirm", () => ({
  useDraftConfirm: () => mockConfirmMutation,
  useDraftDelete: () => mockDeleteMutation,
}));

// Explicit haptics mock so the press test doesn't depend on the global
// expo-haptics shim in jest.setup.js. Keeps the test focused on Slice I:
// the row renders, pressing it calls router.push, and it does not call
// confirm/delete or router.replace.
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: jest.fn(),
}));

// Controllable reduce-motion state (G-15.1) — the screen deep-imports the
// hook, so the deep module path is mocked.
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import { useReducedMotion } from "../../lib/hooks/useReducedMotion";
import DraftReviewScreen from "../../app/(app)/draft/[id]";
import { ApiError } from "../../lib/errors";
import { hapticTap } from "../../lib/haptics/haptics";
import type { DraftResponse } from "../../lib/api/schemas";

// No screen reader in these runs: the confirmation beat dwell shortens to
// 700ms. Module-scope spy, never restored (restoring a spy over a preset
// mock wipes its implementation — see AddCaptureStageReducedMotion.test).
jest
  .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
  .mockResolvedValue(false);

function makeDraft(overrides: Partial<DraftResponse> = {}): DraftResponse {
  return {
    id: "draft-1",
    user_id: "user-1",
    title: "Test Draft",
    servings: null,
    prep_time: null,
    cook_time: null,
    confidence_score: 0.9,
    ingredients: [{ name: "salt", raw_text: "salt", quantity: null, unit: null, prep: null }],
    steps: [{ position: 1, instruction: "Mix." }],
    image_storage_keys: ["user/p1.jpg"],
    source_url: null,
    raw_model_json: null,
    model_version: "claude-sonnet-4-20250514",
    parser_version: "1.0",
    // Far future: the Issue 2 eligibility rule hides the riff entry for
    // drafts already expired at render time, and these suites run at the
    // real clock.
    expires_at: "2100-01-01T00:00:00Z",
    created_at: "2026-05-12T00:00:00Z",
    updated_at: "2026-05-12T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseLocalSearchParams.mockImplementation(() => ({ id: "draft-1" }));
  mockConfirmMutation.isPending = false;
  mockConfirmMutation.isSuccess = false;
  mockConfirmMutation.error = null;
  mockDeleteMutation.isPending = false;
  mockDeleteMutation.error = null;
});

describe("DraftReviewScreen: Riff entry (Issue 2 shared Button)", () => {
  it("renders the Riff entry as a shared Button (role button) when the draft loads", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftReviewScreen />);

    const entry = screen.getByLabelText("Riff on this draft");
    expect(entry).toBeTruthy();
    expect(entry.props.accessibilityRole).toBe("button");
    expect(entry.props.accessibilityState?.disabled).toBe(false);
    expect(screen.getByText("Riff on this draft")).toBeTruthy();
  });

  it("pressing the Riff entry navigates to /draft/riff/[id] with the draft id", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftReviewScreen />);

    fireEvent.press(screen.getByLabelText("Riff on this draft"));

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/draft/riff/[id]",
      params: { id: "draft-1" },
    });
    // Slice I locked invariants: pure navigation, no mutation, no replace.
    expect(mockConfirmMutation.mutate).not.toHaveBeenCalled();
    expect(mockDeleteMutation.mutate).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("a rapid double tap yields exactly one push AND exactly one haptic (C5/C3)", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftReviewScreen />);

    fireEvent.press(screen.getByLabelText("Riff on this draft"));
    fireEvent.press(screen.getByLabelText("Riff on this draft"));

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  it("announces disabled (not busy) while a delete is in flight (C6)", () => {
    mockDeleteMutation.isPending = true;
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftReviewScreen />);

    const entry = screen.getByLabelText("Riff on this draft");
    expect(entry.props.accessibilityState?.disabled).toBe(true);
    expect(entry.props.accessibilityState?.busy).toBe(false);
    fireEvent.press(entry);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("renders NO riff entry for a draft already expired at render time (C6 absent, not disabled)", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft({ expires_at: "2020-01-01T00:00:00Z" }),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftReviewScreen />);

    expect(screen.queryByLabelText("Riff on this draft")).toBeNull();
    expect(screen.queryByText("Riff on this draft")).toBeNull();
    // The rest of the review surface still renders.
    expect(screen.getByText("Review Draft")).toBeTruthy();
  });
});

describe("DraftReviewScreen — 10.C entrance under reduce motion (G-15.1)", () => {
  function contentOpacityValue(): number {
    const views = screen.UNSAFE_getAllByType(
      Animated.View as unknown as React.ComponentType,
    );
    for (const v of views) {
      const styles = ([] as any[]).concat(v.props.style ?? []).flat(Infinity);
      for (const s of styles) {
        const op = s?.opacity;
        if (op && typeof op.__getValue === "function") return op.__getValue();
      }
    }
    throw new Error("content opacity Animated.Value not found");
  }

  function setupLoadedDraft() {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: null,
      isLoading: false,
      refetch: jest.fn(),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  test("mounts instantly with no timing when reduce motion is true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    setupLoadedDraft();
    const timingSpy = jest.spyOn(Animated, "timing");
    renderWithTheme(<DraftReviewScreen />);
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
  });

  test("stops an active entrance fade and snaps fully visible when the preference flips true", () => {
    setupLoadedDraft();
    const stopFn = jest.fn();
    const timingSpy = jest
      .spyOn(Animated, "timing")
      .mockImplementation(
        () =>
          ({ start: jest.fn(), stop: stopFn }) as unknown as ReturnType<
            typeof Animated.timing
          >,
      );
    const stopAnimationSpy = jest.spyOn(
      Animated.Value.prototype,
      "stopAnimation",
    );
    const view = renderWithTheme(<DraftReviewScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    (useReducedMotion as jest.Mock).mockReturnValue(true);
    view.rerender(<DraftReviewScreen />);

    expect(stopFn).toHaveBeenCalled();
    expect(stopAnimationSpy).toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
    stopAnimationSpy.mockRestore();
  });

  test("no retroactive entrance when the preference flips back false", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    setupLoadedDraft();
    const timingSpy = jest.spyOn(Animated, "timing");
    const view = renderWithTheme(<DraftReviewScreen />);
    expect(timingSpy).not.toHaveBeenCalled();

    (useReducedMotion as jest.Mock).mockReturnValue(false);
    view.rerender(<DraftReviewScreen />);

    // The instant RM render completed the entrance: no delayed 200ms fade.
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
  });

  // Build 4 reliability correction (C2): whenever the draft is renderable,
  // its content is in the tree AND the wrapper is fully opaque, even after
  // the one-shot entrance fade was interrupted by an isLoading flip.
  test("an isLoading flip (false, true, false) after the entrance fade converges to a fully visible draft (Build 4 C2)", () => {
    setupLoadedDraft();
    const stopFn = jest.fn();
    const timingSpy = jest
      .spyOn(Animated, "timing")
      .mockImplementation(
        () =>
          ({ start: jest.fn(), stop: stopFn }) as unknown as ReturnType<
            typeof Animated.timing
          >,
      );
    const view = renderWithTheme(<DraftReviewScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Review Draft")).toBeTruthy();

    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      refetch: jest.fn(),
    });
    view.rerender(<DraftReviewScreen />);
    expect(stopFn).toHaveBeenCalled();
    expect(screen.getByText("Loading draft…")).toBeTruthy();

    setupLoadedDraft();
    view.rerender(<DraftReviewScreen />);

    expect(screen.getByText("Review Draft")).toBeTruthy();
    expect(screen.getByDisplayValue("Test Draft")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    timingSpy.mockRestore();
  });
});

describe("DraftReviewScreen — confirmation success beat (15.2.2)", () => {
  const HIDDEN = { includeHiddenElements: true } as const;

  function advance(ms: number) {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  }

  async function settle() {
    await act(async () => {});
  }

  // The beat runs with waitForDismiss: completing hides its Modal and the
  // replace fires only from the native onDismiss. Drive that signal the way
  // the cook tests do, so the ordering the fix depends on is what is tested.
  function driveBeatDismiss() {
    act(() => {
      screen
        .UNSAFE_getByType(Modal as unknown as React.ComponentType)
        .props.onDismiss();
    });
  }

  function setupLoadedDraft() {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: null,
      isLoading: false,
      refetch: jest.fn(),
    });
  }

  /** Deliver a confirmation success into the screen's captured options. */
  function deliverConfirmSuccess(view: { rerender: (el: React.ReactElement) => void }) {
    const call =
      mockConfirmMutation.mutate.mock.calls[
        mockConfirmMutation.mutate.mock.calls.length - 1
      ];
    const options = call[1] as { onSuccess: (r: { id: string }) => void };
    mockConfirmMutation.isSuccess = true;
    act(() => {
      options.onSuccess({ id: "recipe-9" });
    });
    view.rerender(<DraftReviewScreen />);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("Save success shows the compact beat, blocks the surface, and replaces exactly once", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    expect(mockConfirmMutation.mutate).toHaveBeenCalledTimes(1);

    deliverConfirmSuccess(view);
    await settle();

    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();

    // Save cannot be resubmitted while the beat is visible.
    fireEvent.press(screen.getByText("Save Recipe", HIDDEN));
    expect(mockConfirmMutation.mutate).toHaveBeenCalledTimes(1);
    // Discard and Riff stay blocked under the beat.
    fireEvent.press(screen.getByLabelText("Riff on this draft", HIDDEN));
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockDeleteMutation.mutate).not.toHaveBeenCalled();

    advance(700);
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/(app)/recipe/[id]",
      params: { id: "recipe-9" },
    });
    advance(10_000);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
  });

  it("tapping the beat skips the dwell and replaces exactly once", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    deliverConfirmSuccess(view);
    await settle();

    fireEvent.press(screen.getByLabelText("Saved to your cookbook"));
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    advance(10_000);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
  });

  it("a succeeded confirmation can never be resubmitted", async () => {
    setupLoadedDraft();
    mockConfirmMutation.isSuccess = true;
    renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    expect(mockConfirmMutation.mutate).not.toHaveBeenCalled();
  });

  it("the underlying draft surface is pointer-blocked and AT-hidden during the beat", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    deliverConfirmSuccess(view);
    await settle();

    const views = screen.UNSAFE_getAllByType(
      Animated.View as unknown as React.ComponentType,
    );
    const lockedRoot = views.find(
      (v) =>
        v.props.pointerEvents === "none" &&
        v.props.accessibilityElementsHidden === true &&
        v.props.importantForAccessibility === "no-hide-descendants",
    );
    expect(lockedRoot).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // F1 — confirm-window hold. The post-confirm invalidation 404s the detail
  // query and removes its cache; none of those transitions may unmount the
  // beat or strand the user without the replace.
  // -------------------------------------------------------------------------

  function draftQueryError() {
    return new ApiError({
      message: "Draft not found.",
      kind: "http",
      status: 404,
    });
  }

  it("F1: a post-success 404 on the draft query never unmounts the beat — replace still fires once", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    deliverConfirmSuccess(view);
    await settle();

    // The real post-save world: the detail query refetched and 404'd.
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: draftQueryError(),
      isLoading: false,
      refetch: jest.fn(),
    });
    view.rerender(<DraftReviewScreen />);
    await settle();

    // Held content, no error surface, beat still up.
    expect(screen.getByText("Review Draft", HIDDEN)).toBeTruthy();
    expect(screen.queryByText("Draft not found.", HIDDEN)).toBeNull();
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();

    advance(700);
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/(app)/recipe/[id]",
      params: { id: "recipe-9" },
    });
    advance(10_000);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
  });

  it("F1: a query error arriving while the confirmation is still pending never flashes the error surface", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    // The awaited-invalidation window: mutation still pending, query 404s.
    mockConfirmMutation.isPending = true;
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: draftQueryError(),
      isLoading: false,
      refetch: jest.fn(),
    });
    view.rerender(<DraftReviewScreen />);
    await settle();

    expect(screen.getByText("Review Draft")).toBeTruthy();
    expect(screen.queryByText("Draft not found.")).toBeNull();
    expect(screen.queryByText("Loading draft…")).toBeNull();

    // Success lands after the window: beat mounts, replace fires once.
    mockConfirmMutation.isPending = false;
    deliverConfirmSuccess(view);
    await settle();
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();
    advance(700);
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
  });

  it("F1: the post-removal loading transition never unmounts the beat", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    deliverConfirmSuccess(view);
    await settle();

    // removeQueries stripped the cache: fresh query in loading state.
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      refetch: jest.fn(),
    });
    view.rerender(<DraftReviewScreen />);
    await settle();

    expect(screen.queryByText("Loading draft…", HIDDEN)).toBeNull();
    expect(screen.getByText("Review Draft", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();
    advance(700);
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
  });

  it("RB-4: the source link is disabled for the entire confirm window", async () => {
    const openUrlSpy = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(true as never);
    mockUseDraftFn.mockReturnValue({
      data: makeDraft({ source_url: "https://example.com/recipe" }),
      error: null,
      isLoading: false,
      refetch: jest.fn(),
    });
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    // Idle: the link is active.
    fireEvent.press(screen.getByText(/Imported from example.com/));
    expect(openUrlSpy).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Save Recipe"));
    // Pending window: pointerEvents blocks touch but not AT activation —
    // the Pressable itself must be disabled.
    mockConfirmMutation.isPending = true;
    view.rerender(<DraftReviewScreen />);
    await settle();
    fireEvent.press(screen.getByText(/Imported from example.com/, HIDDEN));
    expect(openUrlSpy).toHaveBeenCalledTimes(1);

    // The beat window keeps it disabled too.
    mockConfirmMutation.isPending = false;
    deliverConfirmSuccess(view);
    await settle();
    fireEvent.press(screen.getByText(/Imported from example.com/, HIDDEN));
    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();
    advance(700);
    expect(mockRouterReplace).not.toHaveBeenCalled();
    driveBeatDismiss();
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    openUrlSpy.mockRestore();
  });

  it("F1: a draft held for route A never renders after a param change to B", async () => {
    setupLoadedDraft();
    const view = renderWithTheme(<DraftReviewScreen />);
    await settle();

    fireEvent.press(screen.getByText("Save Recipe"));
    deliverConfirmSuccess(view);
    await settle();
    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();

    // Contrived param change while the hold is active: the held draft is
    // scoped to route A and must not leak into B's presentation. This is
    // a DEFENSIVE property only — no production path mutates a mounted
    // instance's params (zero setParams calls repo-wide; every draft
    // navigation is a router.push that mounts a fresh instance), so the
    // beat/replace lifecycle under a param swap is deliberately not
    // asserted here.
    mockUseLocalSearchParams.mockImplementation(() => ({ id: "draft-2" }));
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      refetch: jest.fn(),
    });
    view.rerender(<DraftReviewScreen />);
    await settle();

    expect(screen.queryByText("Review Draft", HIDDEN)).toBeNull();
    expect(screen.queryByDisplayValue("Test Draft", HIDDEN)).toBeNull();
    expect(screen.getByText("Loading draft…")).toBeTruthy();
  });
});

describe("extraction uncertainty", () => {
  it("blocks a high-confidence empty draft, allows correction, and blocks clearing the last instruction", () => {
    mockUseDraftFn.mockReturnValue({ data: makeDraft({ confidence_score: 0.99, ingredients: [], steps: [] }), error: undefined, isLoading: false, refetch: jest.fn() });
    renderWithTheme(<DraftReviewScreen />);
    expect(screen.queryByText(/AI confidence/)).toBeNull();
    expect(screen.getByText(/Missing instructions/)).toBeTruthy();
    fireEvent.press(screen.getByText("Save Recipe"));
    expect(mockConfirmMutation.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText("Add ingredient"));
    fireEvent.changeText(screen.getByPlaceholderText("Ingredient"), "1 tsp salt");
    fireEvent.press(screen.getByText("Add instruction"));
    fireEvent.changeText(screen.getByPlaceholderText("Step instruction"), "Mix.");
    fireEvent.press(screen.getByText("Save Recipe"));
    expect(mockConfirmMutation.mutate).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ ingredients: [expect.objectContaining({ name: "1 tsp salt", raw_text: "1 tsp salt" })], steps: [{ position: 1, instruction: "Mix." }] }) }), expect.anything());
    mockConfirmMutation.mutate.mockClear();
    fireEvent.changeText(screen.getByPlaceholderText("Step instruction"), "   ");
    fireEvent.press(screen.getByText("Save Recipe"));
    expect(mockConfirmMutation.mutate).not.toHaveBeenCalled();
  });
});
