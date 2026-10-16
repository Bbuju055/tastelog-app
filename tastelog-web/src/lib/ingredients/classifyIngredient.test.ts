import { describe, expect, it } from "vitest";
import { classifyIngredient, normalizeUnit, detectQualifier } from "./classifyIngredient";
import type { IngredientResponse } from "@/lib/api/schemas";

// Helper to create minimal ingredient for testing
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

describe("normalizeUnit", () => {
  it("lowercases", () => {
    expect(normalizeUnit("CUP")).toBe("cup");
    expect(normalizeUnit("Tbsp")).toBe("tbsp");
  });

  it("trims whitespace", () => {
    expect(normalizeUnit("  cup  ")).toBe("cup");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeUnit("fl   oz")).toBe("fl oz");
  });

  it("strips trailing periods", () => {
    expect(normalizeUnit("tsp.")).toBe("tsp");
    expect(normalizeUnit("oz..")).toBe("oz");
  });

  it("handles null and undefined", () => {
    expect(normalizeUnit(null)).toBe("");
    expect(normalizeUnit(undefined)).toBe("");
  });
});

describe("detectQualifier", () => {
  it("detects qualifier in quantity", () => {
    expect(detectQualifier("to taste", null, null)).toBe("to taste");
    expect(detectQualifier("optional", null, null)).toBe("optional");
  });

  it("detects qualifier in unit", () => {
    expect(detectQualifier(null, "to taste", null)).toBe("to taste");
  });

  it("detects qualifier in raw_text", () => {
    expect(detectQualifier(null, null, "salt to taste")).toBe("to taste");
  });

  it("uses word boundary matching", () => {
    expect(detectQualifier("optionally", null, null)).toBeNull();
    expect(detectQualifier(null, null, "salt, to taste")).toBe("to taste");
  });

  it("returns null when no qualifier found", () => {
    expect(detectQualifier("2", "cups", "2 cups flour")).toBeNull();
  });
});

describe("classifyIngredient", () => {
  describe("numeric (continuous units)", () => {
    it("classifies volume units", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: "cups",
        name: "flour",
      }));
      expect(result).toEqual({
        kind: "numeric",
        value: { n: 2n, d: 1n },
        unit: "cups",
      });
    });

    it("classifies weight units", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "100",
        unit: "g",
        name: "sugar",
      }));
      expect(result).toEqual({
        kind: "numeric",
        value: { n: 100n, d: 1n },
        unit: "g",
      });
    });

    it("normalizes unit case", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "1",
        unit: "CUP",
        name: "milk",
      }));
      expect(result.kind).toBe("numeric");
      if (result.kind === "numeric") {
        expect(result.unit).toBe("cup");
      }
    });
  });

  describe("counted (eggs)", () => {
    it("classifies eggs as counted", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: "eggs",
        name: "large eggs",
      }));
      expect(result).toEqual({
        kind: "counted",
        value: { n: 2n, d: 1n },
        item: "egg",
      });
    });

    it("classifies singular egg", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "1",
        unit: "egg",
        name: "egg",
      }));
      expect(result).toEqual({
        kind: "counted",
        value: { n: 1n, d: 1n },
        item: "egg",
      });
    });

    it("does NOT infer counted from name", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: null,
        name: "eggs",
      }));
      expect(result.kind).toBe("unparsed");
    });
  });

  describe("container", () => {
    it("classifies can", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "1",
        unit: "can",
        name: "tomatoes",
      }));
      expect(result).toEqual({
        kind: "container",
        value: { n: 1n, d: 1n },
        unitWord: "can",
      });
    });

    it("classifies plural containers", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: "jars",
        name: "sauce",
      }));
      expect(result).toEqual({
        kind: "container",
        value: { n: 2n, d: 1n },
        unitWord: "jar",
      });
    });

    it("classifies package/pkg", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "1",
        unit: "pkg",
        name: "noodles",
      }));
      expect(result).toEqual({
        kind: "container",
        value: { n: 1n, d: 1n },
        unitWord: "pkg",
      });
    });
  });

  describe("qualifier", () => {
    it("classifies 'to taste'", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "to taste",
        unit: null,
        name: "salt",
      }));
      expect(result).toEqual({
        kind: "qualifier",
        text: "to taste",
      });
    });

    it("classifies 'as needed'", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: null,
        unit: "as needed",
        name: "water",
      }));
      expect(result).toEqual({
        kind: "qualifier",
        text: "as needed",
      });
    });

    it("detects qualifier in raw_text", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: null,
        unit: null,
        name: "pepper",
        raw_text: "pepper, optional",
      }));
      expect(result).toEqual({
        kind: "qualifier",
        text: "optional",
      });
    });

    it("does NOT detect qualifier from name only", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: "cups",
        name: "optional garnish mix",
      }));
      expect(result.kind).toBe("numeric");
    });
  });

  describe("unparsed", () => {
    it("classifies null quantity as unparsed", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: null,
        unit: null,
        name: "flour",
      }));
      expect(result).toEqual({
        kind: "unparsed",
        text: "flour",
      });
    });

    it("classifies unparseable quantity as unparsed", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "some",
        unit: null,
        name: "butter",
      }));
      expect(result.kind).toBe("unparsed");
    });

    it("classifies unknown unit as unparsed", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "2",
        unit: "handfuls",
        name: "spinach",
      }));
      expect(result.kind).toBe("unparsed");
    });

    it("uses raw_text when available", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: null,
        unit: null,
        name: "flour",
        raw_text: "some flour",
      }));
      expect(result).toEqual({
        kind: "unparsed",
        text: "some flour",
      });
    });

    it("falls back to quantity when no raw_text", () => {
      const result = classifyIngredient(makeIngredient({
        quantity: "about 2",
        unit: "cups",
        name: "flour",
        raw_text: null,
      }));
      expect(result).toEqual({
        kind: "unparsed",
        text: "about 2",
      });
    });
  });
});
