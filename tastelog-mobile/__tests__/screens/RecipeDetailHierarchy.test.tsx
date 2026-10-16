import React from "react";
import { Animated, Linking } from "react-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { lightPalette } from "../../theme/palettes";
import { spacing, radius } from "../../theme";
import { hapticTap } from "../../lib/haptics/haptics";

// ---------------------------------------------------------------------------
// Phase 15.2.4 (final) — deterministic 2×2 top action grid.
//
// Two explicit rows of two flex:1 cells (Cook · Grocery / Log · Riff), above
// the title, each action rendered once. Compact visible copy (Cook/Grocery/
// Log/Riff) with context-complete accessibility labels. Cook = primary fill;
// Grocery/Log/Riff = subordinate outline tier on an accent-surface cell. The
// header badge renders below the title and only when it has content.
// Screen is theme-locked to light → assertions use lightPalette.
// ---------------------------------------------------------------------------

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockPickList = jest.fn();

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

const mockUseRecipeFn = jest.fn();
jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipeFn(...args),
}));

// Controllable so the Issue 2 delete-race test can flip isPending.
const mockDeleteRecipeMutation = { mutate: jest.fn(), isPending: false };
jest.mock("../../lib/hooks/useDeleteRecipe", () => ({
  useDeleteRecipe: jest.fn(() => mockDeleteRecipeMutation),
}));

jest.mock("../../lib/hooks", () => ({
  useRemakeGroceryList: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useUpdateRecipeTags: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useGroceryLists: jest.fn(() => ({ lists: [], isLoading: false })),
  useGroceryPicker: jest.fn(() => ({ pickList: mockPickList })),
}));

jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: jest.fn(),
}));

jest.mock("../../lib/hooks/useCookEvents", () => ({
  useCookEvents: jest.fn(() => ({ data: [], isLoading: false })),
}));

// 15.2.4-CF-RC1 — stable module-scope mutateAsync so the rapid-delete guard
// tests can count calls and drive per-mutation promise settlement (the seam
// the production guard actually relies on).
const mockDeleteCookMutateAsync = jest.fn();
jest.mock("../../lib/hooks/useDeleteCookEvent", () => ({
  useDeleteCookEvent: jest.fn(() => ({
    mutate: jest.fn(),
    mutateAsync: mockDeleteCookMutateAsync,
    isPending: false,
  })),
}));

// Swipeable: render children plus right actions inline so the swipe-delete
// Pressable is reachable without gesture simulation (wiring-test convention).
jest.mock("react-native-gesture-handler/Swipeable", () => {
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: ({
      children,
      renderRightActions,
    }: {
      children: React.ReactNode;
      renderRightActions?: (progress: unknown, dragX: unknown) => React.ReactNode;
    }) => (
      <View>
        {children}
        {renderRightActions ? renderRightActions(undefined, undefined) : null}
      </View>
    ),
  };
});

jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ session: { user: { id: "user-1" } } })),
}));

import RecipeDetailScreen from "../../app/(app)/recipe/[id]";
import { useCookEvents } from "../../lib/hooks/useCookEvents";
import type {
  CookEventResponse,
  IngredientResponse,
  RecipeDetailResponse,
  StepResponse,
} from "../../lib/api/schemas";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const TITLE = "Test Recipe";

