import React from "react";
import { Animated, Modal } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen under test is imported.
// ---------------------------------------------------------------------------

/**
 * Animated.timing callback queue.
 *
 * Populated by the spy installed in beforeAll. Tests can:
 *   (a) assert state DURING a transition (rapid-tap lock test)
 *   (b) call flushAllAnimations() to advance past the transition.
 *
 * The spy only touches Animated.timing; Animated.Value, Animated.View, and
 * everything else remain the real module exports.
 */
const mockTimingCallbacks: Array<(result: { finished: boolean }) => void> = [];

// useRecipe mock (via the hooks barrel — the cook screen imports from it).
const mockUseRecipe = jest.fn();
jest.mock("../../../lib/hooks", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipe(...args),
}));

// Controllable reduce-motion state (G-15.1) — the screen deep-imports the
// hook, so the deep module path is mocked. Default false preserves the
// animated-path behavior for every pre-existing test.
const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

// expo-router mocks.
const mockRouterBack = jest.fn();
const mockRouterPush = jest.fn();
const mockUseLocalSearchParams = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockUseLocalSearchParams(),
  useRouter: () => ({ back: mockRouterBack, push: mockRouterPush }),
}));

// Haptics mock.
const mockHapticTap = jest.fn();
const mockHapticSuccess = jest.fn();
jest.mock("../../../lib/haptics/haptics", () => ({
  hapticTap: () => mockHapticTap(),
  hapticSuccess: () => mockHapticSuccess(),
}));

// expo-keep-awake is a no-op in the test environment.
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

// react-native-gesture-handler: GestureDetector renders children directly.
// Swipe behavior is exercised via the same handleNext/handlePrev code paths
// tested by button navigation. RNGH jest-utils closure-capture issues make
// fireGestureHandler unreliable for multi-render scenarios.
const mockGestureDetectorChildren = jest.fn();
jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return {
    Gesture: {
      Pan: () => ({
        activeOffsetX: function () { return this; },
        failOffsetY: function () { return this; },
        runOnJS: function () { return this; },
        onEnd: function (cb: unknown) { mockGestureDetectorChildren(cb); return this; },
        withTestId: function () { return this; },
      }),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      View ? <View>{children}</View> : children,
  };
});

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import CookingModeScreen from "../../../app/(app)/recipe/cook/[id]";
import type {
  IngredientResponse,
  RecipeDetailResponse,
  StepResponse,
} from "../../../lib/api/schemas";

// ---------------------------------------------------------------------------
// Factories — minimal valid objects per RecipeDetailResponse schema.
// ---------------------------------------------------------------------------

function makeStep(
  position: number,
  instruction: string,
  ingredientIds?: string[] | null,
): StepResponse {
  return {
    id: `step-${position}`,
    recipe_id: "recipe-1",
    position,
    instruction,
    // undefined = mapping unknown (legacy wire shape); null = unknown
    // (explicit); [] = authoritative empty; ids = authoritative.
    ...(ingredientIds !== undefined ? { ingredient_ids: ingredientIds } : {}),
  };
}

function makeIngredient(
  position: number,
  name: string,
  quantity: string | null = null,
  unit: string | null = null,
): IngredientResponse {
  return {
    id: `ingredient-${position}`,
    recipe_id: "recipe-1",
    position,
    quantity,
    unit,
    name,
    prep: null,
    raw_text: null,
  };
}

function makeRecipe(params: {
  steps: StepResponse[];
  ingredients?: IngredientResponse[];
  servings?: string | null;
}): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Test Recipe",
    image_storage_key: null,
    image_path: null,
    source_url: null,
    servings: params.servings ?? null,
    prep_time: null,
    cook_time: null,
    confidence_score: null,
    favorite: false,
    tags: [],
    ingredients: params.ingredients ?? [],
    steps: params.steps,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function setRecipeSuccess(recipe: RecipeDetailResponse) {
  mockUseRecipe.mockReturnValue({
    data: recipe,
    error: undefined,
    isLoading: false,
    refetch: jest.fn(),
  });
}

