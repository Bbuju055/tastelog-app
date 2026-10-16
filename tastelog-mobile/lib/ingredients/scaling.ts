/**
 * Scaling Helpers
 *
 * High-level helpers that combine servings parsing with Rational scale factor
 * derivation. Used by the recipe detail screen and Cooking Mode to turn a
 * user-entered "desired servings" value into a validated scale factor.
 *
 * Re-exports `parseServings` for callers that only need the scaling primitives
 * (single import surface).
 */

import { make, ONE } from "./rational";
import type { Rational } from "./types";

export { parseServings } from "./parseServings";

const DIGITS_ONLY = /^\d+$/;

/**
 * Derive a Rational scale factor from a base serving count and a user-entered
 * desired servings string.
 *
 * Returns null if:
 * - base is missing or non-positive
 * - desiredText is empty, contains non-digit characters, or parses to <= 0
 *
 * Returns `ONE` when desired equals base (short-circuit to avoid constructing
 * a rational that reduces to 1/1).
 */
export function deriveScaleFactor(
  base: number | null,
  desiredText: string,
): Rational | null {
  if (base == null || base <= 0) return null;
  const trimmed = desiredText.trim();
  if (trimmed === "" || !DIGITS_ONLY.test(trimmed)) return null;
  const desired = parseInt(trimmed, 10);
  if (desired <= 0) return null;
  if (desired === base) return ONE;
  return make(BigInt(desired), BigInt(base));
}
