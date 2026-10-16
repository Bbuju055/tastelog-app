/**
 * Grocery Override Items
 *
 * Derives grocery item overrides from the current scaled ingredient state.
 * Returns undefined when scaling is inactive, preserving base behavior.
 *
 * This module bridges the scaling engine output to the grocery creation
 * request contract. It does NOT recompute scaling — it maps already-computed
 * ScaleResult values into the shape the backend expects.
 */

import type { IngredientResponse } from "../api/schemas";
import type { Rational, ScaleResult } from "./types";
import { isOne, toDisplayString } from "./rational";
import { pluralize } from "./formatIngredient";

// ====================================================================
// Types
// ====================================================================

export type GroceryOverrideItem = {
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: string | null;
  /** Substitution-provenance label carried from ingredient prep, else null. */
  readonly note: string | null;
};

export type ScaledIngredientEntry = {
  readonly ingredient: IngredientResponse;
  readonly result: ScaleResult;
};

// ====================================================================
// Public API
// ====================================================================

/**
 * Returns true when the user intended to add scaled ingredients but
 * the builder produced no valid items. The caller MUST block the
 * mutation and show an error — never silently fall back to unscaled.
 */
export function shouldBlockScaledAdd(
  scaleFactor: Rational | null,
  items: GroceryOverrideItem[] | undefined,
): boolean {
  const isScaled = scaleFactor != null && !isOne(scaleFactor);
  return isScaled && (!items || items.length === 0);
}

/**
 * Build grocery override items from the current scaling state.
 *
 * Returns an items array only when ALL of the following are true:
 * - scaleFactor is non-null (scaling input is valid)
 * - scaleFactor is not 1 (user actually changed the serving count)
 * - there are ingredients to map
 * - at least one mapped item has a valid name
 *
 * Returns undefined in two distinct cases:
 * 1. Scaling is inactive (null factor, factor=1, no entries) — caller
 *    should use the default server-side ingredient fetch.
 * 2. Scaling is active but ALL items were filtered (empty names) —
 *    caller MUST treat this as an error and block the request.
 *
 * The caller distinguishes these by checking its own scaling intent
 * (scaleFactor != null && !isOne(scaleFactor)) before interpreting
 * an undefined return.
 */
export function buildGroceryOverrideItems(
  entries: readonly ScaledIngredientEntry[],
  scaleFactor: Rational | null,
): GroceryOverrideItem[] | undefined {
  if (scaleFactor == null) return undefined;
  if (isOne(scaleFactor)) return undefined;
  if (entries.length === 0) return undefined;

  const items = entries.map(({ ingredient, result }) =>
    mapToGroceryItem(ingredient, result),
  );

  // Defensive guard — avoid inserting empty/invalid items
  const valid = items.filter((item) => item.name && item.name.trim().length > 0);

  return valid.length > 0 ? valid : undefined;
}

// ====================================================================
// Internal
// ====================================================================

/**
 * Normalize a nullable string at the boundary: "" → null, undefined → null.
 * Used ONLY here — not exported, not reused elsewhere.
 */
function normalizeNullableString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const NOTE_PREFIX = "in place of";

/**
 * Derive a grocery provenance note from an ingredient prep field.
 *
 * Mirrors the backend rule (`_note_from_prep`, api/core/grocery.py): prep
 * is carried ONLY when, after trimming and removal of AT MOST one
 * fully-surrounding parenthesis pair, it begins case-insensitively with
 * the exact phrase "in place of " (trailing space included) AND the
 * remaining target text is non-empty after trimming (the Riff
 * substitution-label convention). Malformed labels ("in place ofX",
 * empty-target "in place of") and ordinary preparation text (diced,
 * sliced, packed, ...) yield null. Returns the trimmed, paren-stripped
 * label — original casing preserved. The shared contract is pinned by the
 * OD-1 parity tables in this file's test and tests/test_grocery.py.
 */
function noteFromPrep(prep: string | null | undefined): string | null {
  if (prep == null) return null;
  let text = prep.trim();
  if (text.length >= 2 && text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  if (!text.toLowerCase().startsWith(NOTE_PREFIX + " ")) {
    return null;
  }
  if (text.slice(NOTE_PREFIX.length + 1).trim() === "") {
    return null;
  }
  return text;
}

function mapToGroceryItem(
  ingredient: IngredientResponse,
  result: ScaleResult,
): GroceryOverrideItem {
  const note = noteFromPrep(ingredient.prep);

  // Unscaled items (qualifiers, unparsed) keep original values
  if (result.kind === "unscaled") {
    return {
      name: ingredient.name,
      quantity: normalizeNullableString(ingredient.quantity),
      unit: normalizeNullableString(ingredient.unit),
      note,
    };
  }

  const { scaled } = result;

  switch (scaled.kind) {
    case "numeric":
      return {
        name: ingredient.name,
        quantity: normalizeNullableString(toDisplayString(scaled.value)),
        unit: normalizeNullableString(pluralize(scaled.unit, scaled.value)),
        note,
      };

    case "container":
      return {
        name: ingredient.name,
        quantity: normalizeNullableString(toDisplayString(scaled.value)),
        unit: normalizeNullableString(pluralize(scaled.unitWord, scaled.value)),
        note,
      };

    case "counted":
      return {
        name: ingredient.name,
        quantity: normalizeNullableString(toDisplayString(scaled.value)),
        unit: normalizeNullableString(pluralize(scaled.item, scaled.value)),
        note,
      };
  }
}
