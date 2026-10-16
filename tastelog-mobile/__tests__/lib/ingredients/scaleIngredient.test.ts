import { scaleIngredient } from "../../../lib/ingredients/scaleIngredient";
import { make, HALF, TWO } from "../../../lib/ingredients/rational";
import type { IngredientResponse } from "../../../lib/api/schemas";

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

describe("scaleIngredient", () => {
  describe("numeric (continuous units)", () => {
    it("scales by 2", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1", unit: "cup", name: "flour" }),
        TWO
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "numeric",
          value: { n: 2n, d: 1n },
          unit: "cup",
        });
        expect(result.meta).toBeUndefined();
      }
    });

    it("scales by 1/2", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "2", unit: "cups", name: "flour" }),
        HALF
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "numeric",
          value: { n: 1n, d: 1n },
          unit: "cups",
        });
      }
    });

    it("scales fractional quantity", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1 1/2", unit: "cups", name: "flour" }),
        TWO
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "numeric",
          value: { n: 3n, d: 1n },
          unit: "cups",
        });
      }
    });

    it("preserves exact fractions", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1", unit: "cup", name: "flour" }),
        make(1n, 3n)
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "numeric",
          value: { n: 1n, d: 3n },
          unit: "cup",
        });
      }
    });
  });

  describe("container", () => {
    it("scales can by 2", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1", unit: "can", name: "tomatoes" }),
        TWO
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "container",
          value: { n: 2n, d: 1n },
          unitWord: "can",
        });
      }
    });

    it("allows fractional containers", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1", unit: "can", name: "tomatoes" }),
        HALF
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "container",
          value: { n: 1n, d: 2n },
          unitWord: "can",
        });
      }
    });
  });

  describe("counted (eggs)", () => {
    it("scales without rounding when result is whole", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "2", unit: "eggs", name: "eggs" }),
        TWO
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "counted",
          value: { n: 4n, d: 1n },
          item: "egg",
        });
        expect(result.meta).toBeUndefined();
      }
    });

    it("rounds and annotates when result is fractional", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "3", unit: "eggs", name: "eggs" }),
        HALF
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "counted",
          value: { n: 2n, d: 1n },
          item: "egg",
        });
        expect(result.meta).toEqual({ rounded: true });
      }
    });

    it("rounds 0.5 up to 1", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "1", unit: "egg", name: "egg" }),
        HALF
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "counted",
          value: { n: 1n, d: 1n },
          item: "egg",
        });
        expect(result.meta).toEqual({ rounded: true });
      }
    });

    it("rounds 2.5 up to 3", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "5", unit: "eggs", name: "eggs" }),
        HALF
      );
      expect(result.kind).toBe("scaled");
      if (result.kind === "scaled") {
        expect(result.scaled).toEqual({
          kind: "counted",
          value: { n: 3n, d: 1n },
          item: "egg",
        });
        expect(result.meta).toEqual({ rounded: true });
      }
    });
  });

  describe("qualifier", () => {
    it("returns unscaled for 'to taste'", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "to taste", unit: null, name: "salt" }),
        TWO
      );
      expect(result).toEqual({
        kind: "unscaled",
        reason: "qualifier",
      });
    });

    it("returns unscaled for 'optional'", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: null, unit: null, name: "pepper", raw_text: "pepper, optional" }),
        TWO
      );
      expect(result).toEqual({
        kind: "unscaled",
        reason: "qualifier",
      });
    });
  });

  describe("unparsed", () => {
    it("returns unscaled for null quantity", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: null, unit: null, name: "flour" }),
        TWO
      );
      expect(result).toEqual({
        kind: "unscaled",
        reason: "unparsed",
      });
    });

    it("returns unscaled for unparseable quantity", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "some", unit: null, name: "butter" }),
        TWO
      );
      expect(result).toEqual({
        kind: "unscaled",
        reason: "unparsed",
      });
    });

    it("returns unscaled for unknown unit", () => {
      const result = scaleIngredient(
        makeIngredient({ quantity: "2", unit: "handfuls", name: "spinach" }),
        TWO
      );
      expect(result).toEqual({
        kind: "unscaled",
        reason: "unparsed",
      });
    });
  });

  describe("factor validation", () => {
    it("throws for zero factor", () => {
      expect(() =>
        scaleIngredient(
          makeIngredient({ quantity: "1", unit: "cup", name: "flour" }),
          make(0n, 1n)
        )
      ).toThrow("Scale factor must be > 0");
    });

    it("throws for negative factor", () => {
      expect(() =>
        scaleIngredient(
          makeIngredient({ quantity: "1", unit: "cup", name: "flour" }),
          make(-1n, 1n)
        )
      ).toThrow("Scale factor must be > 0");
    });
  });
});
