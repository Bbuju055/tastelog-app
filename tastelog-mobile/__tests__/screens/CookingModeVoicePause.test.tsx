import React from "react";
import { Animated, Modal } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen under test is imported.
//
// Mirrors the CookingModeVoiceToggle harness, plus a per-file override of
// @react-navigation/native useFocusEffect that captures the cook screen's
// focus callback + cleanup so tests can simulate blur/refocus WITHOUT
// unmounting (the real Riff fullScreenModal push blurs cook but keeps it
// mounted — verified via the shipped useScreenTheme/useFocusEffect
// precedent across these same two routes). This per-file mock replaces the
// global jest.setup.js stub for THIS file only.
// ---------------------------------------------------------------------------

const mockTimingCallbacks: Array<(result: { finished: boolean }) => void> = [];

const mockUseRecipe = jest.fn();
jest.mock("../../lib/hooks", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipe(...args),
}));

const mockRouterBack = jest.fn();
const mockRouterPush = jest.fn();
const mockUseLocalSearchParams = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({ back: mockRouterBack, push: mockRouterPush }),
}));

const mockHapticTap = jest.fn();
const mockHapticSuccess = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: () => mockHapticTap(),
  hapticSuccess: () => mockHapticSuccess(),
}));

jest.mock("expo-keep-awake", () => ({
  useKeepAwake: jest.fn(),
}));

jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context"),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return {
    Gesture: {
      Pan: () => ({
        activeOffsetX: function () {
          return this;
        },
        failOffsetY: function () {
          return this;
        },
        runOnJS: function () {
          return this;
        },
        onEnd: function () {
          return this;
        },
        withTestId: function () {
          return this;
        },
      }),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      View ? <View>{children}</View> : children,
  };
});

// Capturing useFocusEffect mock (Issue 2 harness correction). The cook
// screen now registers MULTIPLE focus effects (useScreenTheme, the voice
// focus gate, and the navigation guard), so the old "last callback is the
// voice gate" assumption no longer holds. The harness captures and drives
// ALL of them: simulateBlur runs every active cleanup, simulateRefocus
// re-runs every mounted callback. The voice-gate assertions stay
// meaningful because its cleanup/callback are among those driven, and the
// other focus effects (theme declaration, guard reset) are idempotent.
// Mount/unmount behavior mirrors the global jest.setup.js stub.
type FocusCb = () => void | (() => void);
const mockMountedFocusCbs = new Set<FocusCb>();
const mockActiveFocusCleanups = new Map<FocusCb, () => void>();

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  return {
    ...actual,
    useFocusEffect: (cb: FocusCb) => {
      const { useEffect } = require("react");
      useEffect(() => {
        mockMountedFocusCbs.add(cb);
        const cleanup = cb();
        if (typeof cleanup === "function") {
          mockActiveFocusCleanups.set(cb, cleanup);
        }
        return () => {
          mockMountedFocusCbs.delete(cb);
          const c = mockActiveFocusCleanups.get(cb);
          mockActiveFocusCleanups.delete(cb);
          if (typeof c === "function") c();
        };
      }, [cb]);
    },
  };
});

type CapturedHookOpts = {
  enabled: boolean;
  onNext: () => void;
  onBack: () => void;
  onRepeat: () => void;
  canGoNext: boolean;
  canGoPrev: boolean;
  isTransitioning: boolean;
};
const capturedHookOptions: CapturedHookOpts[] = [];
let mockVoiceState: {
  isListening: boolean;
  lastCommand: string | null;
  permissionStatus: "undetermined" | "granted" | "denied";
  error: string | null;
} = {
  isListening: false,
  lastCommand: null,
  permissionStatus: "undetermined",
  error: null,
};
const mockRequestPermissions = jest.fn();

jest.mock("../../lib/cooking", () => {
  const actual = jest.requireActual("../../lib/cooking");
  return {
    ...actual,
    useVoiceCommands: (opts: CapturedHookOpts) => {
      capturedHookOptions.push(opts);
      return {
        ...mockVoiceState,
        requestPermissions: mockRequestPermissions,
      };
    },
  };
});

beforeAll(() => {
  jest.spyOn(Animated, "timing").mockImplementation(
    (_value: Animated.Value | Animated.ValueXY, _config: object) => {
      return {
        start: (callback?: (result: { finished: boolean }) => void) => {
          if (callback) mockTimingCallbacks.push(callback);
        },
        stop: jest.fn(),
        reset: jest.fn(),
      } as unknown as Animated.CompositeAnimation;
    },
  );
});

import CookingModeScreen from "../../app/(app)/recipe/cook/[id]";
import type {
  IngredientResponse,
  RecipeDetailResponse,
  StepResponse,
} from "../../lib/api/schemas";

