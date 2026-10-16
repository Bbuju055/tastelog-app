import React from "react";
import { Animated } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen under test is imported.
//
// Mirrors the CookingModeVoiceToggle harness verbatim. The lib/cooking
// barrel is mocked as { ...requireActual, useVoiceCommands: <stub> }, so
// the REAL buildCookingRiffDraft (Slice 1) runs inside the screen and the
// expected initialDraft is asserted against the real helper imported
// directly below.
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

// Issue 2: capturing useFocusEffect override (replaces the global
// jest.setup.js stub for THIS file only). The cook screen now registers
// MULTIPLE focus effects (useScreenTheme, the voice focus gate, and the
// navigation guard), so the harness captures and drives ALL of them:
// simulateBlur runs every active cleanup, simulateRefocus re-runs every
// mounted callback. Mount/unmount behavior mirrors the global stub.
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
const mockRequestPermissions = jest.fn();

jest.mock("../../lib/cooking", () => {
  const actual = jest.requireActual("../../lib/cooking");
  return {
    ...actual,
    useVoiceCommands: (opts: CapturedHookOpts) => {
      capturedHookOptions.push(opts);
      return {
        isListening: false,
        lastCommand: null,
        permissionStatus: "undetermined" as const,
        error: null,
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
import { buildCookingRiffDraft } from "../../lib/cooking/buildCookingRiffDraft";
import { spacing, radius } from "../../theme";
import type {
  IngredientResponse,
  RecipeDetailResponse,
  StepResponse,
} from "../../lib/api/schemas";

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

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

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
  mockMountedFocusCbs.clear();
  mockActiveFocusCleanups.clear();
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

describe("CookingModeRiffEntry", () => {
  describe("affordance visibility", () => {
    it("renders the Ask Riff affordance in a single-step recipe", () => {
      renderCook([makeStep(1, "Mix all ingredients")]);
      expect(screen.getByText("Ask Riff")).toBeTruthy();
      expect(
        screen.getByLabelText("Ask Riff about this step"),
      ).toBeTruthy();
    });

    it("renders the Ask Riff affordance in a multi-step recipe", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
        makeStep(3, "Step three"),
      ]);
      expect(screen.getByText("Ask Riff")).toBeTruthy();
    });

    it("does NOT render the Ask Riff affordance in the 0-step fallback", () => {
      renderCook([]);
      expect(screen.queryByText("Ask Riff")).toBeNull();
      expect(
        screen.queryByLabelText("Ask Riff about this step"),
      ).toBeNull();
      // 0-step fallback still shows Close.
      expect(screen.getByLabelText("Close cooking mode")).toBeTruthy();
    });
  });

  describe("route push", () => {
    it("pushes /recipe/riff/[id] with id, cooking_mode entryPoint, and step-aware initialDraft", () => {
      const step1 = makeStep(1, "First step");
      renderCook([step1, makeStep(2, "Second step")]);
      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/riff/[id]",
        params: {
          id: "recipe-1",
          entryPoint: "cooking_mode",
          initialDraft: buildCookingRiffDraft(step1),
        },
      });
    });

    it("initialDraft reflects the current step after navigating Next", () => {
      const step1 = makeStep(1, "First step");
      const step2 = makeStep(2, "Second step");
      renderCook([step1, step2, makeStep(3, "Third step")]);

      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();

      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      const pushArg = mockRouterPush.mock.calls[0][0];
      expect(pushArg.params.initialDraft).toBe(
        buildCookingRiffDraft(step2),
      );
      expect(pushArg.params.entryPoint).toBe("cooking_mode");
    });

    it("does not auto-send / does not push on mount", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it("fires hapticTap exactly once on press", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      mockHapticTap.mockClear();
      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
    });

    it("a rapid double tap yields exactly one push AND exactly one haptic (Issue 2 C5/C3)", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      mockHapticTap.mockClear();
      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
    });

    it("after a blur -> focus cycle a second press pushes again (guard reset)", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockRouterPush).toHaveBeenCalledTimes(1);

      // The riff modal blurred this screen, then was dismissed.
      simulateBlur();
      simulateRefocus();

      fireEvent.press(screen.getByLabelText("Ask Riff about this step"));
      expect(mockRouterPush).toHaveBeenCalledTimes(2);
    });
  });

  describe("Issue 2 shared-Button treatment", () => {
    it("All ingredients still opens the sheet with exactly one haptic after the conversion", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      mockHapticTap.mockClear();
      act(() => {
        fireEvent.press(screen.getByLabelText("All ingredients"));
      });
      // The page-sheet renders the full ingredient list under its title.
      expect(screen.getByText("Ingredients")).toBeTruthy();
      expect(screen.getByLabelText("Close ingredients")).toBeTruthy();
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
      // No navigation: the sheet is local state, not a route.
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it("both utility entries are md outline Buttons (44pt floor, sm banned)", () => {
      renderCook([makeStep(1, "Step one"), makeStep(2, "Step two")]);
      for (const label of ["All ingredients", "Ask Riff about this step"]) {
        const entry = screen.getByLabelText(label);
        expect(entry.props.accessibilityRole).toBe("button");
        const style = flattenStyle(entry.props.style);
        // md size contract (same as the recipe-detail grid): uniform
        // padding of spacing.base, not the sm paddingVertical: spacing.sm.
        expect(style.padding).toBe(spacing.base);
        expect(style.paddingVertical).toBeUndefined();
        expect(style.borderRadius).toBe(radius.md);
        expect(style.borderWidth).toBe(1);
        expect(style.backgroundColor).toBe("transparent");
      }
    });
  });

  describe("coexistence with step nav", () => {
    it("Ask Riff coexists with Back/Next in a multi-step recipe", () => {
      renderCook([
        makeStep(1, "Step one"),
        makeStep(2, "Step two"),
        makeStep(3, "Step three"),
      ]);
      expect(screen.getByText("Ask Riff")).toBeTruthy();
      expect(screen.getByLabelText("Previous step")).toBeTruthy();
      expect(screen.getByLabelText("Next step")).toBeTruthy();
    });
  });
});
