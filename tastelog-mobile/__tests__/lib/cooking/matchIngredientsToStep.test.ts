import type { IngredientResponse } from "../../../lib/api/schemas";
import { matchIngredientsToStep } from "../../../lib/cooking/matchIngredientsToStep";

/**
 * Minimal valid IngredientResponse factory. All fields present per schema.
 * Callers override only what the test cares about.
 */
function makeIngredient(
  name: string,
  overrides: Partial<IngredientResponse> = {},
): IngredientResponse {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    recipe_id: "00000000-0000-0000-0000-000000000000",
    position: 1,
    quantity: null,
    unit: null,
    name,
    prep: null,
    raw_text: null,
    ...overrides,
  };
}

describe("matchIngredientsToStep", () => {
  describe("core matching", () => {
    it("matches exact single-word ingredient", () => {
      const salt = makeIngredient("salt");
      expect(matchIngredientsToStep([salt], "add salt")).toEqual([salt]);
    });

    it("matches exact multi-word ingredient", () => {
      const oil = makeIngredient("olive oil");
      expect(matchIngredientsToStep([oil], "heat olive oil")).toEqual([oil]);
    });

    it("requires adjacency for multi-word ingredients", () => {
      const oil = makeIngredient("olive oil");
      expect(matchIngredientsToStep([oil], "olive and oil")).toEqual([]);
    });
  });

  describe("plural normalization", () => {
    it("matches singular ingredient against -s plural in step", () => {
      const egg = makeIngredient("egg");
      expect(matchIngredientsToStep([egg], "crack the eggs")).toEqual([egg]);
    });

    it("matches singular ingredient against -es plural in step", () => {
      const tomato = makeIngredient("tomato");
      expect(matchIngredientsToStep([tomato], "dice the tomatoes")).toEqual([
        tomato,
      ]);
    });

    it("does NOT match cherry/cherries — documented limitation", () => {
      // Explicit assertion of the locked limitation: we strip "ies" only,
      // with no y-stem rule, so "cherries" -> "cherr" cannot meet "cherry".
      // Pinning this behavior so any future change to stemming is caught.
      const cherry = makeIngredient("cherry");
      expect(matchIngredientsToStep([cherry], "add the cherries")).toEqual([]);
    });
  });

  describe("punctuation handling", () => {
    it("matches across trailing comma in step", () => {
      const tomato = makeIngredient("tomato");
      expect(
        matchIngredientsToStep([tomato], "add tomatoes, then stir"),
      ).toEqual([tomato]);
    });

    it("matches across trailing period in step", () => {
      const oil = makeIngredient("oil");
      expect(matchIngredientsToStep([oil], "heat oil.")).toEqual([oil]);
    });
  });

  describe("false positive protection", () => {
    it("does NOT match 'olive oil' ingredient against 'add oil' step", () => {
      const oliveOil = makeIngredient("olive oil");
      expect(matchIngredientsToStep([oliveOil], "add oil")).toEqual([]);
    });

    it("does NOT match 'olive oil' ingredient against 'add sesame oil' step", () => {
      const oliveOil = makeIngredient("olive oil");
      expect(matchIngredientsToStep([oliveOil], "add sesame oil")).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("returns no matches for empty instruction", () => {
      const salt = makeIngredient("salt");
      expect(matchIngredientsToStep([salt], "")).toEqual([]);
    });

    it("ignores ingredient whose name produces no tokens", () => {
      // Schema requires name.length >= 1. A whitespace-only name is
      // schema-valid but tokenizes to []. The function's defensive guard
      // must skip it without matching or throwing.
      const bogus = makeIngredient("   ");
      const salt = makeIngredient("salt", {
        id: "00000000-0000-0000-0000-000000000002",
      });
      expect(matchIngredientsToStep([bogus, salt], "add salt")).toEqual([salt]);
    });

    it("preserves input order of matched ingredients, not match order in step", () => {
      const salt = makeIngredient("salt", {
        id: "00000000-0000-0000-0000-000000000001",
      });
      const pepper = makeIngredient("pepper", {
        id: "00000000-0000-0000-0000-000000000002",
      });
      const garlic = makeIngredient("garlic", {
        id: "00000000-0000-0000-0000-000000000003",
      });
      // Instruction mentions garlic first, then salt, then pepper — but
      // the output must follow the input array order: salt, pepper, garlic.
      const result = matchIngredientsToStep(
        [salt, pepper, garlic],
        "mince the garlic, add salt and pepper",
      );
      expect(result).toEqual([salt, pepper, garlic]);
    });

    it("returns all matching ingredients when multiple appear in one step", () => {
      const salt = makeIngredient("salt", {
        id: "00000000-0000-0000-0000-000000000001",
      });
      const pepper = makeIngredient("pepper", {
        id: "00000000-0000-0000-0000-000000000002",
      });
      const result = matchIngredientsToStep(
        [salt, pepper],
        "add salt and pepper",
      );
      expect(result).toEqual([salt, pepper]);
    });
  });
});
