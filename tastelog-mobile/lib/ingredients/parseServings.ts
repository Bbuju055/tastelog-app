/**
 * Servings Parser
 *
 * Parse freeform servings text into a numeric value.
 * Strict: only parse clearly structured patterns, return null for anything ambiguous.
 *
 * Accepted:
 * - "4"           -> 4
 * - "4 servings"  -> 4
 * - "4 serving"   -> 4
 * - "Serves 6"    -> 6
 * - "Makes 12"    -> 12
 *
 * Rejected (returns null):
 * - "2-3"         (range)
 * - "about 4"     (approximation)
 * - "6 portions"  (unrecognized word)
 * - ""            (empty)
 * - null/undefined
 */

// "4" or "12"
const BARE_NUMBER = /^(\d+)$/;

// "4 servings", "4 serving"
const NUMBER_THEN_WORD = /^(\d+)\s+servings?$/i;

// "Serves 6", "Makes 12"
const WORD_THEN_NUMBER = /^(?:serves|makes)\s+(\d+)$/i;

/**
 * Parse a servings string into an integer.
 * Returns null if the string cannot be parsed deterministically.
 */
export function parseServings(input: string | null | undefined): number | null {
  if (input == null) return null;

  const trimmed = input.trim();
  if (trimmed === "") return null;

  // "4"
  const bareMatch = trimmed.match(BARE_NUMBER);
  if (bareMatch) {
    const n = parseInt(bareMatch[1], 10);
    return n > 0 ? n : null;
  }

  // "4 servings"
  const numberWordMatch = trimmed.match(NUMBER_THEN_WORD);
  if (numberWordMatch) {
    const n = parseInt(numberWordMatch[1], 10);
    return n > 0 ? n : null;
  }

  // "Serves 6"
  const wordNumberMatch = trimmed.match(WORD_THEN_NUMBER);
  if (wordNumberMatch) {
    const n = parseInt(wordNumberMatch[1], 10);
    return n > 0 ? n : null;
  }

  return null;
}
