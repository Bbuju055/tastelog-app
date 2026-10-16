import { buildSubstituteDraft } from "../../lib/grocery/buildSubstituteDraft";
import type { GroceryItemResponse } from "../../lib/api/schemas";

function makeItem(
  overrides: Partial<GroceryItemResponse> = {},
): GroceryItemResponse {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    list_id: "00000000-0000-0000-0000-000000000002",
    recipe_id: null,
    position: 1,
    quantity: null,
    unit: null,
    name: "Flour",
    checked: false,
    recipe_title: null,
    source_recipes: null,
    ...overrides,
  };
}

describe("buildSubstituteDraft", () => {
  test("returns the literal substitute prompt for a typical name", () => {
    expect(buildSubstituteDraft(makeItem({ name: "Flour" }))).toBe(
      "What can I substitute for Flour in this recipe?",
    );
  });

  test("preserves punctuation and special characters in the name", () => {
    expect(
      buildSubstituteDraft(makeItem({ name: "Crème fraîche (full-fat)" })),
    ).toBe(
      "What can I substitute for Crème fraîche (full-fat) in this recipe?",
    );
  });

  test("does not include quantity or unit even when populated", () => {
    const out = buildSubstituteDraft(
      makeItem({ name: "Butter", quantity: "2", unit: "tbsp" }),
    );
    expect(out).toBe("What can I substitute for Butter in this recipe?");
    expect(out).not.toContain("2");
    expect(out).not.toContain("tbsp");
  });
});