function makeRecipe(
  overrides: {
    steps?: StepResponse[];
    ingredients?: IngredientResponse[];
    source_url?: string | null;
    tags?: string[];
    cook_time?: string | null;
    parent_recipe_id?: string | null;
  } = {},
): RecipeDetailResponse {
  const step: StepResponse = {
    id: "step-1",
    recipe_id: "recipe-1",
    position: 1,
    instruction: "Mix the flour",
  };
  const ingredient: IngredientResponse = {
    id: "ingredient-1",
    recipe_id: "recipe-1",
    position: 1,
    quantity: "2",
    unit: "cups",
    name: "flour",
    prep: null,
    raw_text: null,
  };
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: TITLE,
    image_storage_key: null,
    image_path: null,
    source_url:
      overrides.source_url === undefined
        ? "https://example.com/recipes/pancakes"
        : overrides.source_url,
    servings: "4",
    prep_time: null,
    cook_time: overrides.cook_time ?? null,
    confidence_score: null,
    favorite: false,
    tags: overrides.tags ?? [],
    ingredients: overrides.ingredients ?? [ingredient],
    steps: overrides.steps ?? [step],
    parent_recipe_id: overrides.parent_recipe_id ?? null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function setRecipe(recipe: RecipeDetailResponse) {
  mockUseRecipeFn.mockReturnValue({
    data: recipe,
    error: undefined,
    isLoading: false,
    refetch: jest.fn(),
  });
}

const LABEL = {
  cook: `Start cooking ${TITLE}`,
  grocery: `Add ${TITLE} to grocery list`,
  log: `Log ${TITLE} as made`,
  riff: `Riff on ${TITLE}`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

function pressableStyleFor(label: string): Record<string, unknown> {
  return flattenStyle(screen.getByLabelText(label).props.style);
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as { children?: unknown } | null;
  if (n && n.children != null) return textOf(n.children);
  return "";
}

function preorder(node: unknown, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((c) => preorder(c, out));
    return out;
  }
  const n = node as any;
  out.push(n);
  if (n.children != null) preorder(n.children, out);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteRecipeMutation.isPending = false;
  setRecipe(makeRecipe());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipeDetail — deterministic 2×2 action grid (15.2.4 final)", () => {
  it("renders two explicit action rows, each with two cells when Grocery is available", () => {
    renderWithTheme(<RecipeDetailScreen />);
    const row0 = screen.getByTestId("recipe-action-row-0");
    const row1 = screen.getByTestId("recipe-action-row-1");
    expect(within(row0).getAllByRole("button")).toHaveLength(2);
    expect(within(row1).getAllByRole("button")).toHaveLength(2);
  });

  it("renders each action exactly once with the exact compact visible copy", () => {
    renderWithTheme(<RecipeDetailScreen />);
    for (const visible of ["Cook", "Grocery", "Log", "Riff"]) {
      expect(screen.getAllByText(visible)).toHaveLength(1);
    }
    for (const label of Object.values(LABEL)) {
      expect(screen.getAllByLabelText(label)).toHaveLength(1);
    }
    // Old verbose copy is gone.
    expect(screen.queryByText("Start Cooking")).toBeNull();
    expect(screen.queryByText("Add to Grocery List")).toBeNull();
    expect(screen.queryByText("I Made This")).toBeNull();
    expect(screen.queryByText("Riff on this")).toBeNull();
  });

  it("gives all four actions the same sizing contract (padding + radius)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    for (const label of Object.values(LABEL)) {
      const style = pressableStyleFor(label);
      expect(style.padding).toBe(spacing.base);
      expect(style.borderRadius).toBe(radius.md);
    }
  });

  it("keeps Cook the filled primary and the rest a shared outline tier", () => {
    renderWithTheme(<RecipeDetailScreen />);
    expect(pressableStyleFor(LABEL.cook).backgroundColor).toBe(
      lightPalette.primary,
    );
    for (const label of [LABEL.grocery, LABEL.log, LABEL.riff]) {
      const style = pressableStyleFor(label);
      expect(style.backgroundColor).toBe("transparent");
      expect(style.borderWidth).toBe(1);
      expect(style.borderColor).toBe(lightPalette.accent);
    }
  });

  it("reflows to Cook·Log / Riff (no blank cell) when the recipe has no ingredients", () => {
    setRecipe(makeRecipe({ ingredients: [] }));
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.queryByLabelText(LABEL.grocery)).toBeNull();
    expect(
      within(screen.getByTestId("recipe-action-row-0")).getAllByRole("button"),
    ).toHaveLength(2);
    expect(
      within(screen.getByTestId("recipe-action-row-1")).getAllByRole("button"),
    ).toHaveLength(1);
  });

  it("keeps Cook disabled (no navigation) for a zero-step recipe", () => {
    setRecipe(makeRecipe({ steps: [] }));
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.cook));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("preserves each action's route/mutation behavior", () => {
    // Build 4 (C3): ONE guard owns every push on this screen, so each push
    // is exercised on its own mount (a second push on the same mount is the
    // cross-action double navigation the guard exists to exclude).
    const cook = renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.cook));
    expect(mockRouterPush).toHaveBeenLastCalledWith({
      pathname: "/recipe/cook/[id]",
      params: { id: "recipe-1" },
    });
    fireEvent.press(screen.getByLabelText(LABEL.grocery));
    expect(mockPickList).toHaveBeenCalledTimes(1);
    cook.unmount();

    const log = renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.log));
    expect(mockRouterPush).toHaveBeenLastCalledWith({
      pathname: "/recipe/cook-log/[id]",
      params: { id: "recipe-1", from: "detail" },
    });
    log.unmount();

    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.riff));
    expect(mockRouterPush).toHaveBeenLastCalledWith({
      pathname: "/recipe/riff/[id]",
      params: { id: "recipe-1" },
    });
    expect(mockRouterPush).toHaveBeenCalledTimes(3);
  });

  it("a rapid double tap on Log yields exactly one push (Build 4 C3)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.log));
    fireEvent.press(screen.getByLabelText(LABEL.log));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/cook-log/[id]",
      params: { id: "recipe-1", from: "detail" },
    });
  });

  it("one guard owns every push: Cook then Log navigates exactly once (Build 4 C3)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.cook));
    fireEvent.press(screen.getByLabelText(LABEL.log));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush.mock.calls[0][0].pathname).toBe("/recipe/cook/[id]");
  });

  it("fires exactly one tap haptic when Riff is pressed", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.riff));
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  it("a rapid double tap on Riff yields exactly one push AND exactly one haptic (Issue 2 C5/C3)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText(LABEL.riff));
    fireEvent.press(screen.getByLabelText(LABEL.riff));
    const riffPushes = mockRouterPush.mock.calls.filter(
      (c) => c[0]?.pathname === "/recipe/riff/[id]",
    );
    expect(riffPushes).toHaveLength(1);
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  it("disables Riff (no navigation, announced disabled) while a recipe deletion is in flight (Issue 2)", () => {
    mockDeleteRecipeMutation.isPending = true;
    renderWithTheme(<RecipeDetailScreen />);
    const riff = screen.getByLabelText(LABEL.riff);
    expect(riff.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(riff);
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(hapticTap).not.toHaveBeenCalled();
  });

  it("renders no header badge element when there is no badge content", () => {
    setRecipe(makeRecipe({ tags: [], cook_time: null, parent_recipe_id: null }));
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.queryByTestId("recipe-header-badge")).toBeNull();
  });

  it("renders a meaningful badge below (after) the recipe title", () => {
    setRecipe(makeRecipe({ tags: ["dinner"] }));
    const { toJSON } = renderWithTheme(<RecipeDetailScreen />);
    const badge = screen.getByTestId("recipe-header-badge");
    expect(badge).toBeTruthy();
    const nodes = preorder(toJSON());
    const titleIdx = nodes.findIndex(
      (n) => n?.type === "Text" && textOf(n.children) === TITLE,
    );
    const badgeIdx = nodes.findIndex(
      (n) => n?.props?.testID === "recipe-header-badge",
    );
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeGreaterThan(titleIdx);
  });

  it("keeps one source affordance (callout removed) that opens the URL", () => {
    const openURL = jest
      .spyOn(Linking, "openURL")
      .mockResolvedValue(undefined as never);
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.queryByText("Source")).toBeNull();
    const links = screen.getAllByText(/example\.com/);
    expect(links).toHaveLength(1);
    fireEvent.press(links[0]);
    expect(openURL).toHaveBeenCalledWith("https://example.com/recipes/pancakes");
    openURL.mockRestore();
  });

  it("keeps keyboardShouldPersistTaps=handled on the scroll view", () => {
    renderWithTheme(<RecipeDetailScreen />);
    expect(
      screen.getByTestId("recipe-detail-scroll").props.keyboardShouldPersistTaps,
    ).toBe("handled");
  });
});