function makeStep(position: number, instruction: string): StepResponse {
  return {
    id: `step-${position}`,
    recipe_id: "recipe-1",
    position,
    instruction,
  };
}

function makeIngredient(
  position: number,
  name: string,
): IngredientResponse {
  return {
    id: `ingredient-${position}`,
    recipe_id: "recipe-1",
    position,
    quantity: null,
    unit: null,
    name,
    prep: null,
    raw_text: null,
  };
}

function makeRecipe(steps: StepResponse[]): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Test Recipe",
    servings: null,
    prep_time: null,
    cook_time: null,
    image_storage_keys: null,
    raw_model_json: null,
    source_url: null,
    favorite: false,
    cook_count: null,
    last_cooked_at: null,
    notes: null,
    parent_recipe_id: null,
    riff_session_id: null,
    riff_label: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ingredients: [makeIngredient(1, "salt")],
    steps,
    tags: [],
  };
}

function flushAllAnimations(): void {
  while (mockTimingCallbacks.length > 0) {
    const cb = mockTimingCallbacks.shift();
    act(() => {
      cb?.({ finished: true });
    });
  }
}

function lastEnabled(): boolean {
  const last = capturedHookOptions[capturedHookOptions.length - 1];
  expect(last).toBeDefined();
  return last.enabled;
}

function simulateBlur(): void {
  act(() => {
    for (const [cb, cleanup] of Array.from(mockActiveFocusCleanups)) {
      mockActiveFocusCleanups.delete(cb);
      cleanup();
    }
  });
}

function simulateRefocus(): void {
  act(() => {
    for (const cb of Array.from(mockMountedFocusCbs)) {
      const cleanup = cb();
      if (typeof cleanup === "function") {
        mockActiveFocusCleanups.set(cb, cleanup);
      }
    }
  });
}

async function toggleVoiceOn(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText("Voice control off"));
  });
}

beforeEach(() => {
  mockUseRecipe.mockReset();
  mockRouterBack.mockReset();
  mockRouterPush.mockReset();
  mockUseLocalSearchParams.mockReset();
  mockHapticTap.mockReset();
  mockHapticSuccess.mockReset();
  mockRequestPermissions.mockReset();
  capturedHookOptions.length = 0;
  mockTimingCallbacks.length = 0;
  mockMountedFocusCbs.clear();
  mockActiveFocusCleanups.clear();
  mockVoiceState = {
    isListening: false,
    lastCommand: null,
    permissionStatus: "undetermined",
    error: null,
  };
  mockUseLocalSearchParams.mockReturnValue({ id: "recipe-1" });
});

function renderCook(steps: StepResponse[]) {
  mockUseRecipe.mockReturnValue({
    data: makeRecipe(steps),
    error: null,
    isLoading: false,
    refetch: jest.fn(),
  });
  return renderWithTheme(<CookingModeScreen />);
}

