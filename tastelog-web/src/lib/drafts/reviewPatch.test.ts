// src/lib/drafts/reviewPatch.test.ts
import { describe, expect, it } from "vitest";
import { buildConfirmPatch, clearedFields, draftToCardValue } from "@/lib/drafts/reviewPatch";
import type { DraftResponse } from "@/lib/api/schemas";

const flour = { quantity: "2", unit: "cups", name: "flour", prep: "sifted", raw_text: null };
const salt = { quantity: null, unit: null, name: "salt", prep: null, raw_text: "salt to taste" };
const egg = { quantity: "1", unit: null, name: "egg", prep: "beaten", raw_text: "1 egg, beaten" };
const unstructured = (text: string) => ({ quantity: null, unit: null, name: text, prep: null, raw_text: text });

const draft: DraftResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  image_storage_key: "drafts/x.jpg",
  image_path: null,
  title: "Pancakes",
  servings: "4",
  prep_time: "10 min",
  cook_time: null,
  confidence_score: 0.9,
  ingredients: [
    { position: 1, ...flour },
    { position: 2, ...salt },
    { position: 3, ...egg },
  ],
  steps: [
    { position: 1, instruction: "Whisk the dry ingredients." },
    { position: 2, instruction: "Fry until golden." },
  ],
  raw_model_json: null,
  model_version: "m1",
  parser_version: "p1",
  expires_at: "2026-01-02T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("draftToCardValue", () => {
  it("renders API-shaped ingredients and steps as editable lines", () => {
    const value = draftToCardValue(draft);
    expect(value.title).toBe("Pancakes");
    expect(value.servings).toBe("4");
    expect(value.prep).toBe("10 min");
    expect(value.cook).toBe("");
    expect(value.ingredients.map((l) => l.text)).toEqual(["2 cups flour, sifted", "salt to taste", "1 egg, beaten"]);
    expect(value.steps.map((l) => l.text)).toEqual(["Whisk the dry ingredients.", "Fry until golden."]);
  });

  it("gives every line a unique id", () => {
    const value = draftToCardValue(draft);
    const ids = [...value.ingredients, ...value.steps].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildConfirmPatch", () => {
  it("returns undefined when nothing changed", () => {
    expect(buildConfirmPatch(draft, draftToCardValue(draft))).toBeUndefined();
  });

  it("sends only the title when only the title changed", () => {
    const edited = { ...draftToCardValue(draft), title: "Fluffy Pancakes" };
    expect(buildConfirmPatch(draft, edited)).toEqual({ title: "Fluffy Pancakes" });
  });

  it("sends servings and cook when edited", () => {
    const edited = { ...draftToCardValue(draft), servings: "2", cook: "15 min" };
    expect(buildConfirmPatch(draft, edited)).toEqual({ servings: "2", cook_time: "15 min" });
  });

  it("a field cleared to empty is never sent (the API cannot clear a value)", () => {
    const edited = { ...draftToCardValue(draft), prep: "" };
    expect(buildConfirmPatch(draft, edited)).toBeUndefined();
  });

  it("sends an edited line as an unstructured truthful row, and untouched rows verbatim", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [{ ...value.ingredients[0], text: "3 cups flour, sifted" }, value.ingredients[1], value.ingredients[2]],
    };
    expect(buildConfirmPatch(draft, edited)).toEqual({
      ingredients: [unstructured("3 cups flour, sifted"), salt, egg],
    });
  });

  it("keeps raw_text null on an untouched row when a different row is edited", () => {
    // Sending display text as raw_text for an untouched row would make the API
    // treat it as an edit and clear its quantity/unit/prep.
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [value.ingredients[0], { ...value.ingredients[1], text: "a pinch of salt" }, value.ingredients[2]],
    };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([flour, unstructured("a pinch of salt"), egg]);
  });

  it("delete + edit + append at equal count carries no stale structure for the API to pair up", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [{ ...value.ingredients[1], text: "2 tsp salt" }, value.ingredients[2], { id: "ing_new_1", text: "pepper" }],
    };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([unstructured("2 tsp salt"), egg, unstructured("pepper")]);
  });

  it("never sends position on ingredients (the API forbids extra fields)", () => {
    const value = draftToCardValue(draft);
    const edited = { ...value, ingredients: [{ ...value.ingredients[0], text: "flour" }, ...value.ingredients.slice(1)] };
    for (const row of buildConfirmPatch(draft, edited)?.ingredients ?? []) {
      expect(row).not.toHaveProperty("position");
    }
  });

  it("deleting a middle line keeps the remaining rows intact", () => {
    const value = draftToCardValue(draft);
    const edited = { ...value, ingredients: [value.ingredients[0], value.ingredients[2]] };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([flour, egg]);
  });

  it("reordering lines keeps each row's structure", () => {
    const value = draftToCardValue(draft);
    const edited = { ...value, ingredients: [value.ingredients[2], value.ingredients[0], value.ingredients[1]] };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([egg, flour, salt]);
  });

  it("inserting a line in the middle adds an unstructured row and keeps the neighbours", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [value.ingredients[0], { id: "ing_abc_123", text: "1 tsp sugar" }, value.ingredients[1], value.ingredients[2]],
    };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([flour, unstructured("1 tsp sugar"), salt, egg]);
  });

  it("sends the full step list with positions when one instruction changed", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      steps: [value.steps[0], { ...value.steps[1], text: "Fry until golden on both sides." }],
    };
    expect(buildConfirmPatch(draft, edited)).toEqual({
      steps: [
        { position: 1, instruction: "Whisk the dry ingredients." },
        { position: 2, instruction: "Fry until golden on both sides." },
      ],
    });
  });

  it("ignores blank lines before comparing", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [...value.ingredients, { id: "ing_blank", text: "   " }],
      steps: [value.steps[0], { id: "step_blank", text: "" }, value.steps[1]],
    };
    expect(buildConfirmPatch(draft, edited)).toBeUndefined();
  });

  it("a line cleared to blank counts as deleted", () => {
    const value = draftToCardValue(draft);
    const edited = { ...value, ingredients: [value.ingredients[0], { ...value.ingredients[1], text: "" }, value.ingredients[2]] };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toEqual([flour, egg]);
  });
});

describe("clearedFields", () => {
  it("is empty when nothing was cleared", () => {
    expect(clearedFields(draft, draftToCardValue(draft))).toEqual([]);
  });

  it("names fields that had a value and are now blank", () => {
    const edited = { ...draftToCardValue(draft), servings: "  ", prep: "" };
    expect(clearedFields(draft, edited)).toEqual(["servings", "prep time"]);
  });

  it("ignores a blank field the draft never had", () => {
    expect(clearedFields(draft, { ...draftToCardValue(draft), cook: "" })).toEqual([]);
  });
});