function setRecipeLoading() {
  mockUseRecipe.mockReturnValue({
    data: undefined,
    error: undefined,
    isLoading: true,
    refetch: jest.fn(),
  });
}

function setRecipeError(message: string) {
  mockUseRecipe.mockReturnValue({
    data: undefined,
    error: new Error(message),
    isLoading: false,
    refetch: jest.fn(),
  });
}

function setRouteParams(
  params: { id?: string; desiredServings?: string } = {},
) {
  mockUseLocalSearchParams.mockReturnValue({ id: "recipe-1", ...params });
}

/**
 * Drain all queued animation callbacks, running each inside act() so React
 * state updates (setDisplayedStep, endTransition) commit before the next
 * iteration reads the queue. The loop handles the two-phase fade (fade-out
 * callback queues the fade-in callback, which queues endTransition).
 */
function flushAllAnimations() {
  act(() => {
    while (mockTimingCallbacks.length > 0) {
      const cb = mockTimingCallbacks.shift()!;
      cb({ finished: true });
    }
  });
}

/**
 * Returns the reward beat's Modal element (SuccessBeat renders the only Modal
 * in this tree). `.props.onDismiss` is the native-dismissal callback the cook
 * flow now waits on before pushing the cook log.
 */
function getBeatModal() {
  return screen.UNSAFE_getByType(Modal as unknown as React.ComponentType);
}

/**
 * Simulate the iOS native Modal dismissal completing — the deterministic signal
 * that unblocks the cook-log handoff. Driving this (never calling the cook
 * handler directly) exercises the exact ordering the fix corrects.
 */
function driveBeatDismiss() {
  act(() => {
    getBeatModal().props.onDismiss();
  });
}

// ---------------------------------------------------------------------------
// Animated.timing spy setup.
// ---------------------------------------------------------------------------

