import React from "react";
import { Animated } from "react-native";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Build 4 reliability correction (docs/build4-reliability-correction-plan.md)
// on the recipes list:
//  - C2 fade invariant: whenever list content is renderable, the content
//    wrapper converges to fully visible even if the one-shot entrance fade
//    was interrupted (isLoading flip, forced re-renders).
//  - C3 guards: recipe row / pending-draft row / Recently Cooked card are
//    double-fireable direct pushes; ONE shared guard per screen yields
//    exactly one navigation, including across actions.
//
// Mock topology mirrors RecipeListEmptyState.test.tsx + the hydrated-empty
// dismissal seam from RecentlyCookedLifecycle.test.tsx. The lib/hooks barrel
// is an object-literal mock, so useStaggeredEntrance returns a FRESH object
// on every render here: that is exactly the pre-C1 kill mechanism (a), and
// the screen-level invariant must hold regardless of the hook's identity.
// The navigation guard is deep-imported by the screen and stays REAL.
// ---------------------------------------------------------------------------

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
  useEnteringRowKeys: jest.fn(() => new Set()),
  useReducedMotion: jest.fn(() => false),
}));

jest.mock("../../lib/grocery/mergeToastMessage", () => ({
  getMergeToastMessage: jest.fn(),
}));

jest.mock("../../lib/apiErrorMessage", () => ({
  apiErrorMessage: jest.fn((e: Error) => e.message),
}));

const mockUseRecentCooks = jest.fn();
jest.mock("../../lib/hooks/useRecentCooks", () => ({
  useRecentCooks: (...args: unknown[]) => mockUseRecentCooks(...args),
}));

const mockUseDismissedRecentCooks = jest.fn();
jest.mock("../../lib/hooks/useDismissedRecentCooks", () => ({
  useDismissedRecentCooks: (...args: unknown[]) =>
    mockUseDismissedRecentCooks(...args),
}));

jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: jest.fn(),
}));

import { useDrafts, useRecipes, useReducedMotion } from "../../lib/hooks";
import RecipeListScreen from "../../app/(app)/(tabs)/index";
import type { RecentCookResponse } from "../../lib/api/schemas";

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

const MOCK_DRAFT = {
  id: "draft-1",
  user_id: "user-1",
  title: "Pending Pancakes",
  servings: null,
  prep_time: null,
  cook_time: null,
  confidence_score: 0.9,
  ingredients: [],
  steps: [],
  image_storage_keys: [],
  source_url: null,
  raw_model_json: null,
  model_version: "m",
  parser_version: "1.0",
  expires_at: "2100-01-01T00:00:00Z",
  created_at: "2026-05-12T00:00:00Z",
  updated_at: "2026-05-12T00:00:00Z",
};

const STEW_RECIPE_ID = "11111111-1111-4111-8111-111111111111";
const STEW: RecentCookResponse = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  recipe_id: STEW_RECIPE_ID,
  recipe_title: "Sunday Stew",
  cooked_at: "2026-07-14T10:00:00Z",
  rating: 4,
};

function setRecipes(isLoading: boolean) {
  (useRecipes as jest.Mock).mockReturnValue({
    data: isLoading ? null : MOCK_RECIPES,
    isLoading,
    error: null,
    refetch: mockRecipesRefetch,
  });
}

function setDrafts(drafts: unknown[]) {
  (useDrafts as jest.Mock).mockReturnValue({
    data: drafts,
    refetch: mockDraftsRefetch,
    isFetching: false,
  });
}

function setRecentCooks(data: RecentCookResponse[]) {
  mockUseRecentCooks.mockReturnValue({
    data,
    isLoading: false,
    refetch: jest.fn(),
  });
}

/** Locate the 10.C content wrapper's Animated opacity in the tree. */
function contentOpacityNode(): Animated.Value {
  const views = screen.UNSAFE_getAllByType(
    Animated.View as unknown as React.ComponentType,
  );
  for (const v of views) {
    const styles = ([] as unknown[]).concat(v.props.style ?? []).flat(Infinity);
    for (const s of styles) {
      const op = (s as { opacity?: unknown } | null)?.opacity;
      if (op instanceof Animated.Value) return op;
    }
  }
  throw new Error("content opacity Animated.Value not found");
}

function contentOpacityValue(): number {
  return (contentOpacityNode() as unknown as { __getValue: () => number }).__getValue();
}

beforeEach(() => {
  jest.clearAllMocks();
  (useReducedMotion as jest.Mock).mockReturnValue(false);
  setRecipes(false);
  setDrafts([]);
  setRecentCooks([]);
  mockUseDismissedRecentCooks.mockReturnValue({
    markers: {},
    dismissRecentCook: jest.fn(() => true),
    undoDismissRecentCook: jest.fn(),
  });
});

