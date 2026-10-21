/** Structural checks only: nonempty text does not prove source fidelity. */
export function missingRecipeSections(ingredients: string[], instructions: string[]): string[] {
  const missing: string[] = [];
  if (!ingredients.some((text) => text.trim())) missing.push("ingredients");
  if (!instructions.some((text) => text.trim())) missing.push("instructions");
  return missing;
}
