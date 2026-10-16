// src/lib/drafts/reviewPatch.ts
/**
 * Draft review adapters.
 *
 * Mirrors the mobile draft screen (tastelog-mobile/app/(app)/draft/[id].tsx):
 * ingredients are edited as one free-text line each, sent back as `raw_text`
 * with the original structured fields, and the API's confirm route normalizes
 * any line whose text no longer matches those fields.
 */

import type { DraftConfirmRequest, DraftResponse, IngredientData, StepData } from "@/lib/api/schemas";

export type EditableLine = { id: string; text: string };

/** Structural match for RecipeCardValue in components/RecipeCard. */
export type DraftCardValue = {
  title: string;
  servings: string;
  prep: string;
  cook: string;
  ingredients: EditableLine[];
  steps: EditableLine[];
};

function formatIngredientLine(ing: IngredientData): string {
  const parts: string[] = [];
  if (ing.quantity) parts.push(ing.quantity);
  if (ing.unit) parts.push(ing.unit);
  if (ing.name) parts.push(ing.name);
  let line = parts.join(" ");
  if (ing.prep) line += `, ${ing.prep}`;
  return line;
}

function ingredientText(ing: IngredientData): string {
  return ing.raw_text ?? formatIngredientLine(ing);
}

export function draftToCardValue(draft: DraftResponse): DraftCardValue {
  return {
    title: draft.title,
    servings: draft.servings ?? "",
    prep: draft.prep_time ?? "",
    cook: draft.cook_time ?? "",
    ingredients: draft.ingredients.map((ing, idx) => ({ id: `ing_${idx}`, text: ingredientText(ing) })),
    steps: draft.steps.map((step, idx) => ({ id: `step_${idx}`, text: step.instruction })),
  };
}

function nonBlank(lines: EditableLine[]): string[] {
  return lines.map((l) => l.text.trim()).filter((t) => t.length > 0);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Only fields that changed; undefined when nothing did. */
export function buildConfirmPatch(original: DraftResponse, edited: DraftCardValue): DraftConfirmRequest | undefined {
  const patch: DraftConfirmRequest = {};

  if (edited.title !== original.title) patch.title = edited.title;
  if (edited.servings !== (original.servings ?? "")) patch.servings = edited.servings || undefined;
  if (edited.prep !== (original.prep_time ?? "")) patch.prep_time = edited.prep || undefined;
  if (edited.cook !== (original.cook_time ?? "")) patch.cook_time = edited.cook || undefined;

  const originalIngredients = original.ingredients.map(ingredientText);
  const editedIngredients = nonBlank(edited.ingredients);
  if (!sameList(originalIngredients, editedIngredients)) {
    patch.ingredients = editedIngredients.map((text, idx): IngredientData => {
      const source = original.ingredients[idx];
      return {
        quantity: source?.quantity ?? null,
        unit: source?.unit ?? null,
        name: source?.name ?? text,
        prep: source?.prep ?? null,
        raw_text: text,
      };
    });
  }

  const originalSteps = original.steps.map((s) => s.instruction);
  const editedSteps = nonBlank(edited.steps);
  if (!sameList(originalSteps, editedSteps)) {
    patch.steps = editedSteps.map((instruction, idx): StepData => ({ position: idx + 1, instruction }));
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}
