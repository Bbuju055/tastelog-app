import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Issue 3, RecipeEditScreen (plan sections 4, 6.1, 7.2, 7.3, 7.5).
//
// The transport hook is mocked so tests capture the exact wire body the
// screen builds (buildOps) and drive completions manually, including
// out-of-order (stale) completions for the generation-ownership proofs.
// ---------------------------------------------------------------------------

const mockRouterBack = jest.fn();
const mockRouterNavigate = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "recipe-1" })),
  useRouter: jest.fn(() => ({
    back: mockRouterBack,
    navigate: mockRouterNavigate,
    push: jest.fn(),
  })),
}));

const mockUseRecipeFn = jest.fn();
jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipeFn(...args),
}));

type MutateCallbacks = {
  onSuccess?: (response: unknown) => void;
  onError?: (error: unknown) => void;
};
type MutateCall = {
  variables: { recipeId: string; body: Record<string, unknown> };
  callbacks: MutateCallbacks;
};
const mutateCalls: MutateCall[] = [];
const mockMutate = jest.fn(
  (variables: MutateCall["variables"], callbacks: MutateCallbacks) => {
    mutateCalls.push({ variables, callbacks });
  },
);
jest.mock("../../lib/hooks/useUpdateRecipe", () => ({
  useUpdateRecipe: () => ({ mutate: mockMutate }),
}));

const mockHapticSuccess = jest.fn();
const mockHapticWarning = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
  hapticWarning: (...args: unknown[]) => mockHapticWarning(...args),
  hapticTap: jest.fn(),
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

import RecipeEditScreen, {
  completionIsCurrent,
} from "../../app/(app)/recipe/edit/[id]";
import { ApiError } from "../../lib/errors";
import type { RecipeDetailResponse } from "../../lib/api/schemas";

const ING1 = "00000000-0000-4000-8000-0000000000a1"; // legacy raw_text row
const ING2 = "00000000-0000-4000-8000-0000000000a2";
const ING3 = "00000000-0000-4000-8000-0000000000a3";
const STEP1 = "00000000-0000-4000-8000-0000000000b1";
const STEP2 = "00000000-0000-4000-8000-0000000000b2";

function makeRecipe(
  overrides: Partial<RecipeDetailResponse> = {},
): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Carbonara",
    servings: "4",
    prep_time: "10 min",
    cook_time: null,
    source_url: null,
    confidence_score: null,
    favorite: false,
    tags: [],
    content_rev: 3,
    ingredients: [
      {
        id: ING1,
        recipe_id: "recipe-1",
        position: 1,
        quantity: "2",
        unit: "cups",
        name: "flour",
        prep: "sifted",
        raw_text: "2 cups flour, sifted",
      },
      {
        id: ING2,
        recipe_id: "recipe-1",
        position: 2,
        quantity: null,
        unit: null,
        name: "salt",
        prep: null,
        raw_text: null,
      },
      {
        id: ING3,
        recipe_id: "recipe-1",
        position: 3,
        quantity: null,
        unit: null,
        name: "pepper",
        prep: null,
        raw_text: null,
      },
    ],
    steps: [
      {
        id: STEP1,
        recipe_id: "recipe-1",
        position: 1,
        instruction: "Mix flour and salt.",
        ingredient_ids: null,
      },
      {
        id: STEP2,
        recipe_id: "recipe-1",
        position: 2,
        instruction: "Rest the dough.",
        ingredient_ids: null,
      },
    ],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const mockRefetch = jest.fn();

function setRecipe(recipe: RecipeDetailResponse) {
  mockUseRecipeFn.mockReturnValue({
    data: recipe,
    error: null,
    isLoading: false,
    refetch: mockRefetch,
  });
}

function lastBody(): Record<string, unknown> {
  const call = mutateCalls[mutateCalls.length - 1];
  return call.variables.body;
}

function pressSave() {
  fireEvent.press(screen.getByLabelText("Save recipe"));
}

function alertSpy(): jest.SpyInstance {
  return Alert.alert as unknown as jest.SpyInstance;
}

