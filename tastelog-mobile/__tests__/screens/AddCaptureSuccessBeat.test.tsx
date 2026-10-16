import React from "react";
import { AccessibilityInfo, View } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { motion } from "../../theme";

// ---------------------------------------------------------------------------
// 15.2.2 — Add screen success beats (photo + URL): handoff presentation
// lock, beat state, deferred resets, interaction gating, exactly-once
// navigation.
// ---------------------------------------------------------------------------

const mockRouterPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
  useFocusEffect: jest.fn(),
}));
jest.mock("expo-clipboard", () => ({}));

const mockLaunchLibrary = jest.fn(async () => ({
  canceled: false,
  assets: [{ uri: "file:///p1.jpg", assetId: "a1", fileName: "p1.jpg" }],
}));
jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchLibrary(...args),
  MediaTypeOptions: { Images: "Images" },
}));
jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: jest.fn(() => ({
      renderAsync: jest.fn(async () => ({
        saveAsync: jest.fn(async () => ({ uri: "file:///p1-conv.jpg" })),
      })),
    })),
  },
  SaveFormat: { JPEG: "jpeg" },
}));
jest.mock("expo-linking", () => ({}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
}));

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
// Named so the tests can pin exactly-one-haptic-per-success (F2: the
// beat owns the success haptic; the capture hooks no longer fire it —
// and the hooks are mocked here anyway, so any call recorded below
// comes from SuccessBeat itself).
const mockHapticSuccess = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
}));

const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import AddScreen from "../../app/(app)/(tabs)/add";
import { Button } from "../../components/Button";

// No screen reader in these runs: the beat dwell shortens to 700ms.
// Module-scope spy, never restored (preset-mock restore hazard).
jest
  .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
  .mockResolvedValue(false);

const HIDDEN = { includeHiddenElements: true } as const;

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

async function settle() {
  await act(async () => {});
}

async function renderScreen() {
  const view = renderWithTheme(<AddScreen />);
  await settle();
  return view;
}

/** Capture options passed to a mutation's mutate(vars, options). */
function lastMutateOptions(mutateMock: jest.Mock) {
  const call = mutateMock.mock.calls[mutateMock.mock.calls.length - 1];
  return call[1] as {
    onSuccess: (result: { id: string }) => void;
  };
}

