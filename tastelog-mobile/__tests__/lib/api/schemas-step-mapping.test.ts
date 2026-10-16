/**
 * Issue 1: stepResponseSchema.ingredient_ids wire contract.
 *
 * null/absent = mapping unknown (legacy or pre-mapping backend),
 * [] = authoritative empty, ids = authoritative references.
 */

import {
  stepResponseSchema,
  recipeDetailResponseSchema,
  recipeContentUpdateRequestSchema,
} from "../../../lib/api/schemas";

const BASE_STEP = {
  id: "11111111-1111-4111-8111-111111111111",
  recipe_id: "22222222-2222-4222-8222-222222222222",
  position: 1,
  instruction: "Mix",
};

const ING_ID = "33333333-3333-4333-8333-333333333333";

describe("stepResponseSchema.ingredient_ids", () => {
  it("parses an absent field as undefined (unknown)", () => {
    const parsed = stepResponseSchema.parse(BASE_STEP);
    expect(parsed.ingredient_ids).toBeUndefined();
  });

  it("parses null (unknown)", () => {
    const parsed = stepResponseSchema.parse({
      ...BASE_STEP,
      ingredient_ids: null,
    });
    expect(parsed.ingredient_ids).toBeNull();
  });

  it("parses an empty array (authoritative empty)", () => {
    const parsed = stepResponseSchema.parse({
      ...BASE_STEP,
      ingredient_ids: [],
    });
    expect(parsed.ingredient_ids).toEqual([]);
  });

  it("parses ingredient id references", () => {
    const parsed = stepResponseSchema.parse({
      ...BASE_STEP,
      ingredient_ids: [ING_ID],
    });
    expect(parsed.ingredient_ids).toEqual([ING_ID]);
  });

  it("rejects non-uuid ids", () => {
    expect(() =>
      stepResponseSchema.parse({
        ...BASE_STEP,
        ingredient_ids: ["not-a-uuid"],
      }),
    ).toThrow();
  });

  it("recipe detail parses steps with and without the field (deploy gap)", () => {
    const detail = {
      id: "44444444-4444-4444-8444-444444444444",
      user_id: "55555555-5555-4555-8555-555555555555",
      title: "T",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      favorite: false,
      tags: [],
      ingredients: [],
      steps: [
        BASE_STEP,
        { ...BASE_STEP, id: "66666666-6666-4666-8666-666666666666", position: 2, ingredient_ids: [ING_ID] },
      ],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const parsed = recipeDetailResponseSchema.parse(detail);
    expect(parsed.steps[0].ingredient_ids).toBeUndefined();
    expect(parsed.steps[1].ingredient_ids).toEqual([ING_ID]);
  });

  // Issue 3: content_rev wire contract.
  it("recipe detail parses content_rev, and tolerates its absence (deploy gap)", () => {
    const base = {
      id: "44444444-4444-4444-8444-444444444444",
      user_id: "55555555-5555-4555-8555-555555555555",
      title: "T",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence_score: null,
      favorite: false,
      tags: [],
      ingredients: [],
      steps: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    expect(recipeDetailResponseSchema.parse(base).content_rev).toBeUndefined();
    expect(
      recipeDetailResponseSchema.parse({ ...base, content_rev: 4 }).content_rev,
    ).toBe(4);
    expect(() =>
      recipeDetailResponseSchema.parse({ ...base, content_rev: 0 }),
    ).toThrow();
  });
});

// Issue 3: request wire round-trip (plan section 6.1 explicit-ops model).
describe("recipeContentUpdateRequestSchema", () => {
  const MUTATION_ID = "77777777-7777-4777-8777-777777777777";
  const ROW_ID = "88888888-8888-4888-8888-888888888888";
  const TEMP_ID = "99999999-9999-4999-8999-999999999999";

  it("round-trips a full explicit-operations request", () => {
    const request = {
      expected_content_rev: 3,
      mutation_id: MUTATION_ID,
      fields: { title: "Better", servings: null },
      ingredients: {
        update: [{ id: ROW_ID, fields: { name: "sea salt" } }],
        create: [
          {
            temp_id: TEMP_ID,
            name: "basil",
            quantity: null,
            unit: null,
            prep: null,
          },
        ],
        delete: [ING_ID],
        order: [ROW_ID, TEMP_ID],
      },
      steps: {
        update: [{ id: ROW_ID, fields: { instruction: "Mix well." } }],
        order: [ROW_ID],
      },
    };
    expect(recipeContentUpdateRequestSchema.parse(request)).toEqual(request);
  });

  it("preserves tri-state: absent keys stay absent, null survives as null", () => {
    const request = {
      expected_content_rev: 1,
      mutation_id: MUTATION_ID,
      fields: { servings: null },
    };
    const parsed = recipeContentUpdateRequestSchema.parse(request);
    expect(parsed.fields).toEqual({ servings: null });
    expect("title" in (parsed.fields as object)).toBe(false);
    expect(parsed.ingredients).toBeUndefined();
    expect(parsed.steps).toBeUndefined();
  });

  it("an empty order array is legal (delete-all final membership)", () => {
    const request = {
      expected_content_rev: 2,
      mutation_id: MUTATION_ID,
      ingredients: { delete: [ROW_ID], order: [] },
    };
    expect(
      recipeContentUpdateRequestSchema.parse(request).ingredients?.order,
    ).toEqual([]);
  });

  it("rejects unknown keys at every nesting level", () => {
    const base = { expected_content_rev: 1, mutation_id: MUTATION_ID };
    expect(() =>
      recipeContentUpdateRequestSchema.parse({ ...base, bogus: 1 }),
    ).toThrow();
    expect(() =>
      recipeContentUpdateRequestSchema.parse({
        ...base,
        fields: { image_path: "hack" },
      }),
    ).toThrow();
    expect(() =>
      recipeContentUpdateRequestSchema.parse({
        ...base,
        ingredients: {
          update: [{ id: ROW_ID, fields: { raw_text: "forged" } }],
        },
      }),
    ).toThrow();
    expect(() =>
      recipeContentUpdateRequestSchema.parse({
        ...base,
        steps: { upsert: [] },
      }),
    ).toThrow();
  });

  it("rejects a non-uuid mutation_id and a rev below 1", () => {
    expect(() =>
      recipeContentUpdateRequestSchema.parse({
        expected_content_rev: 0,
        mutation_id: MUTATION_ID,
        fields: { title: "T" },
      }),
    ).toThrow();
    expect(() =>
      recipeContentUpdateRequestSchema.parse({
        expected_content_rev: 1,
        mutation_id: "nope",
        fields: { title: "T" },
      }),
    ).toThrow();
  });
});
