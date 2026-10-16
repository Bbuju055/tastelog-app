import React from "react";
import { fireEvent, screen } from "@testing-library/react-native";
import type { ReactTestInstance } from "react-test-renderer";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Issue 3, recipe-detail Edit entry (plan section 4.1) + external-delete
// convergence (section 10).
//
// The headerRight Edit control is declared via <Stack.Screen options>; the
// Stack mock below RENDERS options.headerRight() so the real Pressable is
// in the tree. The shared useNavigationGuard stays REAL (deep import; the
// lib/hooks barrel mock never covers it), so single-navigation across
// Edit/Riff is proven against the real guard.
// ---------------------------------------------------------------------------

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockRouterNavigate = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "recipe-1" })),
  useRouter: jest.fn(() => ({
    push: mockRouterPush,
    back: mockRouterBack,
    navigate: mockRouterNavigate,
  })),
  Stack: {
    Screen: ({
      options,
    }: {
      options?: { headerRight?: () => React.ReactNode };
    }) => <>{options?.headerRight ? options.headerRight() : null}</>,
  },
}));

const mockUseRecipeFn = jest.fn();
jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipeFn(...args),
}));

const mockDeleteMutation = { mutate: jest.fn(), isPending: false };
jest.mock("../../lib/hooks/useDeleteRecipe", () => ({
  useDeleteRecipe: jest.fn(() => mockDeleteMutation),
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
  useGroceryLists: jest.fn(() => ({ lists: [], isLoading: false })),
  useGroceryPicker: jest.fn(() => ({ pickList: jest.fn() })),
}));

const mockHapticTap = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: (...args: unknown[]) => mockHapticTap(...args),
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

const mockQueryClient = {
  removeQueries: jest.fn(),
  invalidateQueries: jest.fn().mockResolvedValue(undefined),
  getQueryData: jest.fn(),
  setQueryData: jest.fn(),
};
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => mockQueryClient,
}));

import RecipeDetailScreen from "../../app/(app)/recipe/[id]";
import { ApiError } from "../../lib/errors";
import type { RecipeDetailResponse } from "../../lib/api/schemas";

function makeRecipe(
  overrides: Partial<RecipeDetailResponse> = {},
): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Carbonara",
    servings: null,
    prep_time: null,
    cook_time: null,
    source_url: null,
    confidence_score: null,
    favorite: false,
    tags: [],
    content_rev: 3,
    ingredients: [],
    steps: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function setRecipe(recipe: RecipeDetailResponse | null, error?: unknown) {
  mockUseRecipeFn.mockReturnValue({
    data: recipe,
    error: error ?? null,
    isLoading: false,
    refetch: jest.fn(),
  });
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteMutation.isPending = false;
});

describe("RecipeDetailEditEntry (Issue 3, plan section 4.1)", () => {
  it("renders the Edit entry with real 44pt minimum geometry", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    const entry = screen.getByTestId("recipe-edit-entry");
    const style = flattenStyle(entry.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(entry.props.accessibilityLabel).toBe("Edit recipe Carbonara");
  });

  it("a single tap pushes the edit route with one haptic inside the guard", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByTestId("recipe-edit-entry"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/edit/[id]",
      params: { id: "recipe-1" },
    });
    expect(mockHapticTap).toHaveBeenCalledTimes(1);
  });

  it("an Edit double-tap navigates exactly once (shared guard)", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    const entry = screen.getByTestId("recipe-edit-entry");
    fireEvent.press(entry);
    fireEvent.press(entry);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockHapticTap).toHaveBeenCalledTimes(1);
  });

  it("Edit then Riff navigates exactly once (one guard owns both pushes)", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByTestId("recipe-edit-entry"));
    fireEvent.press(screen.getByLabelText("Riff on Carbonara"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush.mock.calls[0][0].pathname).toBe("/recipe/edit/[id]");
  });

  it("Riff then Edit navigates exactly once (one guard owns both pushes)", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText("Riff on Carbonara"));
    fireEvent.press(screen.getByTestId("recipe-edit-entry"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush.mock.calls[0][0].pathname).toBe("/recipe/riff/[id]");
  });

  it("is disabled (with accessibilityState) while a delete is pending", () => {
    mockDeleteMutation.isPending = true;
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    const entry = screen.getByTestId("recipe-edit-entry");
    expect(entry.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(entry);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("the handler no-op guard blocks assistive-technology activation while locked", () => {
    setRecipe(makeRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    const entry = screen.getByTestId("recipe-edit-entry");
    fireEvent.press(entry);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    // While the guard is locked, the control reports disabled AND a direct
    // handler invocation (the AT activation path that ignores pointer
    // gating) is a complete no-op.
    expect(entry.props.accessibilityState?.disabled).toBe(true);
    (entry as ReactTestInstance).props.onPress?.();
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockHapticTap).toHaveBeenCalledTimes(1);
  });

  it("is disabled when the backend has not provided content_rev", () => {
    setRecipe(makeRecipe({ content_rev: undefined }));
    renderWithTheme(<RecipeDetailScreen />);
    const entry = screen.getByTestId("recipe-edit-entry");
    expect(entry.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(entry);
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

describe("RecipeDetail external-delete convergence (Issue 3, section 10)", () => {
  it("renders the deleted copy for a 404 instead of a generic error", () => {
    setRecipe(
      null,
      new ApiError({ message: "not found", kind: "http", status: 404 }),
    );
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.getByText("Recipe Deleted")).toBeTruthy();
    expect(
      screen.getByText("This recipe was deleted and is no longer available."),
    ).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("the single action purges caches and converges EXPLICITLY on Recipes", () => {
    // Second-rescue M3: "Back to Recipes" must not depend on navigation
    // history; a deep-link/history-independent entry lands on Recipes too.
    setRecipe(
      null,
      new ApiError({ message: "not found", kind: "http", status: 404 }),
    );
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByText("Back to Recipes"));
    expect(mockQueryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["recipes", "recipe-1"],
    });
    expect(mockQueryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["cook-events", "recipe-1"],
    });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["recipes"],
    });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["recent-cooks"],
    });
    expect(mockRouterNavigate).toHaveBeenCalledWith("/(app)/(tabs)");
    expect(mockRouterBack).not.toHaveBeenCalled();
  });

  it("non-404 errors keep the generic retryable ErrorState", () => {
    setRecipe(
      null,
      new ApiError({ message: "boom", kind: "http", status: 500 }),
    );
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.queryByText("Recipe Deleted")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