// ---------------------------------------------------------------------------
// C2: content fade invariant
// ---------------------------------------------------------------------------

describe("RecipeListScreen: content fade invariant (Build 4 C2)", () => {
  let stopFn: jest.Mock;
  let timingSpy: jest.SpyInstance;

  beforeEach(() => {
    // The fade never progresses on its own here: the assertion is about
    // convergence after interruption, not about the timing curve.
    stopFn = jest.fn();
    timingSpy = jest
      .spyOn(Animated, "timing")
      .mockImplementation(
        () =>
          ({
            start: jest.fn(),
            stop: stopFn,
            // Skeleton rows run Animated.loop(sequence(timing)), which
            // calls reset() on restart; the thin mock must satisfy it.
            reset: jest.fn(),
          }) as unknown as ReturnType<typeof Animated.timing>,
      );
  });

  afterEach(() => {
    timingSpy.mockRestore();
  });

  test("an isLoading flip (false, true, false) after the entrance fade converges to fully visible content", () => {
    const view = renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pasta")).toBeTruthy();
    const fadeTarget = contentOpacityNode();

    setRecipes(true);
    view.rerender(<RecipeListScreen />);
    expect(stopFn).toHaveBeenCalled();

    setRecipes(false);
    view.rerender(<RecipeListScreen />);

    // Data truth AND visibility: the rows are in the tree and the wrapper
    // is fully opaque. The entrance is never re-fired (one-shot kept).
    expect(screen.getByText("Pasta")).toBeTruthy();
    expect(screen.getByText("Soup")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
    // The entrance is one-shot: no second fade is ever scheduled on the
    // content value (skeleton rows schedule their own shimmer timings).
    expect(
      timingSpy.mock.calls.filter(([target]) => target === fadeTarget),
    ).toHaveLength(1);
  });

  test("forced re-renders while the entrance fade is in flight converge to fully visible content", () => {
    const view = renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    // Fresh useStaggeredEntrance identity per render (barrel mock) is the
    // pre-C1 kill mechanism: cleanup stops the fade on every re-render.
    view.rerender(<RecipeListScreen />);
    view.rerender(<RecipeListScreen />);
    expect(stopFn).toHaveBeenCalled();

    expect(screen.getByText("Pasta")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
    expect(timingSpy).toHaveBeenCalledTimes(1);
  });

  test("the empty-state render branch converges to fully visible as well", () => {
    (useRecipes as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
    const view = renderWithTheme(<RecipeListScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    view.rerender(<RecipeListScreen />);
    expect(stopFn).toHaveBeenCalled();
    expect(
      screen.getByText("Capture your first recipe from a photo."),
    ).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C3: double-activation guards (recipe row, draft row, Recently Cooked card)
// ---------------------------------------------------------------------------

describe("RecipeListScreen: double-activation guards (Build 4 C3)", () => {
  test("a rapid double tap on a recipe row pushes the detail route exactly once", () => {
    renderWithTheme(<RecipeListScreen />);
    const row = screen.getByText("Pasta");
    fireEvent.press(row);
    fireEvent.press(row);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/recipe/recipe-1");
  });

  test("a rapid double tap on a pending-draft row pushes the draft route exactly once", () => {
    setDrafts([MOCK_DRAFT]);
    renderWithTheme(<RecipeListScreen />);
    const row = screen.getByText("Pending Pancakes");
    fireEvent.press(row);
    fireEvent.press(row);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-1" },
    });
  });

  test("a rapid double tap on a Recently Cooked card pushes the detail route exactly once", () => {
    setRecentCooks([STEW]);
    renderWithTheme(<RecipeListScreen />);
    // Recency copy depends on the real clock; the label prefix is stable.
    const card = screen.getByLabelText(/^Open Sunday Stew, cooked /);
    fireEvent.press(card);
    fireEvent.press(card);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/(app)/recipe/${STEW_RECIPE_ID}`,
    );
  });

  test("one guard owns every push: recipe row then draft row navigates exactly once", () => {
    setDrafts([MOCK_DRAFT]);
    renderWithTheme(<RecipeListScreen />);
    fireEvent.press(screen.getByText("Pasta"));
    fireEvent.press(screen.getByText("Pending Pancakes"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/recipe/recipe-1");
  });

  test("the two rows still navigate independently across separate mounts", () => {
    const first = renderWithTheme(<RecipeListScreen />);
    fireEvent.press(screen.getByText("Pasta"));
    first.unmount();

    renderWithTheme(<RecipeListScreen />);
    fireEvent.press(screen.getByText("Soup"));
    expect(mockRouterPush).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenNthCalledWith(2, "/(app)/recipe/recipe-2");
  });
});
