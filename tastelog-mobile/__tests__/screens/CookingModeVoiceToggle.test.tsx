import React from "react";
import { Animated } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen under test is imported.
//
// This file tests the cook screen's wiring to useVoiceCommands. It mocks
// the lib/cooking barrel directly so we can: (a) capture the props the
// screen passes to the hook on every render, (b) control the hook's
// returned state per test (isListening, error, permissionStatus), and
// (c) invoke captured callbacks (onNext / onBack / onRepeat) to assert
// downstream wiring without re-testing the hook's internals (covered
// exhaustively in __tests__/lib/cooking/useVoiceCommands.test.ts).
// ---------------------------------------------------------------------------

const mockTimingCallbacks: Array<(result: { finished: boolean }) => void> = [];

const mockUseRecipe = jest.fn();
jest.mock("../../lib/hooks", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipe(...args),
}));

// Controllable reduce-motion state (G-15.1) — the screen deep-imports the
// hook, so the deep module path is mocked. Default false preserves the
// animated-path behavior for every pre-existing test.
const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
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

// react-native-safe-area-context: cook screen uses useSafeAreaInsets to
// position the header below the iOS clock / Dynamic Island. v5+ of the hook
// throws outside a SafeAreaProvider, so tests provide a zero-insets stub.
// Same per-file pattern Riff uses (commit 570012a).
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

// useVoiceCommands hook mock — captures opts per render and exposes
// controllable state. The state is read at render time, so any test that
// needs a particular state must set mockVoiceState BEFORE renderWithTheme.
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
import { Ionicons } from "@expo/vector-icons";
import { darkPalette } from "../../theme/palettes";

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