// ---------------------------------------------------------------------------
// 15.2.4-CF-RC1 — cook-history rapid-delete guard
// ---------------------------------------------------------------------------

const COOK_EVENTS: CookEventResponse[] = [
  {
    id: "cook-1",
    recipe_id: "recipe-1",
    user_id: "user-1",
    cooked_at: "2026-07-10T18:00:00Z",
    rating: 4,
    notes: null,
    scale: null,
    created_at: "2026-07-10T18:00:00Z",
  },
  {
    id: "cook-2",
    recipe_id: "recipe-1",
    user_id: "user-1",
    cooked_at: "2026-07-08T18:00:00Z",
    rating: null,
    notes: null,
    scale: null,
    created_at: "2026-07-08T18:00:00Z",
  },
];

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RecipeDetail — cook-history rapid-delete guard (15.2.4-CF-RC1)", () => {
  beforeEach(() => {
    (useCookEvents as jest.Mock).mockReturnValue({
      data: COOK_EVENTS,
      isLoading: false,
    });
    // Default: mutations stay pending unless a test settles them.
    mockDeleteCookMutateAsync.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    (useCookEvents as jest.Mock).mockImplementation(() => ({
      data: [],
      isLoading: false,
    }));
  });

  function deleteButtons() {
    // Exact-match "Delete" — the bottom button renders "Delete Recipe".
    return screen.getAllByText("Delete");
  }

  it("issues exactly one mutation for two rapid deletes of the same event", () => {
    renderWithTheme(<RecipeDetailScreen />);
    const [firstDelete] = deleteButtons();
    fireEvent.press(firstDelete);
    fireEvent.press(firstDelete);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledWith({
      cookEventId: "cook-1",
      recipeId: "recipe-1",
    });
    // The suppressed second tap also fires no extra haptic.
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  it("still deletes separate event IDs independently", () => {
    renderWithTheme(<RecipeDetailScreen />);
    const buttons = deleteButtons();
    expect(buttons).toHaveLength(2);
    fireEvent.press(buttons[0]);
    fireEvent.press(buttons[1]);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockDeleteCookMutateAsync).toHaveBeenNthCalledWith(1, {
      cookEventId: "cook-1",
      recipeId: "recipe-1",
    });
    expect(mockDeleteCookMutateAsync).toHaveBeenNthCalledWith(2, {
      cookEventId: "cook-2",
      recipeId: "recipe-1",
    });
  });

  it("clears the guard on settlement so the same event ID can be retried", async () => {
    const first = deferred();
    mockDeleteCookMutateAsync.mockReturnValueOnce(first.promise);
    renderWithTheme(<RecipeDetailScreen />);
    const [firstDelete] = deleteButtons();
    fireEvent.press(firstDelete);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(1);

    // Settle the first mutation (e.g. server error → row still present).
    await act(async () => {
      first.reject(new Error("boom"));
      await Promise.resolve();
    });

    fireEvent.press(firstDelete);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(2);
  });

  it("a rapid double tap on a cook-history row opens the edit entry exactly once with one haptic (Build 4 C3)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    const [firstRow] = screen.getAllByLabelText(/^Edit cook event from /);
    fireEvent.press(firstRow);
    fireEvent.press(firstRow);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/cook-log/[id]",
      params: expect.objectContaining({
        id: "recipe-1",
        from: "detail",
        editEventId: "cook-1",
      }),
    });
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });

  it("clears each ID independently when deletes overlap (observer-detach regression)", async () => {
    // Regression for the rescue-confirmed defect: with per-call mutate
    // callbacks, issuing a second mutation detaches the observer from the
    // first, its onSettled never runs, and the first row becomes permanently
    // undeletable. The mutateAsync promise seam must not leak that way.
    const first = deferred();
    const second = deferred();
    mockDeleteCookMutateAsync
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderWithTheme(<RecipeDetailScreen />);
    const buttons = deleteButtons();
    fireEvent.press(buttons[0]); // cook-1, stays in flight
    fireEvent.press(buttons[1]); // cook-2 overlaps — detaches observer in prod
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(2);

    // First deletion fails while the second is still pending — the row is
    // restored by the hook rollback and must be deletable again.
    await act(async () => {
      first.reject(new Error("boom"));
      await Promise.resolve();
    });

    fireEvent.press(buttons[0]);
    expect(mockDeleteCookMutateAsync).toHaveBeenCalledTimes(3);
    expect(mockDeleteCookMutateAsync).toHaveBeenNthCalledWith(3, {
      cookEventId: "cook-1",
      recipeId: "recipe-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Build 4 reliability correction (C2): detail content fade invariant.
// Whenever the recipe is renderable, its title is in the tree AND the
// content wrapper is fully opaque, even after the one-shot entrance fade was
// interrupted by an isLoading flip.
// ---------------------------------------------------------------------------

describe("RecipeDetail: content fade invariant (Build 4 C2)", () => {
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

  function setLoading() {
    mockUseRecipeFn.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refetch: jest.fn(),
    });
  }

  let stopFn: jest.Mock;
  let timingSpy: jest.SpyInstance;

  beforeEach(() => {
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

  it("an isLoading flip (false, true, false) after the entrance fade converges to a fully visible recipe", () => {
    setRecipe(makeRecipe());
    const view = renderWithTheme(<RecipeDetailScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(TITLE)).toBeTruthy();
    const fadeTarget = contentOpacityNode();

    setLoading();
    view.rerender(<RecipeDetailScreen />);
    expect(stopFn).toHaveBeenCalled();

    setRecipe(makeRecipe());
    view.rerender(<RecipeDetailScreen />);

    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText("Mix the flour")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
    // The entrance is one-shot: no second fade is ever scheduled on the
    // content value (skeleton rows schedule their own shimmer timings).
    expect(
      timingSpy.mock.calls.filter(([target]) => target === fadeTarget),
    ).toHaveLength(1);
  });
});
