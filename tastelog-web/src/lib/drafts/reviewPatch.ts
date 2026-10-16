// src/lib/drafts/reviewPatch.ts
/**
 * Draft review adapters.
 *
 * Mirrors the mobile draft screen (tastelog-mobile/app/(app)/draft/[id].tsx):
 * ingredients are edited as one free-text line each. On confirm, an
 * untouched row is sent back exactly as the draft had it (so the API keeps
 * its structured quantity/unit/prep); an edited or new row is sent as a
 * truthful unstructured row (name = raw_text = the line). The API's confirm
 * route (api/core/step_mapping.py normalize_edited_ingredients) pairs rows
 * by position, so shipping stale structured fields next to new text could
 * survive a delete-and-edit at equal count; sending the collapsed form
 * ourselves makes the result identical on every branch. Rows are matched
 * by line id, not position, so deleting, inserting or reordering lines
 * never mislabels a neighbour.
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

function lineId(prefix: "ing" | "step", index: number): string {
  return `${prefix}_${index}`;
}

function formatIngredientLine(ing: IngredientData): string {
  if (ing.raw_text) return ing.raw_text;
  const parts: string[] = [];
  if (ing.quantity) parts.push(ing.quantity);
  if (ing.unit) parts.push(ing.unit);
  if (ing.name) parts.push(ing.name);
  let line = parts.join(" ");
  if (ing.prep) line += `, ${ing.prep}`;
  return line;
}

export function draftToCardValue(draft: DraftResponse): DraftCardValue {
  return {
    title: draft.title,
    servings: draft.servings ?? "",
    prep: draft.prep_time ?? "",
    cook: draft.cook_time ?? "",
    ingredients: draft.ingredients.map((ing, idx) => ({ id: lineId("ing", idx), text: formatIngredientLine(ing) })),
    steps: draft.steps.map((step, idx) => ({ id: lineId("step", idx), text: step.instruction })),
  };
}

/** Lines with text, trimmed; blank lines are ignored everywhere. */
function nonBlank(lines: EditableLine[]): EditableLine[] {
  return lines.map((l) => ({ id: l.id, text: l.text.trim() })).filter((l) => l.text.length > 0);
}

/** The API's ingredient payload has no position and forbids extra fields. */
function ingredientPayload(ing: IngredientData): IngredientData {
  return {
    quantity: ing.quantity ?? null,
    unit: ing.unit ?? null,
    name: ing.name,
    prep: ing.prep ?? null,
    raw_text: ing.raw_text ?? null,
  };
}

function ingredientsPatch(original: IngredientData[], edited: EditableLine[]): IngredientData[] | undefined {
  const originalById = new Map(original.map((ing, idx) => [lineId("ing", idx), ing]));
  const unchanged =
    edited.length === original.length &&
    edited.every((line, idx) => {
      const source = originalById.get(line.id);
      return source === original[idx] && line.text === formatIngredientLine(source);
    });
  if (unchanged) return undefined;

  return edited.map((line) => {
    const source = originalById.get(line.id);
    if (source && line.text === formatIngredientLine(source)) return ingredientPayload(source);
    return { quantity: null, unit: null, name: line.text, prep: null, raw_text: line.text };
  });
}

function stepsPatch(original: StepData[], edited: EditableLine[]): StepData[] | undefined {
  const texts = edited.map((l) => l.text);
  const unchanged = texts.length === original.length && texts.every((t, idx) => t === original[idx].instruction);
  if (unchanged) return undefined;
  return texts.map((instruction, idx) => ({ position: idx + 1, instruction }));
}

/**
 * Fields the user emptied that the draft had a value for. Confirm cannot
 * clear them (the confirm RPC COALESCEs a null override onto the draft, so
 * no client can clear a field today; mobile has the same limit), so the form
 * refuses to confirm while any are listed instead of silently keeping the
 * old value.
 */
export function clearedFields(original: DraftResponse, edited: DraftCardValue): string[] {
  const cleared: string[] = [];
  if (original.servings && !edited.servings.trim()) cleared.push("servings");
  if (original.prep_time && !edited.prep.trim()) cleared.push("prep time");
  if (original.cook_time && !edited.cook.trim()) cleared.push("cook time");
  return cleared;
}

/** Only fields that changed; undefined when nothing did. Cleared fields are never sent: see clearedFields. */
export function buildConfirmPatch(original: DraftResponse, edited: DraftCardValue): DraftConfirmRequest | undefined {
  const patch: DraftConfirmRequest = {};

  if (edited.title !== original.title) patch.title = edited.title;
  if (edited.servings && edited.servings !== (original.servings ?? "")) patch.servings = edited.servings;
  if (edited.prep && edited.prep !== (original.prep_time ?? "")) patch.prep_time = edited.prep;
  if (edited.cook && edited.cook !== (original.cook_time ?? "")) patch.cook_time = edited.cook;

  const ingredients = ingredientsPatch(original.ingredients, nonBlank(edited.ingredients));
  if (ingredients) patch.ingredients = ingredients;

  const steps = stepsPatch(original.steps, nonBlank(edited.steps));
  if (steps) patch.steps = steps;

  return Object.keys(patch).length > 0 ? patch : undefined;
}
