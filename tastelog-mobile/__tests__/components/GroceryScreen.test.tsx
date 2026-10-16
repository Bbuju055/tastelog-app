import React from "react";
import { act, screen, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { Alert, Animated } from "react-native";
import { lightPalette } from "../../theme/palettes";

const mockToggleItem = jest.fn();
const mockRefetch = jest.fn().mockResolvedValue(undefined);

const mockDeleteMutate = jest.fn();
const mockDeleteItemMutate = jest.fn();
const mockCreateMutate = jest.fn();
const mockRenameMutate = jest.fn();
const mockAddItemMutate = jest.fn();
const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
}));

jest.mock("../../lib/hooks", () => ({
  useGrocery: jest.fn(),
  useDeleteGroceryList: jest.fn(() => ({
    mutate: mockDeleteMutate,
    isPending: false,
  })),
  useDeleteGroceryItem: jest.fn(() => ({
    mutate: mockDeleteItemMutate,
    isPending: false,
  })),
  useCreateGroceryList: jest.fn(() => ({
    mutate: mockCreateMutate,
    isPending: false,
  })),
  useRenameGroceryList: jest.fn(() => ({
    mutate: mockRenameMutate,
    isPending: false,
  })),
  useAddManualItem: jest.fn(() => ({
    mutate: mockAddItemMutate,
    isPending: false,
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

jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
}));

jest.mock("../../lib/grocery/defaultListName", () => ({
  defaultListName: jest.fn(() => "March 22 list"),
}));

// Swipeable: render children directly, ignore swipe actions in unit tests
jest.mock("react-native-gesture-handler/Swipeable", () => {
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

import Reanimated from "react-native-reanimated";
import { useGrocery, useAddManualItem, useReducedMotion } from "../../lib/hooks";
import { hapticTap } from "../../lib/haptics/haptics";
import GroceryScreen from "../../app/(app)/(tabs)/grocery";

const MOCK_ITEMS = [
  {
    id: "item-1",
    list_id: "list-1",
    recipe_id: null,
    position: 1,
    quantity: "2",
    unit: "cups",
    name: "Flour",
    checked: false,
    recipe_title: null,
    source_recipes: null,
  },
  {
    id: "item-2",
    list_id: "list-1",
    recipe_id: null,
    position: 2,
    quantity: null,
    unit: null,
    name: "Salt",
    checked: true,
    recipe_title: null,
    source_recipes: null,
  },
];

const MOCK_LISTS = [
  {
    id: "list-1",
    user_id: "user-1",
    name: "Weekly Groceries",
    display_name: "Weekly Groceries",
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

function setupMock(overrides = {}) {
  (useGrocery as jest.Mock).mockReturnValue({
    lists: MOCK_LISTS,
    activeListId: "list-1",
    selectList: jest.fn(),
    activeList: { ...MOCK_LISTS[0], items: MOCK_ITEMS },
    items: MOCK_ITEMS,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    toggleItem: mockToggleItem,
    toggleError: null,
    ...overrides,
  });
}

describe("GroceryScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders empty state when no lists", () => {
    setupMock({ lists: [], items: [], activeList: null });
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("Plan your shopping")).toBeTruthy();
    expect(screen.getByText("Create Your First List")).toBeTruthy();
  });

  test("renders list name and items", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    // Name appears in chip row + header
    expect(screen.getAllByText("Weekly Groceries").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Flour")).toBeTruthy();
    expect(screen.getByText("Salt")).toBeTruthy();
  });

  test("renders quantity/unit as secondary text", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("2 cups")).toBeTruthy();
  });

  test("calls toggleItem and hapticTap on item press", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.press(checkboxes[0]);
    expect(hapticTap).toHaveBeenCalledTimes(1);
    expect(mockToggleItem).toHaveBeenCalledWith("item-1", true);
  });

  test("toggles checked item to unchecked", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.press(checkboxes[1]);
    expect(mockToggleItem).toHaveBeenCalledWith("item-2", false);
  });
});

// ---------------------------------------------------------------------------
// Checked/unchecked separation
// ---------------------------------------------------------------------------