describe("CookingModeVoiceToggle", () => {
  describe("mic toggle visibility", () => {
    it("does NOT render in 0-step fallback", () => {
      renderCook([]);
      expect(screen.queryByLabelText(/voice control/i)).toBeNull();
    });

    it("renders in single-step recipe", () => {
      renderCook([makeStep(1, "Add salt")]);
      expect(screen.getByLabelText("Voice control off")).toBeTruthy();
    });

    it("renders in multi-step recipe", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
        makeStep(3, "Step three"),
      ]);
      expect(screen.getByLabelText("Voice control off")).toBeTruthy();
    });
  });

  describe("toggle flow", () => {
    it("first tap when permission undetermined calls requestPermissions", async () => {
      mockRequestPermissions.mockResolvedValueOnce(false);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    });

    it("granted permission flips toggle to on", async () => {
      mockRequestPermissions.mockResolvedValueOnce(true);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      expect(screen.getByLabelText("Voice control on")).toBeTruthy();
    });

    it("denied permission keeps toggle off", async () => {
      mockRequestPermissions.mockResolvedValueOnce(false);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      expect(screen.getByLabelText("Voice control off")).toBeTruthy();
      expect(screen.queryByLabelText("Voice control on")).toBeNull();
    });

    it("tap when on flips off without re-requesting permissions", async () => {
      mockRequestPermissions.mockResolvedValueOnce(true);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      // Now on — pressing again should disable without re-requesting.
      mockRequestPermissions.mockClear();
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control on"));
      });
      expect(screen.getByLabelText("Voice control off")).toBeTruthy();
      expect(mockRequestPermissions).not.toHaveBeenCalled();
    });

    it("tap when permission already granted skips requestPermissions", async () => {
      mockVoiceState.permissionStatus = "granted";
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      expect(mockRequestPermissions).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Voice control on")).toBeTruthy();
    });
  });

  describe("error rendering", () => {
    it("renders the hook's error message inline when set", () => {
      mockVoiceState.error =
        "Microphone access was denied. Open Settings to enable it.";
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      expect(screen.getByText(/microphone access was denied/i)).toBeTruthy();
      expect(screen.getByText(/Settings/)).toBeTruthy();
    });

    it("renders no error text when voice.error is null", () => {
      mockVoiceState.error = null;
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      expect(screen.queryByText(/denied/i)).toBeNull();
    });
  });

  describe("hook wiring (props passed in)", () => {
    it("passes nav.canGoNext, canGoPrev, isTransitioning to the hook", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      const lastOpts = capturedHookOptions[capturedHookOptions.length - 1];
      expect(lastOpts).toBeDefined();
      expect(lastOpts.canGoPrev).toBe(false); // step 0
      expect(lastOpts.canGoNext).toBe(true); // multi-step
      expect(lastOpts.isTransitioning).toBe(false); // initial
    });

    it("toggles `enabled` from false to true after grant", async () => {
      mockRequestPermissions.mockResolvedValueOnce(true);
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      const initialOpts = capturedHookOptions[capturedHookOptions.length - 1];
      expect(initialOpts.enabled).toBe(false);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      const postToggleOpts =
        capturedHookOptions[capturedHookOptions.length - 1];
      expect(postToggleOpts.enabled).toBe(true);
    });
  });

  describe("hook callbacks (downstream wiring)", () => {
    it("captured onNext advances the step counter", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
        makeStep(3, "Step three"),
      ]);
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
      const onNext =
        capturedHookOptions[capturedHookOptions.length - 1].onNext;
      act(() => {
        onNext();
      });
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    });

    it("captured onBack retreats the step counter", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
        makeStep(3, "Step three"),
      ]);
      // Advance to step 2 first
      act(() => {
        capturedHookOptions[capturedHookOptions.length - 1].onNext();
      });
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
      // Now go back via captured onBack
      act(() => {
        capturedHookOptions[capturedHookOptions.length - 1].onBack();
      });
      flushAllAnimations();
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    });

    it("captured onRepeat fires hapticTap and triggers an Animated.timing sequence", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
      ]);
      mockHapticTap.mockClear();
      const timingCallsBefore = mockTimingCallbacks.length;
      act(() => {
        capturedHookOptions[capturedHookOptions.length - 1].onRepeat();
      });
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
      // The Animated.sequence schedules two timing animations (fade-out + fade-in).
      expect(mockTimingCallbacks.length).toBeGreaterThan(timingCallsBefore);
    });

    it("captured onRepeat under reduce motion fires hapticTap and skips the re-flash (G-15.1)", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
      ]);
      mockHapticTap.mockClear();
      const timingCallsBefore = mockTimingCallbacks.length;
      act(() => {
        capturedHookOptions[capturedHookOptions.length - 1].onRepeat();
      });
      // Haptic preserved exactly; no timing scheduled — no visual re-flash.
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
      expect(mockTimingCallbacks.length).toBe(timingCallsBefore);
      mockUseReducedMotion.mockImplementation(() => false);
    });
  });

  describe("mic icon name + color (engine state vs user intent)", () => {
    it("voiceEnabled=false renders mic-off icon with palette.text3 color", () => {
      const { UNSAFE_getByType } = renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
      ]);
      const icon = UNSAFE_getByType(Ionicons);
      expect(icon.props.name).toBe("mic-off");
      expect(icon.props.color).toBe(darkPalette.text3);
    });

    it("voiceEnabled=true + isListening=true renders mic icon with palette.primary color", async () => {
      mockVoiceState.permissionStatus = "granted";
      mockVoiceState.isListening = true;
      const { UNSAFE_getByType } = renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
      ]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      const icon = UNSAFE_getByType(Ionicons);
      expect(icon.props.name).toBe("mic");
      expect(icon.props.color).toBe(darkPalette.primary);
    });

    it("voiceEnabled=true + isListening=false (transient) renders mic icon with palette.text3 color", async () => {
      mockVoiceState.permissionStatus = "granted";
      mockVoiceState.isListening = false;
      const { UNSAFE_getByType } = renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
      ]);
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Voice control off"));
      });
      const icon = UNSAFE_getByType(Ionicons);
      expect(icon.props.name).toBe("mic");
      expect(icon.props.color).toBe(darkPalette.text3);
    });
  });
});
