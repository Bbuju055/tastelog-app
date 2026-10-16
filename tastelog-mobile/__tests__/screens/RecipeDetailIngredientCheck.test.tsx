import React from "react";
import { Animated } from "react-native";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — mirrors RecipeDetailGroceryFeedback.test.tsx
// ---------------------------------------------------------------------------

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "recipe-1" })),
  useRouter: jest.fn(() => ({ push: mockRouterPush, back: mockRouterBack })),
  // Issue 3: the detail screen hosts a <Stack.Screen options> for the
  // headerRight Edit entry. Inert host mock, the entry's own behavior is
  // covered by RecipeDetailEditEntry.test.tsx.
  Stack: { Screen: () => null },
}));

// Issue 3: the screen acquires a QueryClient for external-delete cache
// convergence; these suites render without a provider, so stub the hook.
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({
    removeQueries: jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
    getQueryData: jest.fn(),
    setQueryData: jest.fn(),
  }),
}));

const mockRecipe = {
  id: "recipe-1",
  title: "Pasta Carbonara",
  servings: "4",
  prep_time: "10 min",
  cook_time: "20 min",
  confidence_score: 0.95,
  favorite: false,
  tags: [],
  ingredients: [
    {
      id: "ing-1",
      recipe_id: "recipe-1",
      position: 1,
      quantity: "200",
      unit: "g",
      name: "spaghetti",
      prep: null,
      raw_text: "200g spaghetti",
    },
  ],
  steps: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: jest.fn(() => ({
    data: mockRecipe,
    error: null,
    isLoading: false,
    refetch: jest.fn(),
  })),
}));

jest.mock("../../lib/hooks/useDeleteRecipe", () => ({
  useDeleteRecipe: jest.fn(() => ({
    mutate: jest.fn(),
    isPending: false,
  })),
}));

jest.mock("../../lib/hooks", () => ({
  useRemakeGroceryList: jest.fn(() => ({
    mutate: jest.fn(),
    isPending: false,
  })),
  useUpdateRecipeTags: jest.fn(() => ({
    mutate: jest.fn(),
    isPending: false,
  })),
  useGroceryLists: jest.fn(() => ({
    lists: [],
    isLoading: false,
  })),
  useGroceryPicker: jest.fn(() => ({
    pickList: jest.fn(),
  })),
}));

jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: jest.fn(),
}));

// 15.1.5 — controllable reduced-motion branch (deep-path mock).
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: jest.fn(() => false),
}));

jest.mock("../../lib/ingredients/scaleIngredient", () => ({
  scaleIngredient: jest.fn((_ing: unknown, _factor: unknown) => ({
    kind: "numeric",
    scaled: { n: 200n, d: 1n },
    unit: "g",
    name: "spaghetti",
  })),
}));

jest.mock("../../lib/ingredients/formatIngredient", () => ({
  formatIngredient: jest.fn(() => ({
    main: "200 g spaghetti",
    prep: null,
    annotation: null,
    showNotScaled: false,
  })),
}));

jest.mock("../../lib/ingredients/parseServings", () => ({
  parseServings: jest.fn(() => 4),
}));

jest.mock("../../lib/ingredients", () => ({
  buildGroceryOverrideItems: jest.fn(() => undefined),
  shouldBlockScaledAdd: jest.fn(() => false),
}));

jest.mock("../../lib/ingredients/rational", () => ({
  make: jest.fn(() => ({ n: 1n, d: 1n })),
  ONE: { n: 1n, d: 1n },
}));

jest.mock("../../lib/hooks/useCookEvents", () => ({
  useCookEvents: jest.fn(() => ({ data: [], isLoading: false })),
}));

jest.mock("../../lib/hooks/useDeleteCookEvent", () => ({
  useDeleteCookEvent: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ session: { user: { id: "user-1" } } })),
}));

import { hapticTap } from "../../lib/haptics/haptics";
import { useReducedMotion } from "../../lib/hooks/useReducedMotion";
import RecipeDetailScreen from "../../app/(app)/recipe/[id]";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipeDetail — ingredient check (15.1.5)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  test("ingredient row renders unchecked with no checkmark", () => {
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.getByText("200 g spaghetti")).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
  });

  test("pressing the row checks it: checkmark appears, haptic fires", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("200 g spaghetti"));
    expect(screen.getByText("✓")).toBeTruthy();
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  test("pressing again unchecks it: checkmark disappears", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("200 g spaghetti"));
    expect(screen.getByText("✓")).toBeTruthy();
    fireEvent.press(screen.getByText("200 g spaghetti"));
    expect(screen.queryByText("✓")).toBeNull();
  });

  test("toggle wiring works identically under reduced motion", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("200 g spaghetti"));
    expect(screen.getByText("✓")).toBeTruthy();
    fireEvent.press(screen.getByText("200 g spaghetti"));
    expect(screen.queryByText("✓")).toBeNull();
  });
});

describe("RecipeDetail — 10.C entrance under reduce motion (G-15.1)", () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  test("mounts instantly with no timing when reduce motion is true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, "timing");
    renderWithTheme(<RecipeDetailScreen />);
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    expect(screen.getByText("Pasta Carbonara")).toBeTruthy();
    timingSpy.mockRestore();
  });

  test("stops an active entrance fade and snaps fully visible when the preference flips true", () => {
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
    const view = renderWithTheme(<RecipeDetailScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    (useReducedMotion as jest.Mock).mockReturnValue(true);
    view.rerender(<RecipeDetailScreen />);

    expect(stopFn).toHaveBeenCalled();
    expect(stopAnimationSpy).toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
    stopAnimationSpy.mockRestore();
  });

  test("no retroactive entrance when the preference flips back false", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, "timing");
    const view = renderWithTheme(<RecipeDetailScreen />);
    expect(timingSpy).not.toHaveBeenCalled();

    (useReducedMotion as jest.Mock).mockReturnValue(false);
    view.rerender(<RecipeDetailScreen />);

    // The instant RM render completed the entrance: no delayed 200ms fade.
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
  });
});
