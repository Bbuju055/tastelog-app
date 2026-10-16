import { draftResponseSchema } from "../../../lib/api/schemas";

describe("draftResponseSchema — multi-image", () => {
  const baseDraft = {
    id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    user_id: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
    title: "Test Recipe",
    servings: null,
    prep_time: null,
    cook_time: null,
    confidence_score: 0.9,
    ingredients: [],
    steps: [],
    raw_model_json: null,
    model_version: "claude-sonnet-4-20250514",
    parser_version: "1.0",
    expires_at: "2026-04-01T00:00:00Z",
    created_at: "2026-03-28T00:00:00Z",
    updated_at: "2026-03-28T00:00:00Z",
  };

  test("accepts single image_storage_keys", () => {
    const result = draftResponseSchema.parse({
      ...baseDraft,
      image_storage_keys: ["user/abc123.jpg"],
    });
    expect(result.image_storage_keys).toEqual(["user/abc123.jpg"]);
  });

  test("accepts multiple image_storage_keys", () => {
    const keys = ["user/p1.jpg", "user/p2.jpg", "user/p3.jpg"];
    const result = draftResponseSchema.parse({
      ...baseDraft,
      image_storage_keys: keys,
    });
    expect(result.image_storage_keys).toEqual(keys);
    expect(result.image_storage_keys).toHaveLength(3);
  });

  test("rejects missing image_storage_keys", () => {
    expect(() => draftResponseSchema.parse(baseDraft)).toThrow();
  });

  test("rejects empty string in image_storage_keys", () => {
    expect(() =>
      draftResponseSchema.parse({
        ...baseDraft,
        image_storage_keys: ["valid.jpg", ""],
      }),
    ).toThrow();
  });

  test("does not accept old singular image_storage_key field", () => {
    const parsed = draftResponseSchema.parse({
      ...baseDraft,
      image_storage_keys: ["key.jpg"],
      image_storage_key: "should-be-ignored",
    });
    // Old field should not appear in parsed output
    expect("image_storage_key" in parsed).toBe(false);
  });
});
