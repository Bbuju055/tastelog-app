import React from "react";
import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// PROVIDER-S1.1 W2 — substitution-provenance note rendering (OD-4):
// the verbatim note renders as its own muted line beneath the name and
// quantity/unit lines; rows without a note render no note line.

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
  useFocusEffect: jest.fn(),
}));

const mockToggleItem = jest.fn();
const mockRefetch = jest.fn();

const LIST = {
  id: "00000000-0000-0000-0000-00000000000a",
  user_id: "00000000-0000-0000-0000-0000000000aa",
  name: "Sheet-Pan Night",
  display_name: "Sheet-Pan Night",
  completed_at: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

function makeItem(overrides: Record<string, unknown>) {
  return {
    id: "item-1",
    list_id: LIST.id,
    recipe_id: null,
    position: 1,
    quantity: "1",
    unit: "tsp",
    name: "soy sauce",
    checked: false,
    recipe_title: null,
    source_recipes: null,
    note: null,
    ...overrides,
  };
}

const mockUseGrocery = jest.fn();

jest.mock("../../lib/hooks", () => ({
  useGrocery: (...args: unknown[]) => mockUseGrocery(...args),
  useDeleteGroceryList: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDeleteGroceryItem: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useCreateGroceryList: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useRenameGroceryList: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useAddManualItem: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useStaggeredEntrance: jest.fn(() => ({
    start: jest.fn(),
    getOpacity: jest.fn(() => undefined),
  })),
  useEnteringRowKeys: jest.fn(() => new Set()),
  useReducedMotion: jest.fn(() => false),
}));

jest.mock("../../lib/apiErrorMessage", () => ({
  apiErrorMessage: jest.fn((e: Error) => e.message),
}));

jest.mock("../../lib/grocery/defaultListName", () => ({
  defaultListName: jest.fn(() => "Grocery List"),
}));

jest.mock("../../lib/grocery/buildSubstituteDraft", () => ({
  buildSubstituteDraft: jest.fn(() => "draft"),
}));

import GroceryScreen from "../../app/(app)/(tabs)/grocery";

function installGroceryState(items: ReturnType<typeof makeItem>[]) {
  mockUseGrocery.mockReturnValue({
    lists: [LIST],
    activeListId: LIST.id,
    selectList: jest.fn(),
    activeList: LIST,
    items,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    toggleItem: mockToggleItem,
  });
}

describe("GroceryItemRow — substitution-provenance note (W2 / OD-4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders the verbatim note beneath the quantity/unit line", () => {
    installGroceryState([
      makeItem({
        id: "item-labeled",
        note: "in place of fish sauce",
      }),
    ]);

    renderWithTheme(<GroceryScreen />);

    expect(screen.getByText("soy sauce")).toBeTruthy();
    // Existing quantity/unit secondary line is NOT replaced by the note.
    expect(screen.getByText("1 tsp")).toBeTruthy();
    // Verbatim note, no invented prefix.
    expect(screen.getByText("in place of fish sauce")).toBeTruthy();
    expect(screen.queryByText(/swap:/i)).toBeNull();
  });

  test("renders no note line when note is null", () => {
    installGroceryState([makeItem({ id: "item-plain", note: null })]);

    renderWithTheme(<GroceryScreen />);

    expect(screen.getByText("soy sauce")).toBeTruthy();
    expect(screen.getByText("1 tsp")).toBeTruthy();
    expect(screen.queryByText(/in place of/i)).toBeNull();
  });

  test("labeled and unlabeled same-name rows render as distinct rows", () => {
    installGroceryState([
      makeItem({
        id: "item-retained",
        quantity: "2",
        unit: "tbsp",
        note: null,
        position: 1,
      }),
      makeItem({
        id: "item-replacement",
        quantity: "1",
        unit: "tsp",
        note: "in place of fish sauce",
        position: 2,
      }),
    ]);

    renderWithTheme(<GroceryScreen />);

    expect(screen.getAllByText("soy sauce")).toHaveLength(2);
    expect(screen.getByText("2 tbsp")).toBeTruthy();
    expect(screen.getByText("1 tsp")).toBeTruthy();
    expect(screen.getAllByText("in place of fish sauce")).toHaveLength(1);
  });

  test("a checked row keeps its note line", () => {
    installGroceryState([
      makeItem({
        id: "item-checked",
        checked: true,
        note: "in place of fish sauce",
      }),
    ]);

    renderWithTheme(<GroceryScreen />);

    expect(screen.getByText("in place of fish sauce")).toBeTruthy();
  });
});
