import React from "react";
import { Animated } from "react-native";
import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
  useFocusEffect: jest.fn(),
}));

const mockRecipesRefetch = jest.fn();
const mockDraftsRefetch = jest.fn();

jest.mock("../../lib/hooks", () => ({
  useRecipes: jest.fn(() => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: mockRecipesRefetch,
  })),
  useDrafts: jest.fn(() => ({
    data: [],
    refetch: mockDraftsRefetch,
    isFetching: false,
  })),
  useToggleFavorite: jest.fn(() => ({ mutate: jest.fn() })),
  useRemakeGroceryList: jest.fn(() => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useGroceryLists: jest.fn(() => ({
    lists: [],
    isLoading: false,
  })),
  useGroceryPicker: jest.fn(() => ({
    pickList: jest.fn(),
  })),
  useStaggeredEntrance: jest.fn(() => ({
    start: jest.fn(),
    getOpacity: jest.fn(() => undefined),
  })),
  // 15.1.3 — layout-transition hooks. jest.fn so wiring tests can flip
  // the reduced-motion branch per test.
  useEnteringRowKeys: jest.fn(() => new Set()),
  useReducedMotion: jest.fn(() => false),
}));

jest.mock("../../lib/grocery/mergeToastMessage", () => ({
  getMergeToastMessage: jest.fn(),
}));

jest.mock("../../lib/apiErrorMessage", () => ({
  apiErrorMessage: jest.fn((e: Error) => e.message),
}));

jest.mock("../../lib/hooks/useRecentCooks", () => ({
  useRecentCooks: jest.fn(() => ({ data: [], isLoading: false })),
}));

import Reanimated from "react-native-reanimated";
import { useRecipes, useReducedMotion } from "../../lib/hooks";
import RecipeListScreen from "../../app/(app)/(tabs)/index";

describe("RecipeListScreen — empty state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shows CTA with capture message when no recipes", () => {
    renderWithTheme(<RecipeListScreen />);
    expect(
      screen.getByText("Capture your first recipe from a photo."),
    ).toBeTruthy();
    expect(screen.getByText("Capture Recipe")).toBeTruthy();
  });

  test("CTA navigates to Add tab on press", () => {
    renderWithTheme(<RecipeListScreen />);
    fireEvent.press(screen.getByText("Capture Recipe"));
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/(tabs)/add");
  });
});

// ---------------------------------------------------------------------------
// 15.1.3 — layout-transition wiring (populated list)
// ---------------------------------------------------------------------------

const MOCK_RECIPES = [
  {
    id: "recipe-1",
    title: "Pasta",
    created_at: "2026-01-01T00:00:00Z",
    tags: [],
    favorite: false,
    cook_time: null,
    prep_time: null,
    parent_recipe_id: null,
    riff_session_id: null,
    riff_label: null,
  },
  {
    id: "recipe-2",
    title: "Soup",
    created_at: "2026-01-02T00:00:00Z",
    tags: [],
    favorite: false,
    cook_time: null,
    prep_time: null,
    parent_recipe_id: null,
    riff_session_id: null,
    riff_label: null,
  },
];

describe("RecipeListScreen — layout-transition wiring (15.1.3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so pin both branches explicitly.
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    (useRecipes as jest.Mock).mockReturnValue({
      data: MOCK_RECIPES,
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
  });

  afterAll(() => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  function getAnimatedFlatList() {
    // Composite (non-host) element — UNSAFE_getByType is the only query
    // that can reach it. Cast is test-only: Reanimated.FlatList's generic
    // signature doesn't satisfy ComponentType directly.
    return screen.UNSAFE_getByType(
      Reanimated.FlatList as unknown as React.ComponentType,
    );
  }

  test("FlatList gets itemLayoutAnimation when motion is allowed", () => {
    renderWithTheme(<RecipeListScreen />);
    const list = getAnimatedFlatList();
    expect(list.props.itemLayoutAnimation).toBeDefined();
    // Recipe list never uses the grocery list-switch guard.
    expect(list.props.skipEnteringExitingAnimations).toBeUndefined();
  });

  test("itemLayoutAnimation is disabled under reduced motion", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    renderWithTheme(<RecipeListScreen />);
    const list = getAnimatedFlatList();
    expect(list.props.itemLayoutAnimation).toBeUndefined();
  });

  test("recipe rows render inside the animated list", () => {
    renderWithTheme(<RecipeListScreen />);
    expect(screen.getByText("Pasta")).toBeTruthy();
    expect(screen.getByText("Soup")).toBeTruthy();
  });
});

describe("RecipeListScreen — 10.C entrance under reduce motion (G-15.1)", () => {
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
    // Earlier describes leave useRecipes overridden via mockReturnValue
    // (which survives clearAllMocks) — pin the empty, loaded state.
    (useRecipes as jest.Mock).mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
  });

  afterEach(() => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  test("mounts instantly with no timing when reduce motion is true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, "timing");
    renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    expect(
      screen.getByText("Capture your first recipe from a photo."),
    ).toBeTruthy();
    timingSpy.mockRestore();
  });

  test("stops an active entrance fade and snaps fully visible when the preference flips true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
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
    const view = renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    (useReducedMotion as jest.Mock).mockReturnValue(true);
    view.rerender(<RecipeListScreen />);

    expect(stopFn).toHaveBeenCalled();
    expect(stopAnimationSpy).toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
    stopAnimationSpy.mockRestore();
  });

  test("no retroactive entrance when the preference flips back false", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    const timingSpy = jest.spyOn(Animated, "timing");
    const view = renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).not.toHaveBeenCalled();

    (useReducedMotion as jest.Mock).mockReturnValue(false);
    view.rerender(<RecipeListScreen />);

    // The instant RM render completed the entrance: no delayed 200ms fade.
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
  });
});
