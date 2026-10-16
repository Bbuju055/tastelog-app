import {
  buildGroceryOverrideItems,
  shouldBlockScaledAdd,
  type ScaledIngredientEntry,
} from "../../../lib/ingredients";
import { scaleIngredient } from "../../../lib/ingredients/scaleIngredient";
import { make, ONE, TWO } from "../../../lib/ingredients/rational";
import type { IngredientResponse } from "../../../lib/api/schemas";

function makeIngredient(
  overrides: Partial<IngredientResponse>,
): IngredientResponse {
  return {
    id: "test-id",
    recipe_id: "test-recipe",
    position: 1,
    quantity: null,
    unit: null,
    name: "test ingredient",
    prep: null,
    raw_text: null,
    ...overrides,
  };
}

function buildEntry(
  ingredient: IngredientResponse,
  factor: ReturnType<typeof make>,
): ScaledIngredientEntry {
  return {
    ingredient,
    result: scaleIngredient(ingredient, factor),
  };
}

describe("buildGroceryOverrideItems", () => {
  // -----------------------------------------------------------------
  // Returns undefined (base path preserved)
  // -----------------------------------------------------------------

  describe("returns undefined when scaling is inactive", () => {
    it("returns undefined when scaleFactor is null", () => {
      const ing = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
      const entries = [buildEntry(ing, ONE)];
      expect(buildGroceryOverrideItems(entries, null)).toBeUndefined();
    });

    it("returns undefined when scaleFactor is ONE", () => {
      const ing = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
      const entries = [buildEntry(ing, ONE)];
      expect(buildGroceryOverrideItems(entries, ONE)).toBeUndefined();
    });

    it("returns undefined when entries are empty", () => {
      expect(buildGroceryOverrideItems([], TWO)).toBeUndefined();
    });

    it("returns undefined when all mapped items have empty names", () => {
      const entry: ScaledIngredientEntry = {
        ingredient: makeIngredient({ name: "" }),
        result: { kind: "unscaled", reason: "unparsed" },
      };
      expect(buildGroceryOverrideItems([entry], TWO)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // Returns override items (scaled path)
  // -----------------------------------------------------------------

  describe("returns override items when scaling is active", () => {
    it("maps a numeric ingredient (e.g. 1 cup → 2 cups)", () => {
      const ing = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
      const entries = [buildEntry(ing, TWO)];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toEqual([
        { name: "flour", quantity: "2", unit: "cups", note: null },
      ]);
    });

    it("maps a container ingredient (e.g. 1 can → 3 cans)", () => {
      const factor = make(3n);
      const ing = makeIngredient({ quantity: "1", unit: "can", name: "tomatoes" });
      const entries = [buildEntry(ing, factor)];

      const items = buildGroceryOverrideItems(entries, factor);
      expect(items).toEqual([
        { name: "tomatoes", quantity: "3", unit: "cans", note: null },
      ]);
    });

    it("maps a counted ingredient (e.g. 2 eggs → 4 eggs)", () => {
      const ing = makeIngredient({ quantity: "2", unit: "eggs", name: "large" });
      const entries = [buildEntry(ing, TWO)];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toEqual([
        { name: "large", quantity: "4", unit: "eggs", note: null },
      ]);
    });

    it("maps an unscaled qualifier ingredient with original values", () => {
      const ing = makeIngredient({
        quantity: "to taste",
        unit: null,
        name: "salt",
      });
      const entries = [buildEntry(ing, TWO)];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toEqual([
        { name: "salt", quantity: "to taste", unit: null, note: null },
      ]);
    });

    it("maps an unparsed ingredient with original values", () => {
      const ing = makeIngredient({
        quantity: "some",
        unit: "fresh",
        name: "herbs",
      });
      const entries = [buildEntry(ing, TWO)];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toEqual([
        { name: "herbs", quantity: "some", unit: "fresh", note: null },
      ]);
    });
  });

  // -----------------------------------------------------------------
  // Order and mixed ingredients
  // -----------------------------------------------------------------

  describe("preserves order with mixed ingredient types", () => {
    it("returns items in the same order as entries", () => {
      const flour = makeIngredient({ quantity: "2", unit: "cups", name: "flour", position: 1 });
      const salt = makeIngredient({ quantity: "to taste", unit: null, name: "salt", position: 2 });
      const eggs = makeIngredient({ quantity: "3", unit: "eggs", name: "large", position: 3 });

      const factor = TWO;
      const entries = [
        buildEntry(flour, factor),
        buildEntry(salt, factor),
        buildEntry(eggs, factor),
      ];

      const items = buildGroceryOverrideItems(entries, factor);
      expect(items).toHaveLength(3);
      expect(items![0].name).toBe("flour");
      expect(items![1].name).toBe("salt");
      expect(items![2].name).toBe("large");
    });
  });

  // -----------------------------------------------------------------
  // Fractional scaling
  // -----------------------------------------------------------------

  describe("handles fractional scaling", () => {
    it("produces fractional quantity for non-integer result", () => {
      const ing = makeIngredient({ quantity: "1", unit: "cup", name: "sugar" });
      const factor = make(3n, 2n); // 1.5x
      const entries = [buildEntry(ing, factor)];

      const items = buildGroceryOverrideItems(entries, factor);
      expect(items).toEqual([
        { name: "sugar", quantity: "1 1/2", unit: "cups", note: null },
      ]);
    });
  });

  // -----------------------------------------------------------------
  // Defensive filtering
  // -----------------------------------------------------------------

  describe("filters invalid items", () => {
    it("filters out items with whitespace-only names", () => {
      const good = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
      const bad: ScaledIngredientEntry = {
        ingredient: { ...makeIngredient({}), name: "   " },
        result: { kind: "unscaled", reason: "unparsed" },
      };

      const items = buildGroceryOverrideItems(
        [buildEntry(good, TWO), bad],
        TWO,
      );
      expect(items).toHaveLength(1);
      expect(items![0].name).toBe("flour");
    });

    it("filters out items with empty-string names", () => {
      const good = makeIngredient({ quantity: "2", unit: "cups", name: "sugar" });
      const bad: ScaledIngredientEntry = {
        ingredient: { ...makeIngredient({}), name: "" },
        result: { kind: "unscaled", reason: "unparsed" },
      };

      const items = buildGroceryOverrideItems(
        [buildEntry(good, TWO), bad],
        TWO,
      );
      expect(items).toHaveLength(1);
      expect(items![0].name).toBe("sugar");
    });

    it("returns undefined when all items have invalid names", () => {
      const bad1: ScaledIngredientEntry = {
        ingredient: { ...makeIngredient({}), name: "" },
        result: { kind: "unscaled", reason: "unparsed" },
      };
      const bad2: ScaledIngredientEntry = {
        ingredient: { ...makeIngredient({}), name: "   " },
        result: { kind: "unscaled", reason: "unparsed" },
      };

      expect(buildGroceryOverrideItems([bad1, bad2], TWO)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // Boundary normalization: "" → null
  // -----------------------------------------------------------------

  describe("normalizes empty strings to null at boundary", () => {
    it("converts empty-string quantity to null (unscaled path)", () => {
      const ing = makeIngredient({ quantity: "", unit: null, name: "herbs" });
      const entry: ScaledIngredientEntry = {
        ingredient: ing,
        result: { kind: "unscaled", reason: "unparsed" },
      };

      const items = buildGroceryOverrideItems([entry], TWO);
      expect(items).toHaveLength(1);
      expect(items![0].quantity).toBeNull();
    });

    it("converts empty-string unit to null (unscaled path)", () => {
      const ing = makeIngredient({ quantity: "1", unit: "", name: "salt" });
      const entry: ScaledIngredientEntry = {
        ingredient: ing,
        result: { kind: "unscaled", reason: "unparsed" },
      };

      const items = buildGroceryOverrideItems([entry], TWO);
      expect(items).toHaveLength(1);
      expect(items![0].unit).toBeNull();
    });

    it("converts whitespace-only quantity to null (unscaled path)", () => {
      const ing = makeIngredient({ quantity: "   ", unit: null, name: "pepper" });
      const entry: ScaledIngredientEntry = {
        ingredient: ing,
        result: { kind: "unscaled", reason: "unparsed" },
      };

      const items = buildGroceryOverrideItems([entry], TWO);
      expect(items).toHaveLength(1);
      expect(items![0].quantity).toBeNull();
    });

    it("preserves non-empty quantity and unit (unscaled path)", () => {
      const ing = makeIngredient({ quantity: "to taste", unit: null, name: "salt" });
      const entry: ScaledIngredientEntry = {
        ingredient: ing,
        result: { kind: "unscaled", reason: "qualifier" },
      };

      const items = buildGroceryOverrideItems([entry], TWO);
      expect(items).toHaveLength(1);
      expect(items![0].quantity).toBe("to taste");
      expect(items![0].unit).toBeNull();
    });

    it("scaled path produces exact contract values (string | null, never empty)", () => {
      const ing = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
      const entries = [buildEntry(ing, TWO)];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toHaveLength(1);

      // Exact expected values for 1 cup × 2
      expect(items![0].quantity).toBe("2");
      expect(items![0].unit).toBe("cups");

      // Contract: string | null, never ""
      expect(items![0].quantity === null || typeof items![0].quantity === "string").toBe(true);
      expect(items![0].unit === null || typeof items![0].unit === "string").toBe(true);
      expect(items![0].quantity).not.toBe("");
      expect(items![0].unit).not.toBe("");
    });
  });

  // -----------------------------------------------------------------
  // Shape safety
  // -----------------------------------------------------------------

  describe("shape safety", () => {
    it("every item has name, quantity, and unit keys with correct types", () => {
      const flour = makeIngredient({ quantity: "2", unit: "cups", name: "flour" });
      const salt = makeIngredient({ quantity: "to taste", unit: null, name: "salt" });
      const herbs = makeIngredient({ quantity: null, unit: null, name: "herbs" });

      const entries = [
        buildEntry(flour, TWO),
        buildEntry(salt, TWO),
        buildEntry(herbs, TWO),
      ];

      const items = buildGroceryOverrideItems(entries, TWO);
      expect(items).toBeDefined();
      for (const item of items!) {
        expect(item).toHaveProperty("name");
        expect(item).toHaveProperty("quantity");
        expect(item).toHaveProperty("unit");
        expect(typeof item.name).toBe("string");
        expect(item.quantity === null || typeof item.quantity === "string").toBe(true);
        expect(item.unit === null || typeof item.unit === "string").toBe(true);
        expect(item.quantity).not.toBe("");
        expect(item.unit).not.toBe("");
      }
    });
  });
});

// =====================================================================
// shouldBlockScaledAdd — guards the mutation call site
// =====================================================================

describe("shouldBlockScaledAdd", () => {
  it("returns false when scaled items are valid (Case A)", () => {
    const items = [{ name: "flour", quantity: "2", unit: "cups" }];
    expect(shouldBlockScaledAdd(TWO, items)).toBe(false);
  });

  it("returns true when scaling is active but items are undefined (Case B)", () => {
    expect(shouldBlockScaledAdd(TWO, undefined)).toBe(true);
  });

  it("returns true when scaling is active but items are empty (Case B)", () => {
    expect(shouldBlockScaledAdd(TWO, [])).toBe(true);
  });

  it("returns false when scaleFactor is null — unscaled path (Case C)", () => {
    expect(shouldBlockScaledAdd(null, undefined)).toBe(false);
  });

  it("returns false when scaleFactor is ONE — no scaling applied", () => {
    expect(shouldBlockScaledAdd(ONE, undefined)).toBe(false);
  });

  it("returns false for non-trivial factor with valid items", () => {
    const factor = make(3n, 2n);
    const items = [{ name: "sugar", quantity: "1 1/2", unit: "cups" }];
    expect(shouldBlockScaledAdd(factor, items)).toBe(false);
  });

  it("returns true for non-trivial factor with empty items", () => {
    const factor = make(3n, 2n);
    expect(shouldBlockScaledAdd(factor, [])).toBe(true);
  });
});

// -----------------------------------------------------------------
// Substitution-provenance note (PROVIDER-S1.1 W2, OD-1 / OD-5)
// -----------------------------------------------------------------

describe("substitution-provenance note derivation", () => {
  it("carries a bare 'in place of' prep as note on the scaled path", () => {
    const ing = makeIngredient({
      quantity: "1",
      unit: "tsp",
      name: "soy sauce",
      prep: "in place of fish sauce",
    });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items).toHaveLength(1);
    expect(items![0].note).toBe("in place of fish sauce");
  });

  it("carries a parenthesized label with the parens stripped", () => {
    const ing = makeIngredient({
      quantity: "to taste",
      unit: null,
      name: "soy sauce",
      prep: "(in place of fish sauce)",
    });
    const entry: ScaledIngredientEntry = {
      ingredient: ing,
      result: { kind: "unscaled", reason: "qualifier" },
    };
    const items = buildGroceryOverrideItems([entry], TWO);
    expect(items![0].note).toBe("in place of fish sauce");
  });

  it("matches the prefix case-insensitively and preserves original casing", () => {
    const ing = makeIngredient({
      quantity: "1",
      unit: "tsp",
      name: "soy sauce",
      prep: "In Place Of Fish Sauce",
    });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items![0].note).toBe("In Place Of Fish Sauce");
  });

  it("yields null note for ordinary preparation text", () => {
    const ing = makeIngredient({
      quantity: "1",
      unit: "cup",
      name: "onion",
      prep: "diced",
    });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items![0].note).toBeNull();
  });

  it("yields null note when prep is null", () => {
    const ing = makeIngredient({ quantity: "1", unit: "cup", name: "flour" });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items![0].note).toBeNull();
  });

  it("yields null note when the label is not at the start of prep", () => {
    const ing = makeIngredient({
      quantity: "1",
      unit: "tsp",
      name: "soy sauce",
      prep: "added in place of fish sauce",
    });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items![0].note).toBeNull();
  });
});

// -----------------------------------------------------------------
// OD-1 parity table (post-rescue correction 7b)
//
// The SAME case names, inputs, and expected outputs appear verbatim in
// tests/test_grocery.py (OD1_PARITY_TABLE). Keep the two tables in
// lockstep: any change here without the mirror change there is a
// contract break between the backend and mobile note-derivation rules.
// -----------------------------------------------------------------

const OD1_PARITY_TABLE: ReadonlyArray<
  readonly [name: string, prep: string, expected: string | null]
> = [
  ["valid_bare", "in place of fish sauce", "in place of fish sauce"],
  ["valid_parenthesized", "(in place of fish sauce)", "in place of fish sauce"],
  ["mixed_case", "In Place Of Fish Sauce", "In Place Of Fish Sauce"],
  [
    "leading_trailing_whitespace",
    "  in place of fish sauce  ",
    "in place of fish sauce",
  ],
  ["ordinary_prep", "diced", null],
  ["phrase_later_in_text", "added in place of fish sauce", null],
  ["no_space_after_of", "in place ofX", null],
  ["empty_target", "in place of", null],
  ["whitespace_only_target", "in place of   ", null],
  ["unmatched_opening_paren", "(in place of fish sauce", null],
  [
    "unmatched_closing_paren",
    "in place of fish sauce)",
    "in place of fish sauce)",
  ],
  ["double_parens", "((in place of fish sauce))", null],
  [
    "punctuation_after_target",
    "in place of fish sauce.",
    "in place of fish sauce.",
  ],
];

describe("OD-1 parity table (backend/mobile contract)", () => {
  it.each(OD1_PARITY_TABLE)("%s", (_name, prep, expected) => {
    const ing = makeIngredient({
      quantity: "1",
      unit: "tsp",
      name: "soy sauce",
      prep,
    });
    const items = buildGroceryOverrideItems([buildEntry(ing, TWO)], TWO);
    expect(items).toHaveLength(1);
    expect(items![0].note).toBe(expected);
  });
});
