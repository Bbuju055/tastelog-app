import React from "react";
import { Animated } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Issue 3 (plan section 9): Cooking Mode under changing step counts.
//
// A saved-recipe edit can shrink the cached recipe's steps while the cook
// screen is mounted. These tests prove: (1) a mounted shrink clamps the
// visible step with no crash; (2) a shrink DURING an active crossfade is
// generation-guarded, the stale animation completion can neither restore
// an invalid index nor strand the transition lock; (3) shrink-to-zero
// renders the existing 0-step fallback.
//
// Harness mirrors CookingModeRiffEntry.test.tsx verbatim.
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

jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: jest.fn(),
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

jest.mock("../../lib/cooking", () => {
  const actual = jest.requireActual("../../lib/cooking");
  return {
    ...actual,
    useVoiceCommands: () => ({
      isListening: false,
      lastCommand: null,
      permissionStatus: "undetermined" as const,
      error: null,
      requestPermissions: jest.fn(),
    }),
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
  RecipeDetailResponse,
  StepResponse,
} from "../../lib/api/schemas";

function makeStep(position: number): StepResponse {
  return {
    id: `step-${position}`,
    recipe_id: "recipe-1",
    position,
    instruction: `Instruction ${position}`,
  };
}

function makeRecipe(stepCount: number): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Shrink Recipe",
    servings: null,
    prep_time: null,
    cook_time: null,
    source_url: null,
    confidence_score: null,
    favorite: false,
    tags: [],
    content_rev: 1,
    ingredients: [],
    steps: Array.from({ length: stepCount }, (_, i) => makeStep(i + 1)),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
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

function setRecipe(recipe: RecipeDetailResponse): void {
  mockUseRecipe.mockReturnValue({
    data: recipe,
    error: null,
    isLoading: false,
    refetch: jest.fn(),
  });
}

function advanceOnce(): void {
  fireEvent.press(screen.getByLabelText("Next step"));
  flushAllAnimations();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTimingCallbacks.length = 0;
  mockUseLocalSearchParams.mockReturnValue({ id: "recipe-1" });
});

describe("CookingModeStepShrink (Issue 3, plan section 9)", () => {
  it("clamps the mounted step when the cached steps shrink", () => {
    setRecipe(makeRecipe(5));
    renderWithTheme(<CookingModeScreen />);
    advanceOnce();
    advanceOnce();
    advanceOnce();
    expect(screen.getByText("Step 4 of 5")).toBeTruthy();

    setRecipe(makeRecipe(2));
    screen.rerender(<CookingModeScreen />);
    flushAllAnimations();

    // No crash; the visible step is the clamped last valid index.
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    expect(screen.getByText("Instruction 2")).toBeTruthy();
  });

  it("a shrink during an active transition supersedes the stale animation (generation guard)", () => {
    setRecipe(makeRecipe(5));
    renderWithTheme(<CookingModeScreen />);
    advanceOnce();
    advanceOnce();
    advanceOnce();
    expect(screen.getByText("Step 4 of 5")).toBeTruthy();

    // Begin a transition toward step 5 but DO NOT complete it: its
    // animation callbacks stay pending (the crossfade is mid-flight).
    fireEvent.press(screen.getByLabelText("Next step"));
    expect(mockTimingCallbacks.length).toBeGreaterThan(0);

    // The recipe shrinks under the in-flight transition.
    setRecipe(makeRecipe(2));
    screen.rerender(<CookingModeScreen />);

    // Now the stale fade-out completion fires. The generation guard must
    // discard it, it can neither restore the invalid index nor complete
    // the superseded lock handshake.
    flushAllAnimations();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    expect(screen.getByText("Instruction 2")).toBeTruthy();

    // The lock is not stranded: navigation still works from the clamped
    // position.
    fireEvent.press(screen.getByLabelText("Previous step"));
    flushAllAnimations();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  });

  it("renders the 0-step fallback when the steps shrink to zero", () => {
    setRecipe(makeRecipe(3));
    renderWithTheme(<CookingModeScreen />);
    advanceOnce();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();

    setRecipe(makeRecipe(0));
    screen.rerender(<CookingModeScreen />);
    flushAllAnimations();

    expect(
      screen.getByText("No steps available for this recipe."),
    ).toBeTruthy();
  });
});
