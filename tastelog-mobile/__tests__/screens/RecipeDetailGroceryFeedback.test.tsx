import React from "react";
import { screen, fireEvent, act } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { Alert } from "react-native";

// ---------------------------------------------------------------------------
// Mocks
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

let mockRemakeMutate = jest.fn();
let mockRemakeIsPending = false;

const mockPickList = jest.fn((cb: (listId: string | null, wasCreated: boolean) => void) => {
  cb(null, false);
});

jest.mock("../../lib/hooks", () => ({
  useRemakeGroceryList: jest.fn(() => ({
    mutate: mockRemakeMutate,
    isPending: mockRemakeIsPending,
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
    pickList: mockPickList,
  })),
}));

jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: jest.fn(),
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

import RecipeDetailScreen from "../../app/(app)/recipe/[id]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate onSuccess callback from mutate call */
function simulateSuccess(
  listName = "Weekly Groceries",
  listId = "list-1",
  itemsAdded = 1,
  itemsMerged = 0,
) {
  const call = mockRemakeMutate.mock.calls[mockRemakeMutate.mock.calls.length - 1];
  const options = call[1] as {
    onSuccess: (data: {
      list: { name: string; display_name: string; id: string };
      items_added: number;
      items_merged: number;
    }) => void;
  };
  act(() => {
    options.onSuccess({
      list: { name: listName, display_name: listName, id: listId },
      items_added: itemsAdded,
      items_merged: itemsMerged,
    });
  });
}

/** Simulate onError callback from mutate call */
function simulateError() {
  const call = mockRemakeMutate.mock.calls[mockRemakeMutate.mock.calls.length - 1];
  const options = call[1] as { onError: () => void };
  act(() => {
    options.onError();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipeDetail — Grocery feedback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockRemakeMutate = jest.fn();
    mockRemakeIsPending = false;
    // Reset hook mocks to default state — prevents leakage between tests.
    const { useRemakeGroceryList, useGroceryPicker } = require("../../lib/hooks");
    (useRemakeGroceryList as jest.Mock).mockImplementation(() => ({
      mutate: mockRemakeMutate,
      isPending: mockRemakeIsPending,
    }));
    mockPickList.mockImplementation((cb: (listId: string | null, wasCreated: boolean) => void) => {
      cb(null, false);
    });
    (useGroceryPicker as jest.Mock).mockReturnValue({ pickList: mockPickList });
    const { shouldBlockScaledAdd } = require("../../lib/ingredients");
    (shouldBlockScaledAdd as jest.Mock).mockReturnValue(false);
    jest.spyOn(Alert, "alert");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("shows merge-aware toast on success (no merges)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("Weekly Groceries", "list-1", 5, 0);

    expect(screen.getByText("Added 5 items to Weekly Groceries")).toBeTruthy();
    expect(screen.getByText("View List")).toBeTruthy();
  });

  test("shows merge-aware toast on success (some merges)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("Weekly Groceries", "list-1", 5, 2);

    expect(screen.getByText("Added 5 items to Weekly Groceries (2 merged)")).toBeTruthy();
  });

  test("shows merge-aware toast on success (all merged)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("Weekly Groceries", "list-1", 3, 3);

    expect(
      screen.getByText("All items already in Weekly Groceries \u2014 quantities updated"),
    ).toBeTruthy();
  });

  test("toast auto-dismisses after duration", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("Weekly Groceries", "list-1", 1, 0);

    expect(screen.getByText("Added 1 item to Weekly Groceries")).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(4000);
    });
    // Advance past fade-out animation (200ms)
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(screen.queryByText("Added 1 item to Weekly Groceries")).toBeNull();
  });

  test("new toast cancels previous timer — second toast stays full duration", () => {
    renderWithTheme(<RecipeDetailScreen />);

    // First add
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("First List", "list-1", 3, 0);
    expect(screen.getByText("Added 3 items to First List")).toBeTruthy();

    // Advance 3s (past halfway of first 4s timer)
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    // Second add before first toast dismisses
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess("Second List", "list-2", 2, 1);
    expect(screen.getByText("Added 2 items to Second List (1 merged)")).toBeTruthy();
    expect(screen.queryByText("Added 3 items to First List")).toBeNull();

    // Advance 3s — first timer would have fired at 4s, but second toast restarted at 3s
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Added 2 items to Second List (1 merged)")).toBeTruthy();

    // Advance remaining 1s + 200ms fade for second toast to dismiss
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Added 2 items to Second List (1 merged)")).toBeNull();
  });

  test("shows generic error alert on failure (existing list)", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateError();

    expect(Alert.alert).toHaveBeenCalledWith(
      "Error",
      "Couldn't add to grocery list. Please try again.",
    );
  });

  test("shows context-aware error on partial failure (new list created, remake fails)", () => {
    mockPickList.mockImplementation((cb: (listId: string | null, wasCreated: boolean) => void) => {
      cb("new-list-id", true);
    });

    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateError();

    expect(Alert.alert).toHaveBeenCalledWith(
      "Error",
      "List created but items couldn't be added. Try again from Recipes.",
    );
  });

  test("pickList is called when Add to Grocery is tapped", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));

    expect(mockPickList).toHaveBeenCalledTimes(1);
    expect(mockPickList).toHaveBeenCalledWith(expect.any(Function));
  });

  test("View List navigates to grocery tab", () => {
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess();

    fireEvent.press(screen.getByText("View List"));
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/(tabs)/grocery");
  });

  test("a rapid double tap on View List pushes the grocery tab exactly once (Build 4 C3)", () => {
    // A stack child pushing the tabs route creates a duplicate stack entry
    // per push; two taps must never stack two.
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));
    simulateSuccess();

    const viewList = screen.getByText("View List");
    fireEvent.press(viewList);
    fireEvent.press(viewList);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/(tabs)/grocery");
  });

  test("guards against duplicate taps when mutation is pending", () => {
    mockRemakeIsPending = true;
    const { useRemakeGroceryList } = require("../../lib/hooks");
    (useRemakeGroceryList as jest.Mock).mockReturnValue({
      mutate: mockRemakeMutate,
      isPending: true,
    });

    renderWithTheme(<RecipeDetailScreen />);
    // 15.0.3: pending CTA is a loading Button — spinner + busy label, no text.
    fireEvent.press(screen.getByLabelText("Adding Pasta Carbonara to grocery list"));

    expect(mockRemakeMutate).not.toHaveBeenCalled();
  });

  test("scaling safety block is preserved (4.2.F regression)", () => {
    const { shouldBlockScaledAdd } = require("../../lib/ingredients");
    (shouldBlockScaledAdd as jest.Mock).mockReturnValue(true);

    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Grocery"));

    expect(Alert.alert).toHaveBeenCalledWith(
      "Scaling Error",
      "Couldn't add scaled ingredients. Please try again.",
    );
    expect(mockRemakeMutate).not.toHaveBeenCalled();
  });
});
