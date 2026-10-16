/**
 * Ingredient Classification
 *
 * Classify ingredients into scaling categories based on quantity and unit.
 * Deterministic: same input always produces same output.
 *
 * This module only classifies — no display formatting.
 */

import type { IngredientResponse } from "@/lib/api/schemas";
import type { ParsedQuantity } from "./types";
import { parseQuantity } from "./parseQuantity";

// =============================================================================
// Unit Sets (v1 LOCKED — expand only via new phase)
// =============================================================================

const CONTINUOUS_UNITS = new Set([
  // Volume
  "tsp", "teaspoon", "teaspoons",
  "tbsp", "tablespoon", "tablespoons",
  "cup", "cups",
  "ml", "milliliter", "milliliters",
  "l", "liter", "liters",
  // Weight
  "g", "gram", "grams",
  "kg", "kilogram", "kilograms",
  "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds",
]);

const COUNTED_UNITS = new Set([
  "egg", "eggs",
]);

const CONTAINER_UNITS = new Set([
  "can", "cans",
  "jar", "jars",
  "bottle", "bottles",
  "carton", "cartons",
  "package", "packages", "pkg", "pkgs",
  "box", "boxes",
]);

const QUALIFIER_PHRASES = [
  "to taste",
  "as needed",
  "optional",
  "for garnish",
];

// =============================================================================
// Unit Normalization
// =============================================================================

/**
 * Normalize unit string: trim, lowercase, collapse whitespace, strip trailing periods.
 */
export function normalizeUnit(unit: string | null | undefined): string {
  if (unit == null) return "";
  return unit
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "");
}

// =============================================================================
// Qualifier Detection
// =============================================================================

/**
 * Detect qualifier phrase in quantity, unit, or raw_text.
 * Uses word boundary matching to avoid false positives.
 * Does NOT scan ingredient name.
 *
 * Returns the qualifier text if found, null otherwise.
 */
export function detectQualifier(
  quantity: string | null | undefined,
  unit: string | null | undefined,
  rawText: string | null | undefined
): string | null {
  const sources = [quantity, unit, rawText]
    .filter((s): s is string => s != null && s.trim() !== "")
    .map(s => s.toLowerCase());

  for (const phrase of QUALIFIER_PHRASES) {
    const pattern = new RegExp(`\\b${phrase}\\b`);
    for (const source of sources) {
      if (pattern.test(source)) {
        return phrase;
      }
    }
  }

  return null;
}

// =============================================================================
// Singular Mapping
// =============================================================================

const SINGULAR_MAP: Record<string, string> = {
  cans: "can",
  jars: "jar",
  bottles: "bottle",
  cartons: "carton",
  packages: "package",
  pkgs: "pkg",
  boxes: "box",
  eggs: "egg",
};

function toSingular(unit: string): string {
  return SINGULAR_MAP[unit] ?? unit;
}

// =============================================================================
// Classification
// =============================================================================

/**
 * Classify an ingredient into a scaling category.
 *
 * Algorithm (deterministic):
 * 1. If qualifier phrase detected in quantity/unit/raw_text → qualifier
 * 2. Else if quantity parses AND unit ∈ continuous → numeric
 * 3. Else if quantity parses AND unit ∈ counted → counted
 * 4. Else if quantity parses AND unit ∈ container → container
 * 5. Else → unparsed
 *
 * NOTE: We do NOT infer counted items from name in v1.
 * "2 eggs" where unit="eggs" → counted
 * "2" with name="eggs" → unparsed (no inference)
 */
export function classifyIngredient(ingredient: IngredientResponse): ParsedQuantity {
  const { quantity, unit, raw_text, name } = ingredient;

  // 1. Qualifier (quantity/unit/raw_text ONLY — not name)
  const qualifier = detectQualifier(quantity, unit, raw_text);
  if (qualifier) {
    return { kind: "qualifier", text: qualifier };
  }

  // 2. Parse quantity
  const value = parseQuantity(quantity);
  if (!value) {
    return {
      kind: "unparsed",
      text: raw_text ?? quantity ?? name,
    };
  }

  const normalizedUnit = normalizeUnit(unit);

  // 3. Continuous
  if (normalizedUnit && CONTINUOUS_UNITS.has(normalizedUnit)) {
    return { kind: "numeric", value, unit: normalizedUnit };
  }

  // 4. Counted (v1: eggs only)
  if (normalizedUnit && COUNTED_UNITS.has(normalizedUnit)) {
    return { kind: "counted", value, item: toSingular(normalizedUnit) };
  }

  // 5. Container
  if (normalizedUnit && CONTAINER_UNITS.has(normalizedUnit)) {
    return { kind: "container", value, unitWord: toSingular(normalizedUnit) };
  }

  // 6. Unparsed (unknown unit or no unit)
  return {
    kind: "unparsed",
    text: raw_text ?? quantity ?? name,
  };
}
