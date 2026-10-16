import type { GroceryItemResponse } from "../api/schemas";

/**
 * Phase 13.8 — Build the deterministic prefilled draft message for a
 * Grocery Substitute Riff. V1 is name-only by approved scope; quantity
 * and unit are intentionally omitted to avoid awkward copy on common
 * cases. The user edits the draft before Send.
 */
export function buildSubstituteDraft(item: GroceryItemResponse): string {
  return `What can I substitute for ${item.name} in this recipe?`;
}
