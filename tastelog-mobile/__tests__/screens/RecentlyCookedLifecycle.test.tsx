import React from "react";
import {
  act,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// 15.2.4-CF-RC1 — Recently Cooked is a pure projection of cook-event data.
//
// Home wiring: single hook ownership on the screen, section fed by prop,
// pull-to-refresh reaches the recent-cooks refetch, deterministic rated /
// unrated accessibility labels, and a deleted recipe's card is gone (no
// tap target that could 404). Cache-level deletion behavior is proven in
// __tests__/hooks/useDeleteRecipeCacheCleanup.test.tsx — this suite covers
// the screen seam with stable module-scope object-literal mocks.
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

const mockRecentCooksRefetch = jest.fn();
const mockUseRecentCooks = jest.fn();
jest.mock("../../lib/hooks/useRecentCooks", () => ({
  useRecentCooks: (...args: unknown[]) => mockUseRecentCooks(...args),
}));

// Controllable seam for the dismissal hook: hydrated-empty literal for the
// projection/PTR suites, real implementation for the dismissal suite.
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

// Endpoint boundary for the integrated deletion-flow test (real hooks +
// real QueryClient run against these).
jest.mock("../../lib/api/endpoints", () => ({
  getRecentCooks: jest.fn(),
  deleteRecipe: jest.fn(),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import Reanimated from "react-native-reanimated";
import { lightPalette } from "../../theme/palettes";
import { fireEvent } from "@testing-library/react-native";
import {
  useGroceryPicker,
  useRecipes,
  useRemakeGroceryList,
} from "../../lib/hooks";
import { deleteRecipe, getRecentCooks } from "../../lib/api/endpoints";
import { useDeleteRecipe } from "../../lib/hooks/useDeleteRecipe";
import { hapticTap } from "../../lib/haptics/haptics";
import { getMergeToastMessage } from "../../lib/grocery/mergeToastMessage";
import RecipeListScreen from "../../app/(app)/(tabs)/index";
import type { RecentCookResponse } from "../../lib/api/schemas";

const { useRecentCooks: actualUseRecentCooks } = jest.requireActual(
  "../../lib/hooks/useRecentCooks",
) as typeof import("../../lib/hooks/useRecentCooks");

const { useDismissedRecentCooks: actualUseDismissedRecentCooks } =
  jest.requireActual(
    "../../lib/hooks/useDismissedRecentCooks",
  ) as typeof import("../../lib/hooks/useDismissedRecentCooks");

function setHydratedEmptyDismissals() {
  mockUseDismissedRecentCooks.mockReturnValue({
    markers: {},
    dismissRecentCook: jest.fn(() => true),
    undoDismissRecentCook: jest.fn(),
  });
}

const mockGetRecentCooks = getRecentCooks as jest.MockedFunction<
  typeof getRecentCooks
>;
const mockDeleteRecipeEndpoint = deleteRecipe as jest.MockedFunction<
  typeof deleteRecipe
>;

// Frozen clock so visible ("2h ago") and spoken ("2 hours ago") recency are
// deterministic.
const NOW = new Date("2026-07-14T12:00:00Z").getTime();
const TWO_HOURS_AGO = "2026-07-14T10:00:00Z";
const ONE_DAY_AGO = "2026-07-13T10:00:00Z";

const STEW_RECIPE_ID = "11111111-1111-4111-8111-111111111111";
const SOUP_RECIPE_ID = "22222222-2222-4222-8222-222222222222";

const STEW_NEWEST: RecentCookResponse = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  recipe_id: STEW_RECIPE_ID,
  recipe_title: "Sunday Stew",
  cooked_at: TWO_HOURS_AGO,
  rating: 4,
};

const STEW_OLDER: RecentCookResponse = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  recipe_id: STEW_RECIPE_ID,
  recipe_title: "Sunday Stew",
  cooked_at: ONE_DAY_AGO,
  rating: null,
};

const SOUP: RecentCookResponse = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  recipe_id: SOUP_RECIPE_ID,
  recipe_title: "Miso Soup",
  cooked_at: ONE_DAY_AGO,
  rating: null,
};

const STEW_LABEL_RATED =
  "Open Sunday Stew, cooked 2 hours ago, rated 4 out of 5";
const SOUP_LABEL_UNRATED = "Open Miso Soup, cooked 1 day ago";

const MOCK_RECIPES = [
  {
    id: "recipe-list-1",
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
];

function setRecentCooks(data: RecentCookResponse[]) {
  mockUseRecentCooks.mockReturnValue({
    data,
    isLoading: false,
    refetch: mockRecentCooksRefetch,
  });
}

describe("RecipeListScreen — Recently Cooked lifecycle (15.2.4-CF-RC1)", () => {
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
    (useRecipes as jest.Mock).mockReturnValue({
      data: MOCK_RECIPES,
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
    setHydratedEmptyDismissals();
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  test("no cook history hides the section entirely", () => {
    setRecentCooks([]);
    renderWithTheme(<RecipeListScreen />);
    expect(screen.queryByText("Recently Cooked")).toBeNull();
  });

  test("one cook renders one card", () => {
    setRecentCooks([STEW_NEWEST]);
    renderWithTheme(<RecipeListScreen />);
    expect(screen.getByText("Recently Cooked")).toBeTruthy();
    expect(screen.getAllByText("Sunday Stew")).toHaveLength(1);
  });

  test("deduplication keeps only the newest cook per recipe", () => {
    setRecentCooks([STEW_NEWEST, SOUP, STEW_OLDER]);
    renderWithTheme(<RecipeListScreen />);
    expect(screen.getAllByText("Sunday Stew")).toHaveLength(1);
    // The surviving stew card is the newest one (rated label, 2 hours ago).
    expect(screen.getByLabelText(STEW_LABEL_RATED)).toBeTruthy();
    expect(screen.getAllByText("Miso Soup")).toHaveLength(1);
  });

  test("deduplication selects the newest cook even when response order regresses", () => {
    // Rescue-accepted hardening: never trust backend return order.
    setRecentCooks([STEW_OLDER, SOUP, STEW_NEWEST]);
    renderWithTheme(<RecipeListScreen />);
    expect(screen.getAllByText("Sunday Stew")).toHaveLength(1);
    expect(screen.getByLabelText(STEW_LABEL_RATED)).toBeTruthy();
  });

  test("a malformed cooked_at stays visible with truthful copy, never NaN", () => {
    setRecentCooks([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
        recipe_id: "33333333-3333-4333-8333-333333333333",
        recipe_title: "Broken Pie",
        cooked_at: "not-a-date",
        rating: null,
      },
    ]);
    renderWithTheme(<RecipeListScreen />);
    expect(screen.getByText("Broken Pie")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(
      screen.getByLabelText("Open Broken Pie, cooked date unavailable"),
    ).toBeTruthy();
  });

  test("pull-to-refresh invokes the recent-cooks refetch exactly once", async () => {
    setRecentCooks([STEW_NEWEST]);
    renderWithTheme(<RecipeListScreen />);
    const list = screen.UNSAFE_getByType(
      Reanimated.FlatList as unknown as React.ComponentType,
    );
    await act(async () => {
      await (list.props as { onRefresh: () => Promise<void> }).onRefresh();
    });
    expect(mockRecentCooksRefetch).toHaveBeenCalledTimes(1);
    expect(mockRecipesRefetch).toHaveBeenCalledTimes(1);
    expect(mockDraftsRefetch).toHaveBeenCalledTimes(1);
  });

  test("cards carry the button role and deterministic rated / unrated labels", () => {
    setRecentCooks([STEW_NEWEST, SOUP]);
    renderWithTheme(<RecipeListScreen />);
    const rated = screen.getByLabelText(STEW_LABEL_RATED);
    const unrated = screen.getByLabelText(SOUP_LABEL_UNRATED);
    expect(rated.props.accessibilityRole).toBe("button");
    expect(unrated.props.accessibilityRole).toBe("button");
  });

  test("removing the final projected item hides the section", () => {
    setRecentCooks([STEW_NEWEST]);
    const view = renderWithTheme(<RecipeListScreen />);
    expect(screen.getByText("Recently Cooked")).toBeTruthy();

    setRecentCooks([]);
    view.rerender(<RecipeListScreen />);
    expect(screen.queryByText("Recently Cooked")).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Integrated deletion flow — REAL useRecentCooks + REAL useDeleteRecipe on a
// shared real QueryClient, only the endpoint boundary mocked. This test fails
// if the recipe-deletion cache repair is reverted (the stale card would
// survive on screen).
// ---------------------------------------------------------------------------

describe("RecipeListScreen — deletion flow, real recent-cooks cache (15.2.4-CF-RC1)", () => {
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
    (useRecipes as jest.Mock).mockReturnValue({
      data: MOCK_RECIPES,
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
    mockUseRecentCooks.mockImplementation(actualUseRecentCooks);
    setHydratedEmptyDismissals();
  });

  afterEach(() => {
    mockUseRecentCooks.mockReset();
    dateNowSpy.mockRestore();
  });

  test("after successful recipe deletion and return to Home, the stale card is absent and cannot be tapped into a 404", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockGetRecentCooks.mockResolvedValue([STEW_NEWEST, SOUP]);
    mockDeleteRecipeEndpoint.mockResolvedValue(undefined);

    // Keep the screen render's own query handle — the later renderHook call
    // rebinds the global `screen` helper to ITS (empty) tree, which would
    // make these assertions vacuous.
    const home = renderWithTheme(
      <QueryClientProvider client={client}>
        <RecipeListScreen />
      </QueryClientProvider>,
    );
    expect(await home.findByLabelText(STEW_LABEL_RATED)).toBeTruthy();

    // Server truth after the DB cascade: only the soup cook remains.
    mockGetRecentCooks.mockResolvedValue([SOUP]);

    const { result } = renderHook(() => useDeleteRecipe(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => {
      result.current.mutate(STEW_RECIPE_ID);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The deleted recipe's card is gone from the mounted Home screen…
    await waitFor(() =>
      expect(home.queryByLabelText(STEW_LABEL_RATED)).toBeNull(),
    );
    expect(home.queryByText("Sunday Stew")).toBeNull();
    // …so there is no tap target left that could navigate into a 404.
    expect(mockRouterPush).not.toHaveBeenCalled();
    // The surviving projection is still present and tappable.
    expect(home.getByLabelText(SOUP_LABEL_UNRATED)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Dismissal affordance (15.2.4-CF-RC1 expansion) — REAL useDismissedRecentCooks
// + real storage module over the in-memory AsyncStorage mock; recent-cooks
// data stays test-controlled via the mocked useRecentCooks seam.
// ---------------------------------------------------------------------------

const DISMISS_KEY = "tastelog_dismissed_recent_cooks_v1";
const STEW_HIDE_LABEL = "Hide Sunday Stew from Recently Cooked";
const SOUP_HIDE_LABEL = "Hide Miso Soup from Recently Cooked";

const STEW_EVEN_NEWER: RecentCookResponse = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  recipe_id: STEW_RECIPE_ID,
  recipe_title: "Sunday Stew",
  cooked_at: "2026-07-14T11:00:00Z",
  rating: null,
};

function flattenStyle(style: unknown): Record<string, unknown> {
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

describe("RecipeListScreen — Recently Cooked dismissal (15.2.4-CF-RC1 expansion)", () => {
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
    (useRecipes as jest.Mock).mockReturnValue({
      data: MOCK_RECIPES,
      isLoading: false,
      error: null,
      refetch: mockRecipesRefetch,
    });
    mockUseDismissedRecentCooks.mockImplementation(
      actualUseDismissedRecentCooks,
    );
  });

  afterEach(async () => {
    // Settle any storage writes still in the serialized queue.
    await act(async () => {});
    mockUseDismissedRecentCooks.mockReset();
    dateNowSpy.mockRestore();
  });

  async function renderHydrated(data: RecentCookResponse[]) {
    setRecentCooks(data);
    const view = renderWithTheme(<RecipeListScreen />);
    await view.findByText("Recently Cooked");
    return view;
  }

  test("renders a visible dismiss control on every card with role, label, and hint", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    expect(
      view.getAllByLabelText(/^Hide .+ from Recently Cooked$/),
    ).toHaveLength(2);
    const control = view.getByLabelText(STEW_HIDE_LABEL);
    expect(control.props.accessibilityRole).toBe("button");
    expect(control.props.accessibilityHint).toBe("Cooking history is kept.");
  });

  test("dismiss press never navigates; the card body still navigates", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    expect(mockRouterPush).not.toHaveBeenCalled();
    fireEvent.press(view.getByLabelText(SOUP_LABEL_UNRATED));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/(app)/recipe/${SOUP_RECIPE_ID}`,
    );
  });

  test("dismissal hides the card immediately and shows the Undo toast", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    expect(view.queryByText("Sunday Stew")).toBeNull();
    expect(view.getByText("Miso Soup")).toBeTruthy();
    expect(view.getByText("Hidden from Recently Cooked")).toBeTruthy();
    expect(view.getByText("Undo")).toBeTruthy();
  });

  test("Undo restores the card and replaces the actionable toast", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    fireEvent.press(view.getByText("Undo"));
    expect(await view.findByText("Sunday Stew")).toBeTruthy();
    expect(view.getByText("Restored to Recently Cooked")).toBeTruthy();
    expect(view.queryByText("Undo")).toBeNull();
    // Persisted state ends with no marker for the restored recipe.
    await act(async () => {});
    const raw = await AsyncStorage.getItem(DISMISS_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({});
  });

  test("a non-dismissal toast clears a stale Undo and Grocery keeps View List", async () => {
    (useRemakeGroceryList as jest.Mock).mockReturnValue({
      mutate: jest.fn(
        (_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) =>
          opts?.onSuccess?.({
            list: { name: "L", display_name: "March list" },
            items_added: 2,
            items_merged: 0,
          }),
      ),
      mutateAsync: jest.fn(),
      isPending: false,
    });
    (useGroceryPicker as jest.Mock).mockReturnValue({
      pickList: jest.fn((cb: (listId: null, wasCreated: boolean) => void) =>
        cb(null, false),
      ),
    });
    (getMergeToastMessage as jest.Mock).mockReturnValue("Added 2 items");

    const view = await renderHydrated([STEW_NEWEST]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    expect(view.getByText("Undo")).toBeTruthy();

    fireEvent.press(view.getAllByLabelText("Add to grocery list")[0]);
    expect(view.getByText("Added 2 items")).toBeTruthy();
    expect(view.getByText("View List")).toBeTruthy();
    expect(view.queryByText("Undo")).toBeNull();
  });

  test("rapid double-tap yields one dismissal, one haptic, one storage write", async () => {
    const setItemSpy = jest.spyOn(AsyncStorage, "setItem");
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    const control = view.getByLabelText(STEW_HIDE_LABEL);
    fireEvent.press(control);
    fireEvent.press(control);
    expect(hapticTap).toHaveBeenCalledTimes(1);
    expect(view.getAllByText("Hidden from Recently Cooked")).toHaveLength(1);
    await act(async () => {});
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  test("dismissing two cards hides both; the newest toast owns the visible Undo", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    fireEvent.press(view.getByLabelText(SOUP_HIDE_LABEL));
    expect(view.queryByText("Sunday Stew")).toBeNull();
    expect(view.queryByText("Miso Soup")).toBeNull();
    expect(view.queryByText("Recently Cooked")).toBeNull();

    // The single toast surface's Undo belongs to the latest dismissal.
    fireEvent.press(view.getByText("Undo"));
    expect(await view.findByText("Miso Soup")).toBeTruthy();
    expect(view.queryByText("Sunday Stew")).toBeNull();
  });

  test("older cook stays hidden when the dismissed newest cook is deleted", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    // Server truth changes: the dismissed newest cook is gone, the older
    // cook is now newest — the card must NOT unexpectedly reappear.
    setRecentCooks([STEW_OLDER, SOUP]);
    view.rerender(<RecipeListScreen />);
    expect(view.queryByText("Sunday Stew")).toBeNull();
    expect(view.getByText("Miso Soup")).toBeTruthy();
  });

  test("a genuinely newer cook makes the card reappear", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    expect(view.queryByText("Sunday Stew")).toBeNull();
    setRecentCooks([STEW_EVEN_NEWER, SOUP]);
    view.rerender(<RecipeListScreen />);
    expect(await view.findByText("Sunday Stew")).toBeTruthy();
  });

  test("hydration gate: a previously dismissed card never flashes on cold render", async () => {
    await AsyncStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ [STEW_RECIPE_ID]: TWO_HOURS_AGO }),
    );
    setRecentCooks([STEW_NEWEST, SOUP]);
    const view = renderWithTheme(<RecipeListScreen />);
    // Pre-hydration: the section renders nothing at all.
    expect(view.queryByText("Recently Cooked")).toBeNull();
    expect(view.queryByText("Sunday Stew")).toBeNull();
    // Post-hydration: only the non-dismissed card appears.
    expect(await view.findByText("Miso Soup")).toBeTruthy();
    expect(view.queryByText("Sunday Stew")).toBeNull();
  });

  test("dismiss control keeps its visible, fixed, 44pt-target structure", async () => {
    const view = await renderHydrated([STEW_NEWEST]);
    const control = view.getByLabelText(STEW_HIDE_LABEL);
    const controlStyle = flattenStyle(control.props.style);
    expect(controlStyle.position).toBe("absolute");
    expect(controlStyle.width).toBe(24);
    expect(controlStyle.height).toBe(24);
    // Visible button treatment, not a transparent hotspot.
    expect(controlStyle.backgroundColor).toBe(lightPalette.surface);
    expect(controlStyle.borderWidth).toBe(1);
    // Asymmetric hitSlop reaches exactly the card edges: 4+24+16 = 44pt.
    expect(control.props.hitSlop).toEqual({
      top: 4,
      right: 4,
      bottom: 16,
      left: 16,
    });
    // Icon glyph is non-scaling (the accessibility label carries meaning);
    // title clears the full 44pt touch band so scaled text wraps early.
    expect(view.getByText("✕").props.allowFontScaling).toBe(false);
    const title = view.getByText("Sunday Stew");
    expect(flattenStyle(title.props.style).paddingRight).toBe(32);
  });

  test("dismiss → Undo → dismiss again hides the card and persists the marker", async () => {
    const view = await renderHydrated([STEW_NEWEST, SOUP]);
    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    fireEvent.press(view.getByText("Undo"));
    expect(await view.findByText("Sunday Stew")).toBeTruthy();

    fireEvent.press(view.getByLabelText(STEW_HIDE_LABEL));
    expect(view.queryByText("Sunday Stew")).toBeNull();

    await act(async () => {});
    const raw = await AsyncStorage.getItem(DISMISS_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      [STEW_RECIPE_ID]: TWO_HOURS_AGO,
    });
  });
});
