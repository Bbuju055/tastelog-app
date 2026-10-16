/**
 * Build user-facing toast message after adding items to a grocery list.
 *
 * Rules:
 *   - No merges    → "Added X items to {list}"
 *   - Some merges  → "Added X items to {list} (Y merged)"
 *   - All merged   → "All items already in {list} — quantities updated"
 */
export function getMergeToastMessage(
  listName: string,
  itemsAdded: number,
  itemsMerged: number,
): string {
  if (itemsMerged > 0 && itemsMerged === itemsAdded) {
    return `All items already in ${listName} \u2014 quantities updated`;
  }

  const itemLabel = itemsAdded === 1 ? "item" : "items";

  if (itemsMerged > 0) {
    return `Added ${itemsAdded} ${itemLabel} to ${listName} (${itemsMerged} merged)`;
  }

  return `Added ${itemsAdded} ${itemLabel} to ${listName}`;
}
