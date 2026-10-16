import React from "react";
import { AccessibilityInfo, Animated, AppState } from "react-native";
import { act, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// 15.2.1 — capture wait scene: elapsed-time stage derivation, monotonic
// clamp, per-stage announcements, and Reduce Motion behavior.
//
// This file previously covered the G-15.1 capture-stage pulse; the pulse
// was retired by the approved Gate A plan (the scene replaces the pulsing
// status line), so those assertions are superseded by the ones below.
//
// Screen-level test through the route module's default export (no named
// production exports — route files in this repo expose only the screen).
// Stage COPY assertions are kept deliberately: the ladder copy is a locked
// contract. The scene's own state seam is its per-group testIDs.
// ---------------------------------------------------------------------------

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
  useFocusEffect: jest.fn(),
}));
jest.mock("expo-clipboard", () => ({}));
jest.mock("expo-image-picker", () => ({}));
jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: {},
  SaveFormat: { JPEG: "jpeg" },
}));
jest.mock("expo-linking", () => ({}));
jest.mock("expo-file-system/legacy", () => ({}));

const mockUploadMutation = {
  mutate: jest.fn(),
  reset: jest.fn(),
  isPending: false,
  isSuccess: false,
  error: null,
};
const mockUrlMutation = {
  mutate: jest.fn(),
  reset: jest.fn(),
  isPending: false,
  isSuccess: false,
  error: null,
};
jest.mock("../../lib/hooks", () => ({
  useCaptureUpload: jest.fn(() => mockUploadMutation),
  useCaptureURL: jest.fn(() => mockUrlMutation),
}));
jest.mock("../../lib/api/endpoints", () => ({
  listDrafts: jest.fn(),
}));
jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ signOut: jest.fn() })),
}));
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: jest.fn(),
}));

// Controllable reduce-motion state — the scene's SceneGroups deep-import
// the hook, so mocking the deep module path covers them.
const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import AddScreen from "../../app/(app)/(tabs)/add";

const STAGE_COPY = [
  "Uploading image…",
  "Analyzing your recipe…",
  "Still working — complex recipes take a bit longer…",
  "Almost there…",
] as const;

// Spy once for the whole file and never restore. jest-expo's preset ships
// these as preconfigured mocks; mockRestore() wipes the preset's
// implementation (AppState.addEventListener would return undefined for
// every later test in the file). mockClear() in beforeEach keeps call
// counts test-local without touching the implementation.
const announceSpy = jest
  .spyOn(AccessibilityInfo, "announceForAccessibility")
  .mockImplementation(() => {});
const appStateSpy = jest.spyOn(AppState, "addEventListener");

/** Invoke every AppState listener the screen registered with "active". */
function emitAppStateActive() {
  act(() => {
    for (const call of appStateSpy.mock.calls) {
      (call[1] as (state: string) => void)("active");
    }
  });
}

// The scene subtree is deliberately hidden from assistive technology, so
// RNTL's default queries exclude it — that exclusion is itself the hiding
// proof. Scene structure assertions opt in explicitly.
const HIDDEN = { includeHiddenElements: true } as const;

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Flush pending microtasks inside act. The ThemeProvider loads its
 * persisted preference asynchronously; settling it inside the test keeps
 * React's act queue clean across the suite (an unsettled provider update
 * from one test surfaces as an AggregateError in the next test's act).
 */
async function settle() {
  await act(async () => {});
}

async function renderScreen() {
  const view = renderWithTheme(<AddScreen />);
  await settle();
  return view;
}

