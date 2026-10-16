/**
 * Schema smoke tests.
 *
 * These tests verify that schemas tolerate real-world backend variations.
 * Prevents "someone tightened schema" regressions.
 */

import { describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  draftResponseSchema,
  recipeDetailResponseSchema,
} from "./schemas";

describe("apiErrorResponseSchema", () => {
  it("parses 422 error with detail as array", () => {
    const payload = {
      detail: [
        {
          loc: ["body", "title"],
          msg: "field required",
          type: "value_error.missing",
        },
      ],
    };

    const result = apiErrorResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("parses error with detail as string", () => {
    const payload = {
      detail: "Recipe not found",
    };

    const result = apiErrorResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe("draftResponseSchema", () => {
  it("parses draft with only image_path (no image_storage_key)", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      image_path: "user123/image.jpg",
      title: "Test Recipe",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: 0.85,
      ingredients: [{ name: "Salt" }],
      steps: [{ instruction: "Mix well" }],
      raw_model_json: null,
      model_version: "claude-3",
      parser_version: "1.0",
      expires_at: "2026-01-25T12:00:00Z",
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = draftResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("parses draft with model_version as null", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      image_storage_key: "user123/image.jpg",
      title: "Test Recipe",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      raw_model_json: null,
      model_version: null,
      parser_version: null,
      expires_at: "2026-01-25T12:00:00Z",
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = draftResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("parses draft without position fields in ingredients/steps", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      image_storage_key: "user123/image.jpg",
      title: "Test Recipe",
      servings: "4",
      prep_time: "10 min",
      cook_time: "20 min",
      confidence_score: 0.9,
      ingredients: [
        { name: "Flour", quantity: "2", unit: "cups" },
        { name: "Sugar", quantity: "1", unit: "cup" },
      ],
      steps: [
        { instruction: "Preheat oven" },
        { instruction: "Mix ingredients" },
      ],
      raw_model_json: { original: "data" },
      model_version: "claude-3",
      parser_version: "1.0",
      expires_at: "2026-01-25T12:00:00.123456Z",
      created_at: "2026-01-24T12:00:00+00:00",
      updated_at: "2026-01-24T12:00:00.999Z",
    };

    const result = draftResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe("dateTimeSchema accepts non-empty strings", () => {
  it("accepts timestamps with microseconds", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Test",
      image_storage_key: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      created_at: "2026-01-24T12:00:00.123456Z",
      updated_at: "2026-01-24T12:00:00.123456Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts timestamps with timezone offset", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Test",
      image_storage_key: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      created_at: "2026-01-24T12:00:00+00:00",
      updated_at: "2026-01-24T12:00:00-05:00",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

describe("recipeDetailResponseSchema", () => {
  it("parses minimal valid payload (empty arrays)", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Minimal Recipe",
      image_storage_key: null,
      image_path: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ingredients).toEqual([]);
      expect(result.data.steps).toEqual([]);
      expect(result.data.image_path).toBeNull();
    }
  });

  it("parses full recipe with ingredients and steps", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Full Recipe",
      image_storage_key: "user123/recipe.jpg",
      image_path: null,
      servings: "4 servings",
      prep_time: "15 min",
      cook_time: "30 min",
      confidence_score: 0.95,
      ingredients: [
        {
          id: "550e8400-e29b-41d4-a716-446655440010",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 1,
          quantity: "2",
          unit: "cups",
          name: "flour",
          prep: "sifted",
          raw_text: "2 cups flour, sifted",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440011",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 2,
          quantity: "1",
          unit: "tsp",
          name: "salt",
          prep: null,
          raw_text: "1 tsp salt",
        },
      ],
      steps: [
        {
          id: "550e8400-e29b-41d4-a716-446655440020",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 1,
          instruction: "Preheat oven to 350°F.",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440021",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 2,
          instruction: "Mix dry ingredients together.",
        },
      ],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T14:30:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ingredients).toHaveLength(2);
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.ingredients[0].name).toBe("flour");
      expect(result.data.steps[0].instruction).toBe("Preheat oven to 350°F.");
    }
  });

  it("rejects payload missing required id", () => {
    const payload = {
      // id missing
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "No ID Recipe",
      image_storage_key: null,
      image_path: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects payload missing required title", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      // title missing
      image_storage_key: null,
      image_path: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects ingredient missing required name", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Recipe with bad ingredient",
      image_storage_key: null,
      image_path: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [
        {
          id: "550e8400-e29b-41d4-a716-446655440010",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 1,
          quantity: "2",
          unit: "cups",
          // name missing
          prep: null,
          raw_text: null,
        },
      ],
      steps: [],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects step missing required instruction", () => {
    const payload = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Recipe with bad step",
      image_storage_key: null,
      image_path: null,
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      ingredients: [],
      steps: [
        {
          id: "550e8400-e29b-41d4-a716-446655440020",
          recipe_id: "550e8400-e29b-41d4-a716-446655440000",
          position: 1,
          // instruction missing
        },
      ],
      created_at: "2026-01-24T12:00:00Z",
      updated_at: "2026-01-24T12:00:00Z",
    };

    const result = recipeDetailResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
