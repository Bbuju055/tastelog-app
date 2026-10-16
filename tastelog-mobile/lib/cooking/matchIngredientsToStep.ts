/**
 * Ingredient → Step Matching
 *
 * Pure, strict-match function used by Cooking Mode to determine which
 * ingredients are referenced in the current step's instruction.
 *
 * Matching rules (locked, Phase 9.A):
 * - Lowercase normalize both sides
 * - Tokenize on non-alphanumeric boundaries (achieves word-boundary semantics
 *   more robustly than \b regex, which is quirky around punctuation)
 * - Minimal plural normalization: strip longest trailing "ies" | "es" | "s"
 *   per token, applied to both the ingredient and the instruction before
 *   comparison. Known limitation: "cherries" -> "cherr" does NOT match
 *   "cherry" -> "cherry". Acceptable per spec — we do NOT claim full
 *   plural support.
 * - An ingredient matches a step if its normalized token sequence appears
 *   as a contiguous subsequence of the instruction's normalized tokens.
 *   (e.g. "olive oil" only matches a step containing both tokens adjacent,
 *   never "oil" alone.)
 * - NO compound fallback. NO head-noun fallback.
 * - Correctness > coverage: false negatives are invisible, false positives
 *   destroy trust.
 *
 * Preserves input order of matched ingredients.
 *
 * Known limitation: ASCII tokenizer. Non-ASCII ingredient names
 * (e.g. "jalapeño", "crème") will tokenize poorly. Flagged for follow-up
 * if it becomes a real user issue.
 */

import type { IngredientResponse } from "../api/schemas";

const PLURAL_SUFFIXES = ["ies", "es", "s"] as const;
const TOKEN_SPLIT = /[^a-z0-9]+/;

function stemToken(token: string): string {
  for (const suffix of PLURAL_SUFFIXES) {
    if (token.length > suffix.length && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0)
    .map(stemToken);
}

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0) return false;
  if (needle.length > haystack.length) return false;
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function matchIngredientsToStep(
  ingredients: readonly IngredientResponse[],
  instruction: string,
): IngredientResponse[] {
  if (ingredients.length === 0 || instruction.trim() === "") return [];
  const instructionTokens = tokenize(instruction);
  if (instructionTokens.length === 0) return [];

  const matched: IngredientResponse[] = [];
  for (const ing of ingredients) {
    const nameTokens = tokenize(ing.name);
    if (nameTokens.length === 0) continue;
    if (containsSequence(instructionTokens, nameTokens)) {
      matched.push(ing);
    }
  }
  return matched;
}
