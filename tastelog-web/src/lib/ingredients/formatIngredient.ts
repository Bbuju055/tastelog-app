/**
 * Ingredient Formatting
 *
 * Format scaled ingredients for display.
 * Pure functions: same input always produces same output.
 */

import type { IngredientResponse } from "@/lib/api/schemas";
import type { Rational, ScaleResult } from "./types";
import { toDisplayString, isOne } from "./rational";

// ====================================================================
// Pluralization Maps (v1 — minimal, locked)
// ====================================================================

const PLURAL_MAP: Record<string, string> = {
  can: "cans",
  jar: "jars",
  bottle: "bottles",
  carton: "cartons",
  package: "packages",
  pkg: "pkgs",
  box: "boxes",
  egg: "eggs",

  // continuous units we support in v1
  teaspoon: "teaspoons",
  tablespoon: "tablespoons",
  cup: "cups",
  gram: "grams",
  kilogram: "kilograms",
  ounce: "ounces",
  pound: "pounds",
  liter: "liters",
  milliliter: "milliliters",
};

const SINGULAR_ALIASES: Record<string, string> = {
  tsp: "teaspoon",
  teaspoons: "teaspoon",
  tbsp: "tablespoon",
  tablespoons: "tablespoon",
  cups: "cup",
  grams: "gram",
  kilograms: "kilogram",
  ounces: "ounce",
  pounds: "pound",
  lbs: "pound",
  liters: "liter",
  milliliters: "milliliter",
};

// ====================================================================
// Display Data Types
// ====================================================================

export type FormattedIngredient = {
  /** Main text: "2 cups flour" or "salt" */
  readonly main: string;
  /** Prep suffix: "sifted" or null */
  readonly prep: string | null;
  /** Annotation: "(rounded)" or "(to taste)" or null */
  readonly annotation: string | null;
  /** Whether to show "not scaled" badge (only when factor ≠ 1) */
  readonly showNotScaled: boolean;
};

// ====================================================================
// Pluralization
// ====================================================================

/** Normalize unit to a canonical singular form when possible (v1 only) */
function toCanonicalSingular(unit: string): string {
  const u = unit.trim().toLowerCase();
  return SINGULAR_ALIASES[u] ?? u;
}

/**
 * Pluralize a unit word based on quantity.
 * Returns singular for quantity = 1, plural otherwise.
 */
export function pluralize(unit: string, value: Rational): string {
  const singular = toCanonicalSingular(unit);

  if (value.n === 1n && value.d === 1n) {
    return singular;
  }
  return PLURAL_MAP[singular] ?? unit;
}

// ====================================================================
// Formatting
// ====================================================================

export function formatIngredient(
  result: ScaleResult,
  ingredient: IngredientResponse,
  factor: Rational
): FormattedIngredient {
  const { name, prep } = ingredient;
  const factorIsOne = isOne(factor);

  if (result.kind === "unscaled") {
    if (result.reason === "qualifier") {
      const q = getQualifierText(ingredient);
      return {
        main: name,
        prep,
        annotation: q ? `(${q})` : null,
        showNotScaled: false,
      };
    }

    // unparsed
    return {
      main: formatOriginalText(ingredient),
      prep,
      annotation: null,
      showNotScaled: !factorIsOne,
    };
  }

  const { scaled, meta } = result;

  switch (scaled.kind) {
    case "numeric": {
      const qty = toDisplayString(scaled.value);
      const unit = pluralize(scaled.unit, scaled.value);
      return {
        main: `${qty} ${unit} ${name}`.trim(),
        prep,
        annotation: null,
        showNotScaled: false,
      };
    }

    case "container": {
      const qty = toDisplayString(scaled.value);
      const unit = pluralize(scaled.unitWord, scaled.value);
      return {
        main: `${qty} ${unit} ${name}`.trim(),
        prep,
        annotation: null,
        showNotScaled: false,
      };
    }

    case "counted": {
      const qty = toDisplayString(scaled.value);
      const unit = pluralize(scaled.item, scaled.value);
      const wasRounded = meta?.rounded === true;
      return {
        main: `${qty} ${unit} ${name}`.trim(),
        prep,
        annotation: wasRounded ? "(rounded)" : null,
        showNotScaled: false,
      };
    }
  }
}

// ====================================================================
// Helpers
// ====================================================================

function getQualifierText(ingredient: IngredientResponse): string | null {
  const { quantity, unit, raw_text } = ingredient;
  const sources = [quantity, unit, raw_text]
    .filter((s): s is string => s != null && s.trim() !== "")
    .map(s => s.toLowerCase());

  const qualifiers = ["to taste", "as needed", "optional", "for garnish"];
  for (const phrase of qualifiers) {
    const pattern = new RegExp(`\\b${phrase}\\b`);
    for (const source of sources) {
      if (pattern.test(source)) return phrase;
    }
  }
  return null;
}

function formatOriginalText(ingredient: IngredientResponse): string {
  const { quantity, unit, name, raw_text } = ingredient;
  if (raw_text) return raw_text;

  const parts = [quantity, unit, name].filter(
    (p): p is string => p != null && String(p).trim() !== ""
  );
  return parts.join(" ");
}