describe("AddScreen capture wait scene — stage derivation + a11y (15.2.1)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUploadMutation.isPending = false;
    mockUploadMutation.isSuccess = false;
    mockUploadMutation.error = null;
    announceSpy.mockClear();
    appStateSpy.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    mockUseReducedMotion.mockImplementation(() => false);
  });

  it("pending shows the scene at stage 0 and announces stage 0 exactly once", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();

    expect(screen.getByTestId("capture-scene", HIDDEN)).toBeTruthy();
    expect(screen.getByTestId("capture-scene-frame", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("capture-scene-structure", HIDDEN)).toBeNull();
    expect(screen.getByText(STAGE_COPY[0])).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenCalledWith(STAGE_COPY[0]);
  });

  it("the stage status text carries the Android polite live region (T-2)", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();

    // The copy is only used to LOCATE the status element (the ladder copy
    // is already a pinned contract elsewhere in this file); the assertion
    // under test is the Android accessibility contract on that element.
    expect(
      screen.getByText(STAGE_COPY[0]).props.accessibilityLiveRegion,
    ).toBe("polite");
  });

  it("derives every ladder stage at its exact threshold with the exact copy", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();

    advance(3_000);
    expect(screen.getByText(STAGE_COPY[1])).toBeTruthy();
    expect(screen.getByTestId("capture-scene-structure", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("capture-scene-ingredients", HIDDEN)).toBeNull();

    advance(27_000); // t = 30s
    expect(screen.getByText(STAGE_COPY[2])).toBeTruthy();
    expect(screen.getByTestId("capture-scene-ingredients", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("capture-scene-method", HIDDEN)).toBeNull();

    advance(30_000); // t = 60s
    expect(screen.getByText(STAGE_COPY[3])).toBeTruthy();
    expect(screen.getByTestId("capture-scene-method", HIDDEN)).toBeTruthy();

    expect(announceSpy).toHaveBeenCalledTimes(4);
    expect(announceSpy).toHaveBeenNthCalledWith(2, STAGE_COPY[1]);
    expect(announceSpy).toHaveBeenNthCalledWith(3, STAGE_COPY[2]);
    expect(announceSpy).toHaveBeenNthCalledWith(4, STAGE_COPY[3]);
  });

  it("completion before 3 seconds clears the scene and stage copy cleanly", async () => {
    mockUploadMutation.isPending = true;
    const view = await renderScreen();
    advance(1_000);

    mockUploadMutation.isPending = false;
    view.rerender(<AddScreen />);
    await settle();

    expect(screen.queryByTestId("capture-scene", HIDDEN)).toBeNull();
    expect(screen.queryByText(STAGE_COPY[0])).toBeNull();
    // No stray stage timers keep announcing after the attempt ended.
    advance(60_000);
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it("a retry re-anchors to stage 0 and announces stage 0 again", async () => {
    mockUploadMutation.isPending = true;
    const view = await renderScreen();
    advance(30_000); // stage 2 on the first attempt

    mockUploadMutation.isPending = false;
    view.rerender(<AddScreen />);
    await settle();
    mockUploadMutation.isPending = true;
    view.rerender(<AddScreen />);
    await settle();

    expect(screen.getByText(STAGE_COPY[0])).toBeTruthy();
    expect(screen.queryByTestId("capture-scene-ingredients", HIDDEN)).toBeNull();
    // First attempt: stages 0,1,2. Retry: stage 0 again.
    expect(announceSpy).toHaveBeenCalledTimes(4);
    expect(announceSpy).toHaveBeenLastCalledWith(STAGE_COPY[0]);
  });

  it("foregrounding across suspended thresholds announces only the current stage", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();
    expect(announceSpy).toHaveBeenCalledTimes(1);

    // Simulate iOS timer suspension: the wall clock advances but no
    // scheduled timer fires. Foregrounding must re-derive from elapsed.
    act(() => {
      jest.setSystemTime(Date.now() + 35_000);
    });
    emitAppStateActive();

    expect(screen.getByText(STAGE_COPY[2])).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith(STAGE_COPY[2]);
    // The skipped intermediate stage is never replayed.
    expect(announceSpy).not.toHaveBeenCalledWith(STAGE_COPY[1]);
  });

  it("monotonic clamp: a backward clock step never regresses the stage", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();
    advance(3_000); // stage 1
    expect(screen.getByText(STAGE_COPY[1])).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledTimes(2);

    act(() => {
      jest.setSystemTime(Date.now() - 10_000);
    });
    emitAppStateActive();

    // Still stage 1 — no regression, no repeat announcement.
    expect(screen.getByText(STAGE_COPY[1])).toBeTruthy();
    expect(screen.queryByText(STAGE_COPY[0])).toBeNull();
    expect(announceSpy).toHaveBeenCalledTimes(2);
  });

  it("a forward clock step only ever advances the stage", async () => {
    mockUploadMutation.isPending = true;
    await renderScreen();

    act(() => {
      jest.setSystemTime(Date.now() + 61_000);
    });
    emitAppStateActive();

    expect(screen.getByText(STAGE_COPY[3])).toBeTruthy();
    expect(announceSpy).toHaveBeenLastCalledWith(STAGE_COPY[3]);
  });

  it("reduce-motion flips mid-capture neither reset the ladder nor re-announce", async () => {
    mockUploadMutation.isPending = true;
    const view = await renderScreen();
    expect(announceSpy).toHaveBeenCalledTimes(1);

    mockUseReducedMotion.mockImplementation(() => true);
    view.rerender(<AddScreen />);
    await settle();
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(STAGE_COPY[0])).toBeTruthy();

    // Ladder timers survive the flip: the 3s stage still arrives on time.
    advance(3_000);
    expect(screen.getByText(STAGE_COPY[1])).toBeTruthy();

    mockUseReducedMotion.mockImplementation(() => false);
    view.rerender(<AddScreen />);
    await settle();
    expect(announceSpy).toHaveBeenCalledTimes(2);
  });

  it("reduce motion true: scene renders statically with zero animation timings", async () => {
    mockUseReducedMotion.mockImplementation(() => true);
    mockUploadMutation.isPending = true;
    const timingSpy = jest.spyOn(Animated, "timing");
    await renderScreen();

    advance(3_000); // reveal the structure group under RM
    expect(screen.getByTestId("capture-scene-structure", HIDDEN)).toBeTruthy();
    expect(screen.getByText(STAGE_COPY[1])).toBeTruthy();
    // No skeleton pulse, no reveal fade — fully static.
    expect(timingSpy).not.toHaveBeenCalled();
    timingSpy.mockRestore();
  });

  it("unmount while pending cleans up timers and listeners silently", async () => {
    mockUploadMutation.isPending = true;
    const view = await renderScreen();
    expect(announceSpy).toHaveBeenCalledTimes(1);

    view.unmount();
    // Stage timers were cleared on unmount: nothing fires, nothing announces.
    // (The AppState subscription is removed by the same cleanup; invoking
    // stale captured handlers here would bypass that removal, so the timer
    // silence is the honest observable.)
    advance(120_000);
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });
});
