/**
 * Quantity Parsing
 *
 * Parse quantity strings into exact Rational values.
 * Conservative: only parse well-defined patterns, return null for anything ambiguous.
 *
 * Ported from tastelog-web/src/lib/ingredients/parseQuantity.ts — behavior-identical.
 */

import type { Rational } from "./types";
import { make } from "./rational";

// Unicode fraction map
const UNICODE_FRACTIONS: Record<string, Rational> = {
  "\u00BD": make(1n, 2n),
  "\u2153": make(1n, 3n),
  "\u2154": make(2n, 3n),
  "\u00BC": make(1n, 4n),
  "\u00BE": make(3n, 4n),
  "\u2155": make(1n, 5n),
  "\u2156": make(2n, 5n),
  "\u2157": make(3n, 5n),
  "\u2158": make(4n, 5n),
  "\u2159": make(1n, 6n),
  "\u215A": make(5n, 6n),
  "\u215B": make(1n, 8n),
  "\u215C": make(3n, 8n),
  "\u215D": make(5n, 8n),
  "\u215E": make(7n, 8n),
};

// Patterns (no flags, applied to trimmed input)
const INTEGER_PATTERN = /^(\d+)$/;
const DECIMAL_PATTERN = /^(\d+)\.(\d+)$/;
const FRACTION_PATTERN = /^(\d+)\/(\d+)$/;
const MIXED_PATTERN = /^(\d+)\s+(\d+)\/(\d+)$/;

/**
 * Parse a quantity string into a Rational.
 * Returns null if the string cannot be parsed deterministically.
 *
 * Supported formats:
 * - Integer: "2"
 * - Decimal: "1.5", "0.75"
 * - Fraction: "1/2", "3/4"
 * - Mixed: "1 1/2", "2 3/4"
 * - Unicode: "\u00BD", "\u00BC", "1\u00BD"
 *
 * Rejected (returns null):
 * - Negative numbers
 * - Ranges: "1-2", "2 to 3"
 * - Approximations: "about 2", "~3", "2-ish"
 * - Text: "some", "a few", "pinch"
 * - Empty or whitespace-only
 */
export function parseQuantity(input: string | null | undefined): Rational | null {
  if (input == null) return null;

  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Reject negative numbers (recipe quantities are never negative)
  if (trimmed.startsWith("-")) return null;

  // Check for unicode fraction (single char or integer + unicode)
  const unicodeResult = parseWithUnicode(trimmed);
  if (unicodeResult !== null) return unicodeResult;

  // Integer: "2", "10"
  const intMatch = trimmed.match(INTEGER_PATTERN);
  if (intMatch) {
    return make(BigInt(intMatch[1]));
  }

  // Decimal: "1.5", "0.75"
  const decMatch = trimmed.match(DECIMAL_PATTERN);
  if (decMatch) {
    const wholePart = decMatch[1];
    const fracPart = decMatch[2];
    const denominator = 10n ** BigInt(fracPart.length);
    const numerator = BigInt(wholePart) * denominator + BigInt(fracPart);
    return make(numerator, denominator);
  }

  // Fraction: "1/2", "3/4"
  const fracMatch = trimmed.match(FRACTION_PATTERN);
  if (fracMatch) {
    const num = BigInt(fracMatch[1]);
    const den = BigInt(fracMatch[2]);
    if (den === 0n) return null;
    return make(num, den);
  }

  // Mixed: "1 1/2", "2 3/4"
  const mixedMatch = trimmed.match(MIXED_PATTERN);
  if (mixedMatch) {
    const whole = BigInt(mixedMatch[1]);
    const num = BigInt(mixedMatch[2]);
    const den = BigInt(mixedMatch[3]);
    if (den === 0n) return null;
    // Reject improper fraction part in mixed number (e.g., "1 5/4")
    if (num >= den) return null;
    // Convert to improper fraction: whole + num/den = (whole*den + num) / den
    return make(whole * den + num, den);
  }

  // No pattern matched
  return null;
}

/**
 * Handle unicode fractions, optionally preceded by an integer.
 * Examples: "\u00BD", "1\u00BD", "1 \u00BD"
 */
function parseWithUnicode(input: string): Rational | null {
  const s = input.trim();
  if (s === "") return null;

  // Pure unicode fraction (single character)
  if (s.length === 1) {
    const frac = UNICODE_FRACTIONS[s];
    return frac ?? null;
  }

  // Integer + unicode fraction: "1\u00BD" or "1 \u00BD"
  const last = s[s.length - 1];
  const frac = UNICODE_FRACTIONS[last];
  if (!frac) return null;

  const before = s.slice(0, -1).trim();
  if (!INTEGER_PATTERN.test(before)) return null;

  const whole = BigInt(before);
  return make(whole * frac.d + frac.n, frac.d);
}