describe("AddScreen success beats (15.2.2)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRouterPush.mockClear();
    mockLaunchLibrary.mockClear();
    mockHapticSuccess.mockClear();
    mockUploadMutation.mutate.mockReset();
    mockUploadMutation.reset
      .mockReset()
      .mockImplementation(() => {
        mockUploadMutation.isSuccess = false;
      });
    mockUploadMutation.isPending = false;
    mockUploadMutation.isSuccess = false;
    mockUploadMutation.error = null;
    mockUrlMutation.mutate.mockReset();
    mockUrlMutation.reset
      .mockReset()
      .mockImplementation(() => {
        mockUrlMutation.isSuccess = false;
      });
    mockUrlMutation.isPending = false;
    mockUrlMutation.isSuccess = false;
    mockUrlMutation.error = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    mockUseReducedMotion.mockImplementation(() => false);
  });

  it("photo success: beat shows, resets defer to completion, exactly one router.push", async () => {
    const view = await renderScreen();

    // Pick a photo, then upload.
    await act(async () => {
      fireEvent.press(screen.getByText("Pick Photos from Gallery"));
    });
    expect(screen.getByText("1 page selected (max 5)")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Upload & Capture"));
    });
    expect(mockUploadMutation.mutate).toHaveBeenCalledTimes(1);
    // Picking already called reset once (pre-existing behavior); isolate
    // the completion-path call.
    mockUploadMutation.reset.mockClear();

    // Deliver success.
    mockUploadMutation.isSuccess = true;
    act(() => {
      lastMutateOptions(mockUploadMutation.mutate).onSuccess({ id: "draft-9" });
    });
    view.rerender(<AddScreen />);
    await settle();

    // Beat visible with the photo copy; source state NOT cleared yet.
    expect(screen.getByLabelText("Recipe captured")).toBeTruthy();
    expect(screen.getByText("1 page selected (max 5)", HIDDEN)).toBeTruthy();
    expect(mockUploadMutation.reset).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    // F2: exactly one success haptic — the beat's own (hooks are mocked).
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    // R3: the thumbnail strip is locked during the beat — no remove control.
    expect(screen.queryByText("×", HIDDEN)).toBeNull();

    // Dwell expiry navigates exactly once and performs the resets.
    advance(motion.duration.beat);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-9" },
    });
    expect(mockUploadMutation.reset).toHaveBeenCalledTimes(1);

    view.rerender(<AddScreen />);
    await settle();
    expect(screen.queryByLabelText("Recipe captured")).toBeNull();
    expect(screen.queryByText("1 page selected (max 5)", HIDDEN)).toBeNull();

    // No second navigation from anything — and no second haptic.
    advance(10_000);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
  });

  it("URL success: 'Recipe imported' beat, input clears only at completion, one router.push", async () => {
    const view = await renderScreen();

    fireEvent.changeText(
      screen.getByPlaceholderText("https://example.com/recipe"),
      "https://example.com/r",
    );
    await act(async () => {
      fireEvent.press(screen.getByText("Import"));
    });
    expect(mockUrlMutation.mutate).toHaveBeenCalledTimes(1);
    // Typing already called reset (pre-existing onChangeText behavior);
    // isolate the completion-path call.
    mockUrlMutation.reset.mockClear();

    mockUrlMutation.isSuccess = true;
    act(() => {
      lastMutateOptions(mockUrlMutation.mutate).onSuccess({ id: "draft-7" });
    });
    view.rerender(<AddScreen />);
    await settle();

    expect(screen.getByLabelText("Recipe imported")).toBeTruthy();
    // F2: exactly one success haptic on the URL path too.
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    // The URL input keeps its value through the beat (reset is deferred).
    expect(
      screen.getByPlaceholderText("https://example.com/recipe", HIDDEN).props
        .value,
    ).toBe("https://example.com/r");

    advance(motion.duration.beat);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-7" },
    });
    expect(mockUrlMutation.reset).toHaveBeenCalledTimes(1);

    view.rerender(<AddScreen />);
    await settle();
    expect(
      screen.getByPlaceholderText("https://example.com/recipe").props.value,
    ).toBe("");
  });

  it("success handoff frame: wait presentation holds and capture controls stay locked", async () => {
    const view = await renderScreen();

    // Pick a photo first so the thumbnail strip participates in the
    // handoff-lock assertions (R3).
    await act(async () => {
      fireEvent.press(screen.getByText("Pick Photos from Gallery"));
    });
    expect(screen.getByText("×")).toBeTruthy(); // remove control while idle
    mockLaunchLibrary.mockClear();

    mockUploadMutation.isPending = true;
    view.rerender(<AddScreen />);
    await settle();
    expect(screen.getByTestId("capture-scene", HIDDEN)).toBeTruthy();
    // R3: strip locked while pending.
    expect(screen.queryByText("×", HIDDEN)).toBeNull();

    // The frame where the mutation flipped to success but pendingBeat
    // hasn't landed: the reset Add surface must not flash.
    mockUploadMutation.isPending = false;
    mockUploadMutation.isSuccess = true;
    view.rerender(<AddScreen />);
    await settle();

    expect(screen.getByTestId("capture-scene", HIDDEN)).toBeTruthy();
    expect(screen.getByText("Uploading image…")).toBeTruthy();
    // R3: strip stays locked through the handoff frame — the remove and
    // reorder affordances must not reappear.
    expect(screen.queryByText("×", HIDDEN)).toBeNull();

    // Locked controls: the picker cannot be launched (with an image
    // selected the picker button reads "Change Photos").
    fireEvent.press(screen.getByText("Change Photos", HIDDEN));
    expect(mockLaunchLibrary).not.toHaveBeenCalled();
  });

  it("during the beat the underlying surface is pointer-blocked and AT-hidden; repeated taps navigate once", async () => {
    const view = await renderScreen();

    fireEvent.changeText(
      screen.getByPlaceholderText("https://example.com/recipe"),
      "https://example.com/r",
    );
    await act(async () => {
      fireEvent.press(screen.getByText("Import"));
    });
    mockUrlMutation.isSuccess = true;
    act(() => {
      lastMutateOptions(mockUrlMutation.mutate).onSuccess({ id: "draft-7" });
    });
    view.rerender(<AddScreen />);
    await settle();

    const views = screen.UNSAFE_getAllByType(
      View as unknown as React.ComponentType,
    );
    const lockedRoot = views.find(
      (v) =>
        v.props.pointerEvents === "none" &&
        v.props.accessibilityElementsHidden === true &&
        v.props.importantForAccessibility === "no-hide-descendants",
    );
    expect(lockedRoot).toBeTruthy();

    // First tap skips and navigates; the beat unmounts on completion, so
    // a second tap is impossible by construction.
    fireEvent.press(screen.getByLabelText("Recipe imported"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    view.rerender(<AddScreen />);
    await settle();
    expect(screen.queryByLabelText("Recipe imported")).toBeNull();
    advance(10_000);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
  });

  it("beat window: handler-level guards refuse new work even when invoked directly (T-1)", async () => {
    const view = await renderScreen();

    // Type a URL first so the Import button is NOT empty-input-disabled —
    // the uiLocked handler guard must be what blocks it during the beat.
    fireEvent.changeText(
      screen.getByPlaceholderText("https://example.com/recipe"),
      "https://example.com/other",
    );

    // Photo flow to an active beat.
    await act(async () => {
      fireEvent.press(screen.getByText("Pick Photos from Gallery"));
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Upload & Capture"));
    });
    expect(mockUploadMutation.mutate).toHaveBeenCalledTimes(1);
    mockUploadMutation.isSuccess = true;
    act(() => {
      lastMutateOptions(mockUploadMutation.mutate).onSuccess({ id: "draft-9" });
    });
    view.rerender(<AddScreen />);
    await settle();
    expect(screen.getByLabelText("Recipe captured")).toBeTruthy();

    const permMock = jest.requireMock("expo-image-picker")
      .requestMediaLibraryPermissionsAsync as jest.Mock;
    const permCallsBefore = permMock.mock.calls.length;
    const launchCallsBefore = mockLaunchLibrary.mock.calls.length;

    // Invoke the SCREEN handlers directly through the underlying Button
    // elements' onPress props — this bypasses the Modal's pointer
    // blocking AND RNTL's disabled/pointer-events checks, so what is
    // exercised is the uiLocked guard inside each handler.
    const buttons = screen.UNSAFE_getAllByType(
      Button as unknown as React.ComponentType,
    );
    const byTitle = (title: string) =>
      buttons.find((b) => (b.props as { title?: string }).title === title);
    await act(async () => {
      (byTitle("Upload & Capture")?.props as { onPress: () => void }).onPress();
      (byTitle("Change Photos")?.props as { onPress: () => void }).onPress();
      (byTitle("Import")?.props as { onPress: () => void }).onPress();
    });

    // No new work started anywhere:
    expect(mockUploadMutation.mutate).toHaveBeenCalledTimes(1); // no 2nd capture
    expect(mockUrlMutation.mutate).not.toHaveBeenCalled(); // Import guarded
    expect(permMock.mock.calls.length).toBe(permCallsBefore); // picker guarded
    expect(mockLaunchLibrary.mock.calls.length).toBe(launchCallsBefore);
    expect(mockRouterPush).not.toHaveBeenCalled();

    // Not covered here by construction: the clipboard banner is not
    // rendered in this fixture (no clipboard URL), and Try Again requires
    // mutation.error, which cannot coexist with a success beat.

    // Navigation remains governed solely by the active beat.
    advance(motion.duration.beat);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-9" },
    });
  });
});