function pressAlertButton(text: string) {
  const calls = (Alert.alert as unknown as jest.Mock).mock.calls;
  const buttons = calls[calls.length - 1][2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  const button = buttons.find((b) => b.text === text);
  expect(button).toBeTruthy();
  act(() => {
    button?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mutateCalls.length = 0;
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  setRecipe(makeRecipe());
});

describe("RecipeEditScreen, seeding and pristine behavior (plan 7.5)", () => {
  it("seeds every field from the recipe", () => {
    renderWithTheme(<RecipeEditScreen />);
    expect(screen.getByLabelText("Recipe title").props.value).toBe("Carbonara");
    expect(screen.getByLabelText("Servings").props.value).toBe("4");
    expect(screen.getByLabelText("Ingredient 1 name").props.value).toBe("flour");
    expect(screen.getByLabelText("Ingredient 1 quantity").props.value).toBe("2");
    expect(screen.getByLabelText("Step 1 instruction").props.value).toBe(
      "Mix flour and salt.",
    );
  });

  it("an untouched (legacy) recipe opens clean: Cancel exits with no prompt", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.press(screen.getByLabelText("Cancel editing"));
    expect(alertSpy()).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("a pristine Save dismisses without any network call", () => {
    renderWithTheme(<RecipeEditScreen />);
    pressSave();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("editing a field back to its seeded value stays pristine", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "salt");
    pressSave();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("an added-then-left-blank row is dropped, never transmitted", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.press(screen.getByLabelText("Add ingredient"));
    pressSave();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("noncanonical stored values (whitespace padding) still open pristine", () => {
    // Rescue H2: dirtiness compares both sides on the same normalization,
    // so legacy rows with padded stored bytes never become operations.
    setRecipe(
      makeRecipe({
        title: " Carbonara ",
        servings: "  4 ",
        ingredients: [
          {
            id: ING1,
            recipe_id: "recipe-1",
            position: 1,
            quantity: " 2 ",
            unit: "cups ",
            name: " flour",
            prep: "sifted",
            raw_text: "2 cups flour, sifted",
          },
        ],
        steps: [
          {
            id: STEP1,
            recipe_id: "recipe-1",
            position: 1,
            instruction: " Mix flour and salt. ",
            ingredient_ids: null,
          },
        ],
      }),
    );
    renderWithTheme(<RecipeEditScreen />);
    pressSave();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });
});

describe("RecipeEditScreen, explicit operations (plan 6.1)", () => {
  it("a per-field edit emits the minimal update op and nothing else", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(body.expected_content_rev).toBe(3);
    expect(typeof body.mutation_id).toBe("string");
    expect(body.fields).toBeUndefined();
    expect(body.steps).toBeUndefined();
    expect(body.ingredients).toEqual({
      update: [{ id: ING2, fields: { name: "sea salt" } }],
    });
  });

  it("tri-state scalars: changed title + cleared servings, untouched keys absent", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Recipe title"), "Better Carbonara");
    fireEvent.changeText(screen.getByLabelText("Servings"), "");
    pressSave();
    expect(lastBody().fields).toEqual({
      title: "Better Carbonara",
      servings: null,
    });
  });

  it("create + delete ops carry the complete final order", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.press(screen.getByLabelText("Add ingredient"));
    fireEvent.changeText(screen.getByLabelText("Ingredient 4 name"), "basil");
    fireEvent.press(screen.getByLabelText("Remove ingredient 1"));
    pressSave();
    const ingredients = lastBody().ingredients as {
      create: Array<{ temp_id: string; name: string }>;
      delete: string[];
      order: string[];
      update?: unknown;
    };
    expect(ingredients.update).toBeUndefined();
    expect(ingredients.delete).toEqual([ING1]);
    expect(ingredients.create).toHaveLength(1);
    expect(ingredients.create[0].name).toBe("basil");
    expect(ingredients.order).toEqual([
      ING2,
      ING3,
      ingredients.create[0].temp_id,
    ]);
  });

  it("Move Down emits a pure order array; the untouched legacy row appears in NO update op", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.press(screen.getByLabelText("Move ingredient 1 down"));
    pressSave();
    const body = lastBody();
    expect(body.ingredients).toEqual({ order: [ING2, ING1, ING3] });
    expect(body.steps).toBeUndefined();
    expect(body.fields).toBeUndefined();
  });

  it("step edits and reorders emit their own section ops", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(
      screen.getByLabelText("Step 2 instruction"),
      "Rest the dough 30 minutes.",
    );
    fireEvent.press(screen.getByLabelText("Move step 1 down"));
    pressSave();
    expect(lastBody().steps).toEqual({
      update: [
        { id: STEP2, fields: { instruction: "Rest the dough 30 minutes." } },
      ],
      order: [STEP2, STEP1],
    });
  });

  it("boundary move handlers are fail-closed against direct activation (no order corruption)", () => {
    // Second-rescue M2: the disabled prop is presentation; the HANDLER is
    // the safety boundary. Direct assistive activation of an impossible
    // direction must be a complete no-op for BOTH sections.
    renderWithTheme(<RecipeEditScreen />);
    const firstIngredientUp = screen.getByLabelText("Move ingredient 1 up");
    const lastIngredientDown = screen.getByLabelText("Move ingredient 3 down");
    const firstStepUp = screen.getByLabelText("Move step 1 up");
    const lastStepDown = screen.getByLabelText("Move step 2 down");
    firstIngredientUp.props.onPress?.();
    lastIngredientDown.props.onPress?.();
    firstStepUp.props.onPress?.();
    lastStepDown.props.onPress?.();
    // Rows are unmoved: the form is still pristine, so Save dismisses
    // without emitting any operation (no order array, no network).
    expect(screen.getByLabelText("Ingredient 1 name").props.value).toBe("flour");
    expect(screen.getByLabelText("Ingredient 3 name").props.value).toBe(
      "pepper",
    );
    expect(screen.getByLabelText("Step 1 instruction").props.value).toBe(
      "Mix flour and salt.",
    );
    pressSave();
    expect(mockMutate).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("move controls are disabled at the ends with accessibility labels", () => {
    renderWithTheme(<RecipeEditScreen />);
    expect(
      screen.getByLabelText("Move ingredient 1 up").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Move ingredient 3 down").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Move ingredient 2 up").props.accessibilityState
        ?.disabled,
    ).toBe(false);
    expect(
      screen.getByLabelText("Move step 2 down").props.accessibilityState
        ?.disabled,
    ).toBe(true);
  });
});

describe("RecipeEditScreen, validation + save lock (plan 4.4)", () => {
  it("Save is disabled while the title is empty", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Recipe title"), "  ");
    const save = screen.getByLabelText("Save recipe");
    expect(save.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(save);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("Save is disabled while a surviving ingredient name is empty", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "");
    expect(
      screen.getByLabelText("Save recipe").props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("Save is disabled for a new row with content but no name", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.press(screen.getByLabelText("Add ingredient"));
    fireEvent.changeText(screen.getByLabelText("Ingredient 4 quantity"), "1");
    expect(
      screen.getByLabelText("Save recipe").props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("while saving, every control is disabled with accessibilityState and inputs are locked", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(
      screen.getByLabelText("Saving recipe").props.accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Cancel editing").props.accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Add ingredient").props.accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Remove ingredient 1").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Move step 1 down").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    const titleInput = screen.getByLabelText("Recipe title");
    expect(titleInput.props.editable).toBe(false);
    expect(titleInput.props.accessibilityState?.disabled).toBe(true);
    // Guarded change handler: keystrokes delivered past the editable
    // gate (the AT path) are complete no-ops while locked.
    fireEvent.changeText(titleInput, "smuggled title");
    expect(screen.getByLabelText("Recipe title").props.value).toBe("Carbonara");
    // AT non-activation: a second direct Save invocation is a no-op.
    fireEvent(screen.getByLabelText("Saving recipe"), "press");
    expect(mockMutate).toHaveBeenCalledTimes(1);
    // Cancel is inert while saving.
    fireEvent(screen.getByLabelText("Cancel editing"), "press");
    expect(mockRouterBack).not.toHaveBeenCalled();
  });
});

describe("RecipeEditScreen, mutation id lifecycle (plan 6.2)", () => {
  it("a retry of the SAME failed save reuses the mutation id verbatim", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    const firstId = lastBody().mutation_id;
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({ message: "offline", kind: "network" }),
      );
    });
    expect(
      screen.getByText(
        "Couldn’t save your changes. Check your connection and try again.",
      ),
    ).toBeTruthy();
    pressSave();
    expect(mutateCalls).toHaveLength(2);
    expect(lastBody().mutation_id).toBe(firstId);
  });

  it("changing the form content regenerates the mutation id", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    const firstId = lastBody().mutation_id;
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({ message: "offline", kind: "network" }),
      );
    });
    fireEvent.changeText(
      screen.getByLabelText("Ingredient 2 name"),
      "smoked salt",
    );
    pressSave();
    expect(lastBody().mutation_id).not.toBe(firstId);
  });
});

