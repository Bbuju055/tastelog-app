/**
 * Scaling Engine
 *
 * Scale ingredients by a rational factor.
 * Pure function: same input always produces same output.
 */

import type { IngredientResponse } from "@/lib/api/schemas";
import type { Rational, ScaleResult, ParsedQuantity } from "./types";
import { classifyIngredient } from "./classifyIngredient";
import { mul, roundHalfUp, make, cmp } from "./rational";

function assertValidFactor(factor: Rational): void {
  // Must be > 0
  if (factor.d <= 0n) {
    throw new Error("Scale factor must have a positive denominator");
  }
  if (factor.n <= 0n) {
    throw new Error("Scale factor must be > 0");
  }
}

/**
 * Scale an ingredient by a factor.
 *
 * Rules by category:
 * - numeric: value × factor (exact)
 * - container: value × factor (exact, fractions allowed)
 * - counted: roundHalfUp(value × factor), annotate if rounded
 * - qualifier: unscaled
 * - unparsed: unscaled
 */
export function scaleIngredient(
  ingredient: IngredientResponse,
  factor: Rational
): ScaleResult {
  assertValidFactor(factor);
  const parsed = classifyIngredient(ingredient);
  return scaleByCategory(parsed, factor);
}

/**
 * Apply scaling rules based on parsed quantity category.
 */
function scaleByCategory(parsed: ParsedQuantity, factor: Rational): ScaleResult {
  switch (parsed.kind) {
    case "numeric": {
      const scaledValue = mul(parsed.value, factor);
      return {
        kind: "scaled",
        scaled: { kind: "numeric", value: scaledValue, unit: parsed.unit },
      };
    }

    case "container": {
      const scaledValue = mul(parsed.value, factor);
      return {
        kind: "scaled",
        scaled: { kind: "container", value: scaledValue, unitWord: parsed.unitWord },
      };
    }

    case "counted": {
      const exactValue = mul(parsed.value, factor);
      const roundedInt = roundHalfUp(exactValue);
      const roundedValue = make(roundedInt);

      const wasRounded = cmp(exactValue, roundedValue) !== 0;

      return {
        kind: "scaled",
        scaled: { kind: "counted", value: roundedValue, item: parsed.item },
        meta: wasRounded ? { rounded: true } : undefined,
      };
    }

    case "qualifier":
      return { kind: "unscaled", reason: "qualifier" };

    case "unparsed":
      return { kind: "unscaled", reason: "unparsed" };
  }
}
