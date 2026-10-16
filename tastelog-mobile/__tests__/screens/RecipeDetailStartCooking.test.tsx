import React from "react";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the detail screen is imported.
// Pattern matches RecipeDetailGroceryFeedback.test.tsx in the same directory.
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

const mockUseRecipeFn = jest.fn();
jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipeFn(...args),
}));

jest.mock("../../lib/hooks/useDeleteRecipe", () => ({
  useDeleteRecipe: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
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

jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: jest.fn(),
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

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// NOTE: scaling helpers (parseServings, deriveScaleFactor, scaleIngredient,
// formatIngredient, ONE) are deliberately NOT mocked. These tests verify
// real scale-factor derivation (including the ONE short-circuit that
// decides whether desiredServings is included in the route param), so the
// scaling pipeline must run for real.
// ---------------------------------------------------------------------------

import RecipeDetailScreen from "../../app/(app)/recipe/[id]";
import type {
  IngredientResponse,
  RecipeDetailResponse,
  StepResponse,
} from "../../lib/api/schemas";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeStep(position: number, instruction: string): StepResponse {
  return {
    id: `step-${position}`,
    recipe_id: "recipe-1",
    position,
    instruction,
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

/**
 * Default test subject: base=4 servings, one scaleable ingredient (so the
 * scaling TextInput renders), one step (so Start Cooking is enabled).
 * Tests that need a different shape pass overrides.
 */
function makeScaleableRecipe(
  overrides: {
    steps?: StepResponse[];
    servings?: string | null;
  } = {},
): RecipeDetailResponse {
  return makeRecipe({
    servings: overrides.servings ?? "4",
    steps: overrides.steps ?? [makeStep(1, "Mix the flour")],
    ingredients: [makeIngredient(1, "flour", "2", "cups")],
  });
}

function setRecipe(recipe: RecipeDetailResponse) {
  mockUseRecipeFn.mockReturnValue({
    data: recipe,
    error: undefined,
    isLoading: false,
    refetch: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipeDetail — Start Cooking entry", () => {
  describe("button render and enablement", () => {
    it("renders the Start Cooking button when the recipe has steps", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      expect(screen.getByLabelText("Start cooking Test Recipe")).toBeTruthy();
    });

    it("does not trigger navigation when steps.length === 0 (disabled)", () => {
      setRecipe(makeScaleableRecipe({ steps: [] }));
      renderWithTheme(<RecipeDetailScreen />);
      const button = screen.getByLabelText("Start cooking Test Recipe");
      fireEvent.press(button);
      // Pressable disabled prop should block onPress; handler guard catches
      // it regardless. Verified behaviorally: no navigation call.
      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });

  describe("navigation target", () => {
    it("pushes '/recipe/cook/[id]' with no group segment", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1" },
      });
    });

    it("a rapid double tap on Start Cooking pushes exactly once (Build 4 C3)", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      const button = screen.getByLabelText("Start cooking Test Recipe");
      fireEvent.press(button);
      fireEvent.press(button);
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1" },
      });
    });
  });

  describe("desiredServings param construction", () => {
    it("omits desiredServings when the user has not scaled", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1" },
      });
    });

    it("omits desiredServings when the scaling input is invalid", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      // Scaling input's placeholder equals String(baseServings) === "4".
      const scalingInput = screen.getByPlaceholderText("4");
      fireEvent.changeText(scalingInput, "nonsense");
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1" },
      });
    });

    it("includes desiredServings when the user enters a valid non-identity value", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      const scalingInput = screen.getByPlaceholderText("4");
      fireEvent.changeText(scalingInput, "8");
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1", desiredServings: "8" },
      });
    });

    it("omits desiredServings when the user enters the base value (identity scaling)", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      const scalingInput = screen.getByPlaceholderText("4");
      // base === desired → deriveScaleFactor returns ONE → isScaled is false
      fireEvent.changeText(scalingInput, "4");
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1" },
      });
    });

    it("trims whitespace in desiredServings before passing it to the route", () => {
      setRecipe(makeScaleableRecipe());
      renderWithTheme(<RecipeDetailScreen />);
      const scalingInput = screen.getByPlaceholderText("4");
      fireEvent.changeText(scalingInput, "  8  ");
      fireEvent.press(screen.getByLabelText("Start cooking Test Recipe"));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/recipe/cook/[id]",
        params: { id: "recipe-1", desiredServings: "8" },
      });
    });
  });
});

describe("RecipeDetail — Riff entry", () => {
  it("pushes '/recipe/riff/[id]' with the recipe id when the entry row is pressed", () => {
    setRecipe(makeScaleableRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    fireEvent.press(screen.getByLabelText("Riff on Test Recipe"));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/recipe/riff/[id]",
      params: { id: "recipe-1" },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 13.6.4-FU — Saved Riff lineage badge in the header badge row
// ---------------------------------------------------------------------------

describe("RecipeDetail — Riff lineage badge", () => {
  it("renders the 'Riff' badge when parent_recipe_id is present and riff_label is absent", () => {
    setRecipe({
      ...makeScaleableRecipe(),
      parent_recipe_id: "11111111-1111-1111-1111-111111111111",
      riff_session_id: "22222222-2222-2222-2222-222222222222",
    });
    renderWithTheme(<RecipeDetailScreen />);
    // Scoped to the lineage element: the "Riff" action button also renders the
    // bare text "Riff", so assert the badge's own labelled node carries it.
    expect(screen.getByLabelText("Riff recipe").props.children).toBe("Riff");
  });

  it("renders 'Riff · {riff_label}' when riff_label is present", () => {
    setRecipe({
      ...makeScaleableRecipe(),
      parent_recipe_id: "11111111-1111-1111-1111-111111111111",
      riff_session_id: "22222222-2222-2222-2222-222222222222",
      riff_label: "Dairy-Free",
    });
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.getByLabelText("Riff recipe")).toBeTruthy();
    expect(screen.getByText("Riff · Dairy-Free")).toBeTruthy();
  });

  it("does not render the Riff badge when lineage is absent", () => {
    setRecipe(makeScaleableRecipe());
    renderWithTheme(<RecipeDetailScreen />);
    expect(screen.queryByLabelText("Riff recipe")).toBeNull();
  });
});