beforeAll(() => {
  jest.spyOn(Animated, "timing").mockImplementation(
    ((value: any, config: any) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        if (
          value &&
          typeof value.setValue === "function" &&
          typeof config?.toValue === "number"
        ) {
          value.setValue(config.toValue);
        }
        if (callback) mockTimingCallbacks.push(callback);
      },
      stop: () => {},
      reset: () => {},
    })) as any,
  );
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTimingCallbacks.length = 0;
  setRouteParams(); // default: just id
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CookingModeScreen", () => {
  describe("render states", () => {
    it("renders loading state while recipe is loading", () => {
      setRecipeLoading();
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText("Loading recipe…")).toBeTruthy();
    });

    it("renders error state when recipe fails to load", () => {
      setRecipeError("Network error");
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText("Network error")).toBeTruthy();
    });

    it("renders 0-step fallback with Close as the only affordance", () => {
      setRecipeSuccess(makeRecipe({ steps: [] }));
      renderWithTheme(<CookingModeScreen />);
      expect(
        screen.getByText("No steps available for this recipe."),
      ).toBeTruthy();
      expect(screen.getByLabelText("Close cooking mode")).toBeTruthy();
      expect(screen.queryByLabelText("Previous step")).toBeNull();
      expect(screen.queryByLabelText("Next step")).toBeNull();
      expect(screen.queryByLabelText("Done cooking")).toBeNull();
    });

    it("renders single-step recipe with Done as only nav button", () => {
      setRecipeSuccess(
        makeRecipe({ steps: [makeStep(1, "Mix all ingredients")] }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText("Mix all ingredients")).toBeTruthy();
      expect(screen.getByText("Step 1 of 1")).toBeTruthy();
      expect(screen.getByLabelText("Done cooking")).toBeTruthy();
      expect(screen.queryByLabelText("Previous step")).toBeNull();
      expect(screen.queryByLabelText("Next step")).toBeNull();
    });

    it("renders multi-step recipe at step 1 with Back and Next buttons", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "First step"),
            makeStep(2, "Second step"),
            makeStep(3, "Third step"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText("First step")).toBeTruthy();
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
      expect(screen.getByLabelText("Previous step")).toBeTruthy();
      expect(screen.getByLabelText("Next step")).toBeTruthy();
      expect(screen.queryByLabelText("Done cooking")).toBeNull();
    });
  });

  describe("navigation", () => {
    function renderThreeStepRecipe() {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "First step"),
            makeStep(2, "Second step"),
            makeStep(3, "Third step"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
    }

    it("Next advances the step counter and fires hapticTap", () => {
      renderThreeStepRecipe();
      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
      expect(screen.getByText("Second step")).toBeTruthy();
      expect(screen.queryByText("First step")).toBeNull();
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
    });

    it("Back retreats the step counter and fires hapticTap", () => {
      renderThreeStepRecipe();
      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
      mockHapticTap.mockClear();

      fireEvent.press(screen.getByLabelText("Previous step"));
      flushAllAnimations();
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
      expect(screen.getByText("First step")).toBeTruthy();
      expect(mockHapticTap).toHaveBeenCalledTimes(1);
    });

    it("Back at step 1 is disabled — no haptic, no advance", () => {
      renderThreeStepRecipe();
      fireEvent.press(screen.getByLabelText("Previous step"));
      expect(mockHapticTap).not.toHaveBeenCalled();
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    });

    it("last step replaces Next with Done", () => {
      renderThreeStepRecipe();
      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      expect(screen.getByText("Step 3 of 3")).toBeTruthy();
      expect(screen.getByLabelText("Done cooking")).toBeTruthy();
      expect(screen.queryByLabelText("Next step")).toBeNull();
      expect(screen.getByLabelText("Previous step")).toBeTruthy();
    });
  });

  describe("transition lock", () => {
    it("blocks rapid double-tap on Next — only one advance and one haptic", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "First step"),
            makeStep(2, "Second step"),
            makeStep(3, "Third step"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      const nextButton = screen.getByLabelText("Next step");
      // Two presses without flushing the animation queue in between.
      // First press: canGoNext=true → beginTransition (lock engaged) →
      //   hapticTap → goNext (step=1). Effect fires, fade-out queued.
      // Second press: canGoNext reads isTransitioning=true → early return.
      //   No haptic, no advance.
      fireEvent.press(nextButton);
      fireEvent.press(nextButton);

      expect(mockHapticTap).toHaveBeenCalledTimes(1);

      // displayedStep has NOT advanced yet (fade-out callback still queued).
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();

      // Drain the animation queue: fade-out fires → setDisplayedStep(1) →
      // fade-in fires → endTransition. Only one step of advance in total.
      flushAllAnimations();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
      expect(screen.queryByText("Step 3 of 3")).toBeNull();
    });
  });

  describe("callouts", () => {
    it("renders callouts for ingredients mentioned in the current step", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "Mix flour and sugar together")],
          ingredients: [
            makeIngredient(1, "flour"),
            makeIngredient(2, "sugar"),
            makeIngredient(3, "butter"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText("flour")).toBeTruthy();
      expect(screen.getByText("sugar")).toBeTruthy();
      expect(screen.queryByText("butter")).toBeNull();
    });

    it("renders no callout row when the step matches no ingredients", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "Preheat the oven to 350 degrees")],
          ingredients: [
            makeIngredient(1, "flour"),
            makeIngredient(2, "sugar"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.queryByText("flour")).toBeNull();
      expect(screen.queryByText("sugar")).toBeNull();
    });

    it("shows ALL matched callouts with no cap and no '+N more' (D1)", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(
              1,
              "Combine flour, sugar, butter, salt, eggs, and milk in a bowl",
            ),
          ],
          ingredients: [
            makeIngredient(1, "flour"),
            makeIngredient(2, "sugar"),
            makeIngredient(3, "butter"),
            makeIngredient(4, "salt"),
            makeIngredient(5, "eggs"),
            makeIngredient(6, "milk"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      expect(screen.getByText("flour")).toBeTruthy();
      expect(screen.getByText("sugar")).toBeTruthy();
      expect(screen.getByText("butter")).toBeTruthy();
      expect(screen.getByText("salt")).toBeTruthy();
      expect(screen.getByText("eggs")).toBeTruthy();
      expect(screen.getByText("milk")).toBeTruthy();
      expect(screen.queryByText(/\+\d+ more/)).toBeNull();
    });

    it("updates callouts when the step changes", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "Mix flour and sugar"),
            makeStep(2, "Add butter and eggs"),
          ],
          ingredients: [
            makeIngredient(1, "flour"),
            makeIngredient(2, "sugar"),
            makeIngredient(3, "butter"),
            makeIngredient(4, "eggs"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      expect(screen.getByText("flour")).toBeTruthy();
      expect(screen.getByText("sugar")).toBeTruthy();
      expect(screen.queryByText("butter")).toBeNull();
      expect(screen.queryByText("eggs")).toBeNull();

      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();

      expect(screen.getByText("butter")).toBeTruthy();
      expect(screen.getByText("eggs")).toBeTruthy();
      expect(screen.queryByText("flour")).toBeNull();
      expect(screen.queryByText("sugar")).toBeNull();
    });
  });

  describe("progress indicator", () => {
    it("renders dots for a recipe with 3 steps", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "Step one"),
            makeStep(2, "Step two"),
            makeStep(3, "Step three"),
          ],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByTestId("progress-dots")).toBeTruthy();
      expect(screen.queryByTestId("progress-bar")).toBeNull();
    });

    it("renders a bar for a recipe with 10 steps", () => {
      const steps = Array.from({ length: 10 }, (_, i) =>
        makeStep(i + 1, `Step ${i + 1}`),
      );
      setRecipeSuccess(makeRecipe({ steps }));
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByTestId("progress-bar")).toBeTruthy();
      expect(screen.queryByTestId("progress-dots")).toBeNull();
    });

    it("is not rendered for a single-step recipe", () => {
      setRecipeSuccess(
        makeRecipe({ steps: [makeStep(1, "Only step")] }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.queryByTestId("progress-dots")).toBeNull();
      expect(screen.queryByTestId("progress-bar")).toBeNull();
    });
  });

  describe("scaling", () => {
    it("scales callout quantities when desiredServings doubles the base", () => {
      setRouteParams({ id: "recipe-1", desiredServings: "8" });
      setRecipeSuccess(
        makeRecipe({
          servings: "4",
          steps: [makeStep(1, "Mix the flour")],
          ingredients: [makeIngredient(1, "flour", "2", "cups")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      // base=4, desired=8 → factor 2 → 2 cups * 2 = 4 cups
      expect(screen.getByText(/4 cups? flour/)).toBeTruthy();
    });

    it("renders unscaled when desiredServings is invalid", () => {
      setRouteParams({ id: "recipe-1", desiredServings: "nonsense" });
      setRecipeSuccess(
        makeRecipe({
          servings: "4",
          steps: [makeStep(1, "Mix the flour")],
          ingredients: [makeIngredient(1, "flour", "2", "cups")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText(/2 cups? flour/)).toBeTruthy();
    });

    it("renders unscaled when desiredServings is absent", () => {
      setRouteParams({ id: "recipe-1" });
      setRecipeSuccess(
        makeRecipe({
          servings: "4",
          steps: [makeStep(1, "Mix the flour")],
          ingredients: [makeIngredient(1, "flour", "2", "cups")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      expect(screen.getByText(/2 cups? flour/)).toBeTruthy();
    });
  });

  describe("Done behavior — completion beat (15.2.3-C)", () => {
    afterEach(() => {
      mockUseReducedMotion.mockImplementation(() => false);
    });

    it("Done on a single-step recipe shows the reward beat and defers navigation", () => {
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));

      // Beat shown; navigation deferred; the beat owns the single success
      // haptic (fired once on mount); no tap haptic.
      expect(screen.getByText("Nicely done")).toBeTruthy();
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
      expect(mockHapticTap).not.toHaveBeenCalled();
    });

    it("beat completion trigger alone does not navigate — the push waits for native dismissal", () => {
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      fireEvent.press(screen.getByTestId("success-beat"));

      // Completion fired, but SuccessBeat defers onComplete to onDismiss — the
      // cook-log push must NOT have happened yet (this is the corrected race).
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it("tapping the beat then dismissing navigates to the cook log with no scale param when unscaled", () => {
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      fireEvent.press(screen.getByTestId("success-beat"));
      expect(mockRouterPush).not.toHaveBeenCalled();
      driveBeatDismiss();

      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      const arg = mockRouterPush.mock.calls[0][0];
      expect(arg.pathname).toBe("/recipe/cook-log/[id]");
      expect(arg.params).toEqual({ id: "recipe-1", from: "cooking" });
      expect(arg.params.scale).toBeUndefined();
    });

    it("navigates without a scale param when desiredServings is invalid (renders unscaled)", () => {
      setRouteParams({ id: "recipe-1", desiredServings: "nonsense" });
      setRecipeSuccess(
        makeRecipe({ servings: "4", steps: [makeStep(1, "Only step")] }),
      );
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      fireEvent.press(screen.getByTestId("success-beat"));
      driveBeatDismiss();

      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      const arg = mockRouterPush.mock.calls[0][0];
      expect(arg.params).toEqual({ id: "recipe-1", from: "cooking" });
      expect(arg.params.scale).toBeUndefined();
    });

    it("multi-step last step: Done → beat → dismiss → navigate with the exact scale param when scaled", () => {
      setRouteParams({ id: "recipe-1", desiredServings: "8" });
      setRecipeSuccess(
        makeRecipe({
          servings: "4",
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      mockHapticTap.mockClear();

      fireEvent.press(screen.getByLabelText("Done cooking"));
      expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
      expect(mockHapticTap).not.toHaveBeenCalled();

      fireEvent.press(screen.getByTestId("success-beat"));
      expect(mockRouterPush).not.toHaveBeenCalled();
      driveBeatDismiss();
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockRouterPush.mock.calls[0][0].params).toEqual({
        id: "recipe-1",
        from: "cooking",
        scale: "8 servings",
      });
    });

    it("repeated Done presses create exactly one beat and one success haptic", () => {
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      fireEvent.press(screen.getByLabelText("Done cooking"));

      expect(screen.getAllByText("Nicely done")).toHaveLength(1);
      expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    });

    it("repeated completion triggers and repeated dismissal callbacks navigate exactly once", () => {
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      // Multiple completion triggers before dismissal. The first (tap) hides the
      // beat Modal — unmounting its pressable child under the jest preset — so
      // the repeat trigger goes through the still-reachable onRequestClose;
      // completedRef makes every attempt after the first inert.
      fireEvent.press(screen.getByTestId("success-beat"));
      act(() => {
        getBeatModal().props.onRequestClose();
      });
      expect(mockRouterPush).not.toHaveBeenCalled();

      // Capture the dismissal callback once (the beat unmounts after the first
      // handoff, so re-querying would fail) and fire it twice.
      const onDismiss = getBeatModal().props.onDismiss;
      act(() => {
        onDismiss();
      });
      act(() => {
        onDismiss();
      });

      expect(mockRouterPush).toHaveBeenCalledTimes(1);
    });

    it("keeps navigation locked from beat through dismissal (completion phase stays non-idle)", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Next step"));
      flushAllAnimations();
      fireEvent.press(screen.getByLabelText("Done cooking")); // → beat
      mockHapticTap.mockClear();

      // During the beat, Back is inert (phase !== "idle").
      fireEvent.press(screen.getByLabelText("Previous step"));
      expect(mockHapticTap).not.toHaveBeenCalled();
      expect(screen.getByText("Step 2 of 2")).toBeTruthy();

      // Trigger completion; still no navigation, and Back is still inert while
      // the dismissal is in flight (phase remains "beat", then "handoff").
      fireEvent.press(screen.getByTestId("success-beat"));
      fireEvent.press(screen.getByLabelText("Previous step"));
      expect(mockHapticTap).not.toHaveBeenCalled();
      expect(mockRouterPush).not.toHaveBeenCalled();

      // Native dismissal completes → handoff + push.
      driveBeatDismiss();
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
    });

    it("Done during the final crossfade is blocked until the step settles", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      // Advance to the last step but DO NOT flush the crossfade: nav.step is
      // last (Done renders) while displayedStep still trails → Done no-ops.
      fireEvent.press(screen.getByLabelText("Next step"));
      fireEvent.press(screen.getByLabelText("Done cooking"));
      expect(screen.queryByText("Nicely done")).toBeNull();
      expect(mockHapticSuccess).not.toHaveBeenCalled();

      // Once the crossfade settles, Done starts the beat.
      flushAllAnimations();
      fireEvent.press(screen.getByLabelText("Done cooking"));
      expect(screen.getByText("Nicely done")).toBeTruthy();
      expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    });

    it("under reduce motion, Done still shows the beat and tap → dismiss navigates", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      setRecipeSuccess(makeRecipe({ steps: [makeStep(1, "Only step")] }));
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Done cooking"));
      expect(screen.getByText("Nicely done")).toBeTruthy();

      fireEvent.press(screen.getByTestId("success-beat"));
      expect(mockRouterPush).not.toHaveBeenCalled();
      driveBeatDismiss();
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
    });
  });

  describe("Close and mount", () => {
    it("Close button calls router.back with no haptics", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Close cooking mode"));
      expect(mockRouterBack).toHaveBeenCalledTimes(1);
      expect(mockHapticTap).not.toHaveBeenCalled();
      expect(mockHapticSuccess).not.toHaveBeenCalled();
    });

    it("does not fire any haptics on initial mount", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);

      expect(mockHapticTap).not.toHaveBeenCalled();
      expect(mockHapticSuccess).not.toHaveBeenCalled();
    });

    it("activates useKeepAwake on mount", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [makeStep(1, "First step"), makeStep(2, "Second step")],
        }),
      );
      renderWithTheme(<CookingModeScreen />);
      const { useKeepAwake } = require("expo-keep-awake");
      expect(useKeepAwake).toHaveBeenCalled();
    });
  });

  describe("swipe gesture", () => {
    it("registers a Pan gesture onEnd handler on render", () => {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "First step"),
            makeStep(2, "Second step"),
          ],
        }),
      );
      mockGestureDetectorChildren.mockClear();
      renderWithTheme(<CookingModeScreen />);
      // The Pan gesture's onEnd callback was registered during render
      expect(mockGestureDetectorChildren).toHaveBeenCalled();
      const onEndCallback = mockGestureDetectorChildren.mock.calls[0][0];
      expect(typeof onEndCallback).toBe("function");
    });
  });

  describe("reduce motion (G-15.1)", () => {
    function threeSteps() {
      setRecipeSuccess(
        makeRecipe({
          steps: [
            makeStep(1, "First step"),
            makeStep(2, "Second step"),
            makeStep(3, "Third step"),
          ],
        }),
      );
    }

    afterEach(() => {
      mockUseReducedMotion.mockImplementation(() => false);
    });

    it("advances instantly and releases the lock with zero timing calls", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      threeSteps();
      renderWithTheme(<CookingModeScreen />);

      fireEvent.press(screen.getByLabelText("Next step"));
      expect(screen.getByText("Second step")).toBeTruthy();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();
      expect(mockTimingCallbacks.length).toBe(0);

      // Lock released synchronously — a second press must work immediately.
      fireEvent.press(screen.getByLabelText("Next step"));
      expect(screen.getByText("Third step")).toBeTruthy();
      expect(screen.getByText("Step 3 of 3")).toBeTruthy();
      expect(mockTimingCallbacks.length).toBe(0);
    });

    it("cancels an in-flight crossfade when the preference flips true, without double lock release", () => {
      threeSteps();
      const view = renderWithTheme(<CookingModeScreen />);

      // Start a normal-motion transition: fade-out gets queued.
      fireEvent.press(screen.getByLabelText("Next step"));
      expect(mockTimingCallbacks.length).toBe(1);

      // Preference resolves true mid-transition.
      mockUseReducedMotion.mockImplementation(() => true);
      view.rerender(<CookingModeScreen />);

      // RM branch swapped the content and released the lock.
      expect(screen.getByText("Second step")).toBeTruthy();
      expect(screen.getByText("Step 2 of 3")).toBeTruthy();

      // The cancelled fade-out callback fires as unfinished — it must not
      // re-apply state or queue the fade-in (no double endTransition path).
      const stale = mockTimingCallbacks.shift()!;
      act(() => {
        stale({ finished: false });
      });
      expect(screen.getByText("Second step")).toBeTruthy();
      expect(mockTimingCallbacks.length).toBe(0);

      // Lock is free exactly once: the next press advances normally.
      fireEvent.press(screen.getByLabelText("Next step"));
      expect(screen.getByText("Third step")).toBeTruthy();
    });

    it("repeat under reduce motion keeps opacity at 1 with no timing", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      threeSteps();
      renderWithTheme(<CookingModeScreen />);

      // Rapid double advance then confirm still stable (no stuck lock).
      fireEvent.press(screen.getByLabelText("Next step"));
      fireEvent.press(screen.getByLabelText("Next step"));
      expect(screen.getByText("Step 3 of 3")).toBeTruthy();
      expect(mockTimingCallbacks.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue 1: authoritative step mapping, formatting semantics, and the
// All Ingredients sheet (D2).
// ---------------------------------------------------------------------------

describe("CookingModeScreen step mapping (Issue 1)", () => {
  it("renders authoritative mapped ingredients regardless of wording", () => {
    // Step text never mentions the ingredient names: only the persisted
    // mapping can produce these pills (the matcher would find nothing).
    setRecipeSuccess(
      makeRecipe({
        steps: [
          makeStep(1, "Combine the dry ingredients in a bowl", [
            "ingredient-1",
            "ingredient-2",
          ]),
        ],
        ingredients: [
          makeIngredient(1, "all-purpose flour", "2", "cups"),
          makeIngredient(2, "baking soda", "1", "tsp"),
          makeIngredient(3, "butter"),
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.getByText("2 cups all-purpose flour")).toBeTruthy();
    expect(screen.getByText("1 teaspoon baking soda")).toBeTruthy();
    expect(screen.queryByText(/butter/)).toBeNull();
  });

  it("authoritative empty renders no pills and never falls back to matching", () => {
    // The instruction literally names both ingredients; an authoritative
    // empty mapping still shows nothing (the matcher must not run).
    setRecipeSuccess(
      makeRecipe({
        steps: [makeStep(1, "Mix flour and sugar together", [])],
        ingredients: [
          makeIngredient(1, "flour"),
          makeIngredient(2, "sugar"),
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.queryByText("flour")).toBeNull();
    expect(screen.queryByText("sugar")).toBeNull();
  });

  it("null mapping falls back to the strict text matcher", () => {
    setRecipeSuccess(
      makeRecipe({
        steps: [makeStep(1, "Mix flour and sugar together", null)],
        ingredients: [
          makeIngredient(1, "flour"),
          makeIngredient(2, "sugar"),
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.getByText("flour")).toBeTruthy();
    expect(screen.getByText("sugar")).toBeTruthy();
  });

  it("renders mapped pills in the server-provided canonical order", () => {
    setRecipeSuccess(
      makeRecipe({
        steps: [
          makeStep(1, "Do the thing", ["ingredient-1", "ingredient-3"]),
        ],
        ingredients: [
          makeIngredient(1, "flour"),
          makeIngredient(2, "sugar"),
          makeIngredient(3, "butter"),
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.getByText("flour")).toBeTruthy();
    expect(screen.getByText("butter")).toBeTruthy();
    expect(screen.queryByText("sugar")).toBeNull();
  });

  it("a dangling mapped id degrades the WHOLE step to the matcher fallback", () => {
    // Authority is all-or-nothing: [validId, danglingId] must not render
    // the resolvable subset as if it were the step's complete truth. The
    // instruction here mentions butter but not flour, so matcher fallback
    // is observable: butter appears, flour does not.
    setRecipeSuccess(
      makeRecipe({
        steps: [
          makeStep(1, "Melt the butter", ["ingredient-1", "ingredient-999"]),
        ],
        ingredients: [
          makeIngredient(1, "flour"),
          makeIngredient(2, "butter"),
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.getByText("butter")).toBeTruthy();
    expect(screen.queryByText("flour")).toBeNull();
  });

  it("renders prep and qualifier annotations in mapped pills", () => {
    setRecipeSuccess(
      makeRecipe({
        steps: [makeStep(1, "Add everything", ["ingredient-1", "ingredient-2"])],
        ingredients: [
          {
            id: "ingredient-1",
            recipe_id: "recipe-1",
            position: 1,
            quantity: "2",
            unit: "cups",
            name: "flour",
            prep: "sifted",
            raw_text: null,
          },
          {
            id: "ingredient-2",
            recipe_id: "recipe-1",
            position: 2,
            quantity: "to taste",
            unit: null,
            name: "salt",
            prep: null,
            raw_text: "salt to taste",
          },
        ],
      }),
    );
    renderWithTheme(<CookingModeScreen />);
    expect(screen.getByText("2 cups flour, sifted")).toBeTruthy();
    expect(screen.getByText("salt (to taste)")).toBeTruthy();
  });
});

describe("CookingModeScreen All Ingredients sheet (D2)", () => {
  const twoStepRecipe = () =>
    makeRecipe({
      steps: [
        makeStep(1, "Preheat the oven", []),
        makeStep(2, "Mix it all", ["ingredient-1", "ingredient-2"]),
      ],
      ingredients: [
        makeIngredient(1, "flour", "2", "cups"),
        makeIngredient(2, "sugar", "1", "cup"),
        makeIngredient(3, "butter"),
      ],
    });

  it("opens with the complete ingredient list and closes back to the same step", () => {
    setRecipeSuccess(twoStepRecipe());
    renderWithTheme(<CookingModeScreen />);

    // Move to step 2 first, then open the sheet.
    fireEvent.press(screen.getByLabelText("Next step"));
    flushAllAnimations();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("All ingredients"));
    expect(screen.getByText("Ingredients")).toBeTruthy();
    // Complete list: includes the ingredient no step callout shows. The
    // mapped step pills stay mounted underneath, so mapped ingredients
    // appear twice (pill + sheet row).
    expect(screen.getByText("butter")).toBeTruthy();
    expect(screen.getAllByText("2 cups flour")).toHaveLength(2);
    expect(screen.getAllByText("1 cup sugar")).toHaveLength(2);
    // The step content underneath is untouched.
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Close ingredients"));
    expect(screen.queryByText("Ingredients")).toBeNull();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
  });

  it("is not rendered in the 0-step fallback", () => {
    setRecipeSuccess(makeRecipe({ steps: [] }));
    renderWithTheme(<CookingModeScreen />);
    expect(screen.queryByLabelText("All ingredients")).toBeNull();
  });
});
