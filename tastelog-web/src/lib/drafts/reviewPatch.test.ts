// src/lib/drafts/reviewPatch.test.ts
import { describe, expect, it } from "vitest";
import { buildConfirmPatch, draftToCardValue } from "@/lib/drafts/reviewPatch";
import type { DraftResponse } from "@/lib/api/schemas";

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
    { position: 1, quantity: "2", unit: "cups", name: "flour", prep: "sifted", raw_text: null },
    { position: 2, quantity: null, unit: null, name: "salt", prep: null, raw_text: "salt to taste" },
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
    expect(value.ingredients.map((l) => l.text)).toEqual(["2 cups flour, sifted", "salt to taste"]);
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

  it("sends servings, prep and cook when edited, omitting cleared fields", () => {
    const edited = { ...draftToCardValue(draft), servings: "2", prep: "", cook: "15 min" };
    expect(buildConfirmPatch(draft, edited)).toEqual({ servings: "2", cook_time: "15 min" });
  });

  it("sends the full ingredient list with the edited line as raw_text, keeping original fields", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [{ ...value.ingredients[0], text: "3 cups flour, sifted" }, value.ingredients[1]],
    };
    expect(buildConfirmPatch(draft, edited)).toEqual({
      ingredients: [
        { quantity: "2", unit: "cups", name: "flour", prep: "sifted", raw_text: "3 cups flour, sifted" },
        { quantity: null, unit: null, name: "salt", prep: null, raw_text: "salt to taste" },
      ],
    });
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

  it("includes added lines and drops blank ones", () => {
    const value = draftToCardValue(draft);
    const edited = {
      ...value,
      ingredients: [...value.ingredients, { id: "ing_new", text: "1 egg" }, { id: "ing_blank", text: "   " }],
      steps: [value.steps[0], { id: "step_blank", text: "" }, value.steps[1]],
    };
    const patch = buildConfirmPatch(draft, edited);
    expect(patch?.ingredients?.map((i) => i.raw_text)).toEqual(["2 cups flour, sifted", "salt to taste", "1 egg"]);
    expect(patch?.ingredients?.[2]).toEqual({ quantity: null, unit: null, name: "1 egg", prep: null, raw_text: "1 egg" });
    // Blank lines are ignored before comparing, so the steps are unchanged.
    expect(patch?.steps).toBeUndefined();
  });

  it("treats removing a line as a change", () => {
    const value = draftToCardValue(draft);
    const edited = { ...value, ingredients: [value.ingredients[0]] };
    expect(buildConfirmPatch(draft, edited)?.ingredients).toHaveLength(1);
  });
});