describe("GroceryScreen — checked/unchecked separation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("unchecked items render before checked items", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const checkboxes = screen.getAllByRole("checkbox");
    // First checkbox: Flour (unchecked) — toggling should set to true
    fireEvent.press(checkboxes[0]);
    expect(mockToggleItem).toHaveBeenCalledWith("item-1", true);
    // Second checkbox: Salt (checked) — toggling should set to false
    fireEvent.press(checkboxes[1]);
    expect(mockToggleItem).toHaveBeenCalledWith("item-2", false);
  });

  test("shows completed separator when checked items exist", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("Completed (1)")).toBeTruthy();
  });

  test("does not show separator when no checked items", () => {
    const allUnchecked = MOCK_ITEMS.map((i) => ({ ...i, checked: false }));
    setupMock({ items: allUnchecked });
    renderWithTheme(<GroceryScreen />);
    expect(screen.queryByText(/^Completed/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Progress indicator
// ---------------------------------------------------------------------------

describe("GroceryScreen — progress indicator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shows progress text with checked count", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("1 of 2 items")).toBeTruthy();
  });

  test("shows total only when none checked", () => {
    const allUnchecked = MOCK_ITEMS.map((i) => ({ ...i, checked: false }));
    setupMock({ items: allUnchecked });
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("2 items")).toBeTruthy();
  });

  test("no progress text when list is empty", () => {
    setupMock({
      activeList: { ...MOCK_LISTS[0], items: [] },
      items: [],
    });
    renderWithTheme(<GroceryScreen />);
    expect(screen.queryByText(/^\d+ (of \d+ )?items$/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chip row
// ---------------------------------------------------------------------------

describe("GroceryScreen — chip row", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("chip row visible with single list", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    // Name appears in both chip row and header
    expect(screen.getAllByText("Weekly Groceries").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("+ New")).toBeTruthy();
  });

  test("chip row shows all lists when multiple exist", () => {
    const twoLists = [
      ...MOCK_LISTS,
      { ...MOCK_LISTS[0], id: "list-2", display_name: "Weekend BBQ" },
    ];
    setupMock({ lists: twoLists });
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByText("Weekend BBQ")).toBeTruthy();
    expect(screen.getByText("+ New")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// More menu (replaces inline delete)
// ---------------------------------------------------------------------------

describe("GroceryScreen — workspace header", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shows more menu button instead of inline delete", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByTestId("grocery-more-button")).toBeTruthy();
    // Old inline delete button should not exist
    expect(screen.queryByText("Delete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manual add input
// ---------------------------------------------------------------------------

describe("GroceryScreen — manual add", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders add item input when list has items", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByTestId("grocery-add-input")).toBeTruthy();
  });

  test("renders add item input when list is empty", () => {
    setupMock({
      activeList: { ...MOCK_LISTS[0], items: [] },
      items: [],
    });
    renderWithTheme(<GroceryScreen />);
    expect(screen.getByTestId("grocery-add-input")).toBeTruthy();
  });

  test("does not render add item input when no lists exist", () => {
    setupMock({ lists: [], items: [], activeList: null, activeListId: null });
    renderWithTheme(<GroceryScreen />);
    expect(screen.queryByTestId("grocery-add-input")).toBeNull();
  });

  test("calls mutate with name and list_id on submit", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const input = screen.getByTestId("grocery-add-input");
    fireEvent.changeText(input, "Milk");
    fireEvent(input, "submitEditing");
    expect(mockAddItemMutate).toHaveBeenCalledWith(
      { name: "Milk", list_id: "list-1" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test("does not call mutate on empty input", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const input = screen.getByTestId("grocery-add-input");
    fireEvent.changeText(input, "   ");
    fireEvent(input, "submitEditing");
    expect(mockAddItemMutate).not.toHaveBeenCalled();
  });

  test("input is disabled while mutation is pending", () => {
    (useAddManualItem as jest.Mock).mockReturnValue({
      mutate: mockAddItemMutate,
      isPending: true,
    });
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const input = screen.getByTestId("grocery-add-input");
    expect(input.props.editable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty state CTAs
// ---------------------------------------------------------------------------

describe("GroceryScreen — empty state CTAs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("empty list shows tappable link to recipes tab", () => {
    setupMock({
      activeList: { ...MOCK_LISTS[0], items: [] },
      items: [],
    });
    renderWithTheme(<GroceryScreen />);
    const link = screen.getByText("browse your recipes");
    fireEvent.press(link);
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/(tabs)");
  });

  test("no-lists empty state shows updated subtitle copy", () => {
    setupMock({ lists: [], items: [], activeList: null });
    renderWithTheme(<GroceryScreen />);
    expect(
      screen.getByText("Create a list, then add ingredients from your recipes."),
    ).toBeTruthy();
  });

  // Phase 15.0.5 (L4): grocery no longer declares dark — it renders in the
  // app theme (light by default in tests). CTA label must use onPrimary.
  test("no-lists empty CTA label uses onPrimary token in the app theme", () => {
    setupMock({ lists: [], items: [], activeList: null });
    renderWithTheme(<GroceryScreen />);
    const label = screen.getByText("Create Your First List");
    const flat = Object.assign(
      {},
      ...[].concat(label.props.style).flat(Infinity).filter(Boolean),
    );
    expect(flat.color).toBe(lightPalette.onPrimary);
  });
});

// ---------------------------------------------------------------------------
// Phase 13.8 — Grocery Substitute long-press
// ---------------------------------------------------------------------------

describe("GroceryScreen — Phase 13.8 Substitute long-press", () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  test("long-press on anchored item (recipe_id) opens the Substitute alert", () => {
    setupMock({
      items: [{ ...MOCK_ITEMS[0], recipe_id: "rec-1" }],
    });
    renderWithTheme(<GroceryScreen />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent(checkboxes[0], "longPress");

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0]!;
    expect(title).toBe("Flour");
    expect(message).toBe("Find a substitute for this ingredient?");
    expect(buttons).toEqual([
      expect.objectContaining({ text: "Cancel", style: "cancel" }),
      expect.objectContaining({ text: "Substitute" }),
    ]);
  });

  test("long-press on manual/unanchored item does NOT open the alert", () => {
    // Default MOCK_ITEMS[0] is recipe_id=null + source_recipes=null —
    // the affordance must not surface for items with no recipe anchor.
    setupMock();
    renderWithTheme(<GroceryScreen />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent(checkboxes[0], "longPress");

    expect(alertSpy).not.toHaveBeenCalled();
  });

  test("selecting Substitute navigates to the Riff route with the locked params", () => {
    alertSpy.mockImplementation((_title, _message, buttons) => {
      // Simulate the user tapping "Substitute" (index 1, after Cancel at 0).
      buttons?.[1]?.onPress?.();
    });
    setupMock({
      items: [{ ...MOCK_ITEMS[0], recipe_id: "rec-1" }],
    });
    renderWithTheme(<GroceryScreen />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent(checkboxes[0], "longPress");

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/riff/[id]",
      params: {
        id: "rec-1",
        entryPoint: "grocery_substitute",
        initialDraft: "What can I substitute for Flour in this recipe?",
      },
    });
  });

  test("fallback anchor uses source_recipes[0].id when recipe_id is null", () => {
    alertSpy.mockImplementation((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });
    setupMock({
      items: [
        {
          ...MOCK_ITEMS[0],
          recipe_id: null,
          source_recipes: [{ id: "rec-2", title: "Source Recipe" }],
        },
      ],
    });
    renderWithTheme(<GroceryScreen />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent(checkboxes[0], "longPress");

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/riff/[id]",
      params: {
        id: "rec-2",
        entryPoint: "grocery_substitute",
        initialDraft: "What can I substitute for Flour in this recipe?",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 15.1.3 — layout-transition wiring
// ---------------------------------------------------------------------------

describe("GroceryScreen — layout-transition wiring (15.1.3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so pin the branch explicitly —
    // a prior test's mockReturnValue(true) must not leak in.
    (useReducedMotion as jest.Mock).mockReturnValue(false);
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

  test("FlatList gets itemLayoutAnimation and list-switch guards when motion is allowed", () => {
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const list = getAnimatedFlatList();
    expect(list.props.itemLayoutAnimation).toBeDefined();
    expect(list.props.skipEnteringExitingAnimations).toBe(true);
  });

  test("itemLayoutAnimation is disabled under reduced motion", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    setupMock();
    renderWithTheme(<GroceryScreen />);
    const list = getAnimatedFlatList();
    expect(list.props.itemLayoutAnimation).toBeUndefined();
    // The list-switch guard is not motion — it stays on.
    expect(list.props.skipEnteringExitingAnimations).toBe(true);
  });
});

describe("GroceryScreen — 10.C entrance under reduce motion (G-15.1)", () => {
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
  });

  afterEach(() => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  test("mounts instantly with no timing when reduce motion is true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    setupMock();
    const timingSpy = jest.spyOn(Animated, "timing");
    renderWithTheme(<GroceryScreen />);
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    expect(screen.getByText("Flour")).toBeTruthy();
    timingSpy.mockRestore();
  });

  test("stops an active entrance fade and snaps fully visible when the preference flips true", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    setupMock();
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
    const view = renderWithTheme(<GroceryScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    (useReducedMotion as jest.Mock).mockReturnValue(true);
    view.rerender(<GroceryScreen />);

    expect(stopFn).toHaveBeenCalled();
    expect(stopAnimationSpy).toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
    stopAnimationSpy.mockRestore();
  });

  test("no retroactive entrance when the preference flips back false", () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    setupMock();
    const timingSpy = jest.spyOn(Animated, "timing");
    const view = renderWithTheme(<GroceryScreen />);
    expect(timingSpy).not.toHaveBeenCalled();

    (useReducedMotion as jest.Mock).mockReturnValue(false);
    view.rerender(<GroceryScreen />);

    // The instant RM render completed the entrance: no delayed 200ms fade.
    expect(timingSpy).not.toHaveBeenCalled();
    expect(contentOpacityValue()).toBe(1);
    timingSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Build 4 reliability correction (C2): content fade invariant + DATA TRUTH.
// Whenever grocery content is renderable, the recognizable item text is in
// the tree AND the content wrapper is fully opaque, across the isLoading
// flip (activeListId auto-select enables the detail query after mount) and
// forced re-renders (the barrel mock returns a fresh useStaggeredEntrance
// object per render, the pre-C1 kill mechanism). Opacity alone is never the
// assertion.
// ---------------------------------------------------------------------------

describe("GroceryScreen: content fade invariant + data truth (Build 4 C2)", () => {
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

  let stopFn: jest.Mock;
  let timingSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    (useAddManualItem as jest.Mock).mockReturnValue({
      mutate: mockAddItemMutate,
      isPending: false,
    });
    // The fade never progresses on its own here: the assertion is about
    // convergence after interruption, not the timing curve.
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

  test("the post-mount isLoading flip (false, true, false) converges to visible items", () => {
    setupMock();
    const view = renderWithTheme(<GroceryScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Flour")).toBeTruthy();
    const fadeTarget = contentOpacityNode();

    // Detail query enabled by list auto-select: skeleton, fade stopped.
    setupMock({ isLoading: true });
    view.rerender(<GroceryScreen />);
    expect(stopFn).toHaveBeenCalled();

    setupMock();
    view.rerender(<GroceryScreen />);

    expect(screen.getByText("Flour")).toBeTruthy();
    expect(screen.getByText("Salt")).toBeTruthy();
    expect(screen.getAllByText("Weekly Groceries").length).toBeGreaterThanOrEqual(1);
    expect(contentOpacityValue()).toBe(1);
    // The entrance is one-shot: no second fade is ever scheduled on the
    // content value (skeleton rows schedule their own shimmer timings).
    expect(
      timingSpy.mock.calls.filter(([target]) => target === fadeTarget),
    ).toHaveLength(1);
  });

  test("forced re-renders while the entrance fade is in flight converge to visible items", () => {
    setupMock();
    const view = renderWithTheme(<GroceryScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    view.rerender(<GroceryScreen />);
    view.rerender(<GroceryScreen />);
    expect(stopFn).toHaveBeenCalled();

    expect(screen.getByText("Flour")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
    expect(timingSpy).toHaveBeenCalledTimes(1);
  });

  test("a newly added item's exact text is present and fully visible after the add path", () => {
    setupMock();
    const view = renderWithTheme(<GroceryScreen />);
    expect(timingSpy).toHaveBeenCalledTimes(1);

    const input = screen.getByTestId("grocery-add-input");
    fireEvent.changeText(input, "Oat milk");
    fireEvent(input, "submitEditing");
    expect(mockAddItemMutate).toHaveBeenCalledWith(
      { name: "Oat milk", list_id: "list-1" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // Server truth after the add: the list now carries the new item.
    const added = {
      id: "item-3",
      list_id: "list-1",
      recipe_id: null,
      position: 3,
      quantity: null,
      unit: null,
      name: "Oat milk",
      checked: false,
      recipe_title: null,
      source_recipes: null,
    };
    const options = mockAddItemMutate.mock.calls[0][1] as {
      onSuccess: () => void;
    };
    act(() => {
      options.onSuccess();
    });
    setupMock({
      items: [...MOCK_ITEMS, added],
      activeList: { ...MOCK_LISTS[0], items: [...MOCK_ITEMS, added] },
    });
    view.rerender(<GroceryScreen />);

    expect(screen.getByText("Oat milk")).toBeTruthy();
    expect(screen.getByText("Flour")).toBeTruthy();
    expect(contentOpacityValue()).toBe(1);
  });
});
