/**
 * Generate a date-based default name for a new grocery list.
 *
 * Format: "March 22 list"
 * Collision: "March 22 list (2)", "March 22 list (3)", etc.
 *
 * @param existingNames - display_name values of current lists (for collision check)
 * @param now - injectable date for testing (defaults to current date)
 */
export function defaultListName(
  existingNames: string[],
  now: Date = new Date(),
): string {
  const month = now.toLocaleString("en-US", { month: "long" });
  const day = now.getDate();
  const base = `${month} ${day} list`;
  const baseNormalized = base.toLowerCase();

  const normalized = existingNames.map((n) => n.trim().toLowerCase());

  if (!normalized.includes(baseNormalized)) {
    return base;
  }

  let suffix = 2;
  while (normalized.includes(`${baseNormalized} (${suffix})`)) {
    suffix++;
  }

  return `${base} (${suffix})`;
}