describe("RecipeEditScreen, outcome ownership (plan 4.4, 7.2)", () => {
  it("success writes the revision-safe cache, invalidates lists (never grocery), and dismisses", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    const response = makeRecipe({ content_rev: 4, title: "Server Truth" });
    mockQueryClient.getQueryData.mockReturnValue(makeRecipe({ content_rev: 3 }));
    act(() => {
      mutateCalls[0].callbacks.onSuccess?.(response);
    });
    expect(mockQueryClient.setQueryData).toHaveBeenCalledWith(
      ["recipes", "recipe-1"],
      response,
    );
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["recipes"],
    });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["recent-cooks"],
    });
    // Grocery regression: no grocery cache is ever touched by an edit.
    for (const call of mockQueryClient.invalidateQueries.mock.calls) {
      expect(String(call[0].queryKey[0])).not.toContain("grocery");
    }
    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("an older response revision never overwrites a newer cached revision", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    mockQueryClient.getQueryData.mockReturnValue(makeRecipe({ content_rev: 9 }));
    act(() => {
      mutateCalls[0].callbacks.onSuccess?.(makeRecipe({ content_rev: 4 }));
    });
    expect(mockQueryClient.setQueryData).not.toHaveBeenCalled();
    // The save itself still completed.
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("REACHABLE serialization invariant: one live save generation at a time; a later save starts only after the prior one settles", () => {
    // The product deliberately prevents two concurrently pending saves:
    // while operation A is pending, Save is locked (handler-guarded), so
    // no independently live generation B can start. A TanStack mutation
    // settles exactly once, so no transport-legal sequence can deliver a
    // stale completion at all. This test proves that reachable invariant.
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    expect(mutateCalls).toHaveLength(1);
    // Pending: further Save activations (pointer or direct AT invocation)
    // cannot start operation B.
    fireEvent(screen.getByLabelText("Saving recipe"), "press");
    screen.getByLabelText("Saving recipe").props.onPress?.();
    expect(mutateCalls).toHaveLength(1);
    // A settles; a later operation may start normally.
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({ message: "offline", kind: "network" }),
      );
    });
    fireEvent.changeText(
      screen.getByLabelText("Ingredient 2 name"),
      "smoked salt",
    );
    pressSave();
    expect(mutateCalls).toHaveLength(2);
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("DEFENSE-IN-DEPTH generation guard: a superseded generation is refused by the ownership predicate", () => {
    // No transport-legal sequence produces a stale completion (see the
    // serialization test above), so the guard is exercised directly at
    // its seam: every completion handler applies its outcome only when
    // completionIsCurrent(generation, current) holds.
    expect(completionIsCurrent(1, 1)).toBe(true);
    expect(completionIsCurrent(1, 2)).toBe(false);
    expect(completionIsCurrent(2, 1)).toBe(false);
    expect(completionIsCurrent(3, 3)).toBe(true);
  });

  it("409 shows the exact conflict copy; Keep Editing preserves the form", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({
          message: "conflict",
          kind: "http",
          status: 409,
          detail: { code: "EDIT_CONFLICT" },
        }),
      );
    });
    expect(alertSpy()).toHaveBeenCalledWith(
      "Recipe Changed",
      "This recipe changed since you opened it. Reload the latest version before saving.",
      expect.anything(),
    );
    pressAlertButton("Keep Editing");
    expect(screen.getByLabelText("Ingredient 2 name").props.value).toBe(
      "sea salt",
    );
    expect(mockRouterBack).not.toHaveBeenCalled();
  });

  it("Reload Latest explicitly reseeds the baseline and contents", async () => {
    mockRefetch.mockResolvedValue({
      data: makeRecipe({ content_rev: 5, title: "Server Title" }),
      error: null,
    });
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({
          message: "conflict",
          kind: "http",
          status: 409,
          detail: { code: "EDIT_CONFLICT" },
        }),
      );
    });
    pressAlertButton("Reload Latest");
    await act(async () => {});
    expect(screen.getByLabelText("Recipe title").props.value).toBe(
      "Server Title",
    );
    expect(screen.getByLabelText("Ingredient 2 name").props.value).toBe("salt");
    // The next save uses the reloaded baseline revision.
    fireEvent.changeText(screen.getByLabelText("Recipe title"), "Mine Again");
    pressSave();
    expect(lastBody().expected_content_rev).toBe(5);
  });

  it("the form is locked while a reload is in flight (no clobbered keystrokes)", async () => {
    // Rescue H3: a reload completion reseeds the form, so editing must be
    // frozen for its whole duration.
    let resolveRefetch: (value: unknown) => void = () => undefined;
    mockRefetch.mockReturnValue(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({
          message: "conflict",
          kind: "http",
          status: 409,
          detail: { code: "EDIT_CONFLICT" },
        }),
      );
    });
    pressAlertButton("Reload Latest");
    // Locked while reloading: inputs are frozen and guarded.
    const nameInput = screen.getByLabelText("Ingredient 2 name");
    expect(nameInput.props.editable).toBe(false);
    expect(nameInput.props.accessibilityState?.disabled).toBe(true);
    fireEvent.changeText(nameInput, "typed during reload");
    expect(screen.getByLabelText("Ingredient 2 name").props.value).toBe(
      "sea salt",
    );
    await act(async () => {
      resolveRefetch({
        data: makeRecipe({ content_rev: 5, title: "Server Title" }),
        error: null,
      });
    });
    // Reload completed: reseeded and unlocked.
    expect(screen.getByLabelText("Recipe title").props.value).toBe(
      "Server Title",
    );
    expect(screen.getByLabelText("Ingredient 2 name").props.editable).toBe(true);
  });

  it("a 404 shows the exact deleted copy; the single action purges and returns to Recipes", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({ message: "gone", kind: "http", status: 404 }),
      );
    });
    expect(alertSpy()).toHaveBeenCalledWith(
      "Recipe Deleted",
      "This recipe was deleted and can no longer be edited.",
      expect.anything(),
    );
    pressAlertButton("Back to Recipes");
    expect(mockQueryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["recipes", "recipe-1"],
    });
    expect(mockQueryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["cook-events", "recipe-1"],
    });
    expect(mockRouterNavigate).toHaveBeenCalledWith("/(app)/(tabs)");
  });

  it("a 401 shows the truthful session copy without sign-out routing", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Ingredient 2 name"), "sea salt");
    pressSave();
    act(() => {
      mutateCalls[0].callbacks.onError?.(
        new ApiError({ message: "unauthorized", kind: "http", status: 401 }),
      );
    });
    expect(
      screen.getByText("Your session has expired. Sign in again to save."),
    ).toBeTruthy();
    expect(mockRouterBack).not.toHaveBeenCalled();
    expect(mockRouterNavigate).not.toHaveBeenCalled();
  });
});

describe("RecipeEditScreen, dirty cancel (plan 4.4)", () => {
  it("a dirty Cancel asks Discard Changes?; Discard exits, Keep Editing stays", () => {
    renderWithTheme(<RecipeEditScreen />);
    fireEvent.changeText(screen.getByLabelText("Recipe title"), "Changed");
    fireEvent.press(screen.getByLabelText("Cancel editing"));
    expect(alertSpy()).toHaveBeenCalledWith(
      "Discard Changes?",
      undefined,
      expect.anything(),
    );
    pressAlertButton("Keep Editing");
    expect(mockRouterBack).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText("Cancel editing"));
    pressAlertButton("Discard");
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });
});