describe("CookingModeVoicePause", () => {
  it("voice on + focused → hook enabled is true", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    await toggleVoiceOn();
    expect(lastEnabled()).toBe(true);
  });

  it("voice on + All Ingredients sheet open → hook enabled is false; close re-enables (Issue 1 D2)", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    await toggleVoiceOn();
    expect(lastEnabled()).toBe(true);

    act(() => {
      fireEvent.press(screen.getByLabelText("All ingredients"));
    });
    expect(lastEnabled()).toBe(false);
    // Voice toggle intent is preserved (mic still shows "on").
    expect(screen.getByLabelText("Voice control on")).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByLabelText("Close ingredients"));
    });
    expect(lastEnabled()).toBe(true);
  });

  it("voice on + blurred → hook enabled is false (intent preserved)", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    await toggleVoiceOn();
    expect(lastEnabled()).toBe(true);

    simulateBlur();

    expect(lastEnabled()).toBe(false);
    // User's voice toggle intent is preserved (mic still shows "on").
    expect(screen.getByLabelText("Voice control on")).toBeTruthy();
  });

  it("refocus while still toggled on → hook enabled is true again", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    await toggleVoiceOn();

    simulateBlur();
    expect(lastEnabled()).toBe(false);

    simulateRefocus();
    expect(lastEnabled()).toBe(true);
  });

  it("toggle off stays off across blur and refocus", () => {
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    expect(lastEnabled()).toBe(false);

    simulateBlur();
    expect(lastEnabled()).toBe(false);

    simulateRefocus();
    expect(lastEnabled()).toBe(false);
  });

  it("existing navigation command behavior unchanged while focused", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([
      makeStep(1, "Step one"),
      makeStep(2, "Step two"),
      makeStep(3, "Step three"),
    ]);
    await toggleVoiceOn();
    expect(lastEnabled()).toBe(true);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();

    const onNext =
      capturedHookOptions[capturedHookOptions.length - 1].onNext;
    act(() => {
      onNext();
    });
    flushAllAnimations();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("focused-on-mount does not suppress the existing toggle flow", async () => {
    // Initial screenFocused=true must not gate the normal off→on flow:
    // enabled is false only because voiceEnabled is false, then flips to
    // true purely from the toggle (no blur involved).
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
    expect(lastEnabled()).toBe(false);

    await toggleVoiceOn();

    expect(screen.getByLabelText("Voice control on")).toBeTruthy();
    expect(lastEnabled()).toBe(true);
  });

  it("disables voice while the completion beat is active (15.2.3-C)", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Only step")]);
    await toggleVoiceOn();
    expect(lastEnabled()).toBe(true);

    // Done → completion beat: enabled must drop even though voice intent and
    // focus are both still on.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Done cooking"));
    });

    expect(lastEnabled()).toBe(false);
  });

  it("voice back is inert during the completion beat — completion-phase guard (15.2.3-C)", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "First step"), makeStep(2, "Second step")]);
    await toggleVoiceOn();

    // Advance to the last step.
    act(() => {
      capturedHookOptions[capturedHookOptions.length - 1].onNext();
    });
    flushAllAnimations();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    // Done → beat.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Done cooking"));
    });
    expect(lastEnabled()).toBe(false);

    // Voice back during the beat must NOT move the step (without the guard it
    // would retreat to step 1).
    act(() => {
      capturedHookOptions[capturedHookOptions.length - 1].onBack();
    });
    flushAllAnimations();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
  });

  it("returning to cook after completion resets the phase so voice re-enables (15.2.3-C)", async () => {
    mockRequestPermissions.mockResolvedValueOnce(true);
    renderCook([makeStep(1, "Only step")]);
    await toggleVoiceOn();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Done cooking"));
    });
    expect(lastEnabled()).toBe(false);

    // Complete the beat: the completion trigger fires, then the native Modal
    // dismissal drives the handoff + cook-log push (waitForDismiss ordering).
    // Leaving to the cook log and returning runs the focus reset, which clears
    // completionPhase so voice re-enables.
    fireEvent.press(screen.getByTestId("success-beat"));
    act(() => {
      screen
        .UNSAFE_getByType(Modal as unknown as React.ComponentType)
        .props.onDismiss();
    });
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    simulateBlur();
    simulateRefocus();

    expect(lastEnabled()).toBe(true);
  });

  describe("listening indicator (15.2.3-A)", () => {
    async function renderVoiceOnListening(listening: boolean): Promise<void> {
      mockVoiceState.isListening = listening;
      mockRequestPermissions.mockResolvedValueOnce(true);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await toggleVoiceOn();
    }

    // The label is deliberately hidden from assistive tech, so RNTL's default
    // (accessibility-visible) queries exclude it — that exclusion is itself the
    // proof it is not announced. Visual presence is asserted with
    // includeHiddenElements: true.
    const VISUAL = { includeHiddenElements: true } as const;

    it("shows the Listening label when voice on, focused, and listening", async () => {
      await renderVoiceOnListening(true);
      expect(screen.getByText("Listening…", VISUAL)).toBeTruthy();
    });

    it("hides the Listening label when voice is off (even if engine reports listening)", () => {
      mockVoiceState.isListening = true;
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      // voice never toggled on → intent is off, so no visible listening state.
      expect(screen.queryByText("Listening…", VISUAL)).toBeNull();
    });

    it("hides the Listening label on blur while toggle intent stays on", async () => {
      await renderVoiceOnListening(true);
      expect(screen.getByText("Listening…", VISUAL)).toBeTruthy();

      simulateBlur();

      expect(screen.queryByText("Listening…", VISUAL)).toBeNull();
      expect(screen.getByLabelText("Voice control on")).toBeTruthy();
    });

    it("hides the Listening label when the engine is transiently not listening", async () => {
      await renderVoiceOnListening(false);
      expect(screen.queryByText("Listening…", VISUAL)).toBeNull();
    });

    it("does not announce the Listening label (no duplicate live region / churn)", async () => {
      await renderVoiceOnListening(true);
      // Not in the accessibility tree — default query (AT-visible) finds nothing.
      expect(screen.queryByText("Listening…")).toBeNull();
      // But it IS rendered visually, and explicitly hidden from AT so the mic
      // button's accessibilityState/label stays the single announcing affordance.
      const label = screen.getByText("Listening…", VISUAL);
      expect(label.props.importantForAccessibility).toBe("no");
      expect(label.props.accessibilityElementsHidden).toBe(true);
      expect(screen.getByLabelText("Voice control on")).toBeTruthy();
    });
  });
});
