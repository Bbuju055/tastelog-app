import { formatIngredient, pluralize } from "../../../lib/ingredients/formatIngredient";
import { make, ONE, TWO, HALF } from "../../../lib/ingredients/rational";
import type { IngredientResponse } from "../../../lib/api/schemas";
import type { ScaleResult } from "../../../lib/ingredients/types";

function makeIngredient(
  overrides: Partial<IngredientResponse>
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

describe("pluralize", () => {
  it("returns singular for quantity = 1", () => {
    expect(pluralize("cup", ONE)).toBe("cup");
    expect(pluralize("can", ONE)).toBe("can");
    expect(pluralize("egg", ONE)).toBe("egg");
  });

  it("returns plural for quantity > 1", () => {
    expect(pluralize("cup", TWO)).toBe("cups");
    expect(pluralize("can", TWO)).toBe("cans");
    expect(pluralize("egg", TWO)).toBe("eggs");
  });

  it("returns plural for fractions", () => {
    expect(pluralize("cup", HALF)).toBe("cups");
    expect(pluralize("can", make(3n, 2n))).toBe("cans");
  });

  it("normalizes unit aliases", () => {
    expect(pluralize("tsp", ONE)).toBe("teaspoon");
    expect(pluralize("tsp", TWO)).toBe("teaspoons");
    expect(pluralize("tbsp", ONE)).toBe("tablespoon");
    expect(pluralize("lbs", TWO)).toBe("pounds");
  });

  it("leaves unknown units unchanged", () => {
    expect(pluralize("handful", TWO)).toBe("handful");
  });
});

describe("formatIngredient", () => {
  describe("numeric (continuous units)", () => {
    it("formats with pluralized unit", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "numeric", value: TWO, unit: "cup" },
      };
      const ingredient = makeIngredient({ name: "flour" });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("2 cups flour");
      expect(formatted.prep).toBeNull();
      expect(formatted.annotation).toBeNull();
      expect(formatted.showNotScaled).toBe(false);
    });

    it("uses singular for quantity = 1", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "numeric", value: ONE, unit: "cup" },
      };
      const ingredient = makeIngredient({ name: "flour" });
      const formatted = formatIngredient(result, ingredient, ONE);

      expect(formatted.main).toBe("1 cup flour");
    });

    it("handles fractional quantities", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "numeric", value: make(3n, 2n), unit: "cup" },
      };
      const ingredient = makeIngredient({ name: "flour" });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("1 1/2 cups flour");
    });

    it("includes prep when present", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "numeric", value: TWO, unit: "cup" },
      };
      const ingredient = makeIngredient({ name: "flour", prep: "sifted" });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("2 cups flour");
      expect(formatted.prep).toBe("sifted");
    });
  });

  describe("container", () => {
    it("formats with pluralized unit", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "container", value: TWO, unitWord: "can" },
      };
      const ingredient = makeIngredient({ name: "tomatoes" });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("2 cans tomatoes");
    });

    it("handles fractional containers", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "container", value: HALF, unitWord: "can" },
      };
      const ingredient = makeIngredient({ name: "tomatoes" });
      const formatted = formatIngredient(result, ingredient, HALF);

      expect(formatted.main).toBe("1/2 cans tomatoes");
    });
  });

  describe("counted (eggs)", () => {
    it("formats without annotation when not rounded", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "counted", value: make(4n), item: "egg" },
      };
      const ingredient = makeIngredient({ name: "large eggs" });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("4 eggs large eggs");
      expect(formatted.annotation).toBeNull();
    });

    it("adds (rounded) annotation when rounded", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "counted", value: make(2n), item: "egg" },
        meta: { rounded: true },
      };
      const ingredient = makeIngredient({ name: "large eggs" });
      const formatted = formatIngredient(result, ingredient, HALF);

      expect(formatted.main).toBe("2 eggs large eggs");
      expect(formatted.annotation).toBe("(rounded)");
    });

    it("uses singular for 1 egg", () => {
      const result: ScaleResult = {
        kind: "scaled",
        scaled: { kind: "counted", value: ONE, item: "egg" },
        meta: { rounded: true },
      };
      const ingredient = makeIngredient({ name: "large egg" });
      const formatted = formatIngredient(result, ingredient, HALF);

      expect(formatted.main).toBe("1 egg large egg");
    });
  });

  describe("qualifier", () => {
    it("formats with qualifier in parentheses", () => {
      const result: ScaleResult = {
        kind: "unscaled",
        reason: "qualifier",
      };
      const ingredient = makeIngredient({
        quantity: "to taste",
        name: "salt",
      });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("salt");
      expect(formatted.annotation).toBe("(to taste)");
      expect(formatted.showNotScaled).toBe(false);
    });

    it("detects 'optional' qualifier", () => {
      const result: ScaleResult = {
        kind: "unscaled",
        reason: "qualifier",
      };
      const ingredient = makeIngredient({
        name: "pepper",
        raw_text: "pepper, optional",
      });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.annotation).toBe("(optional)");
    });
  });

  describe("unparsed", () => {
    it("shows 'not scaled' when factor != 1", () => {
      const result: ScaleResult = {
        kind: "unscaled",
        reason: "unparsed",
      };
      const ingredient = makeIngredient({
        quantity: null,
        name: "flour",
      });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("flour");
      expect(formatted.showNotScaled).toBe(true);
    });

    it("hides 'not scaled' when factor = 1", () => {
      const result: ScaleResult = {
        kind: "unscaled",
        reason: "unparsed",
      };
      const ingredient = makeIngredient({
        quantity: null,
        name: "flour",
      });
      const formatted = formatIngredient(result, ingredient, ONE);

      expect(formatted.showNotScaled).toBe(false);
    });

    it("uses raw_text when available", () => {
      const result: ScaleResult = {
        kind: "unscaled",
        reason: "unparsed",
      };
      const ingredient = makeIngredient({
        name: "flour",
        raw_text: "some flour",
      });
      const formatted = formatIngredient(result, ingredient, TWO);

      expect(formatted.main).toBe("some flour");
    });
  });
});
