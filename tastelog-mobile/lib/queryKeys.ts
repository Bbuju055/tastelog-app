/**
 * Centralized React Query keys.
 * Avoids circular imports between components.
 */

export const RECIPES_QUERY_KEY = ["recipes"] as const;
export const TOKENS_QUERY_KEY = ["capture-tokens"] as const;
export function recipeDetailQueryKey(recipeId: string) {
  return [...RECIPES_QUERY_KEY, recipeId] as const;
}
export const DRAFTS_QUERY_KEY = ["drafts"] as const;
export function draftDetailQueryKey(draftId: string) {
  return [...DRAFTS_QUERY_KEY, draftId] as const;
}
export const GROCERY_LISTS_QUERY_KEY = ["grocery-lists"] as const;
export function groceryListDetailQueryKey(listId: string) {
  return ["grocery-lists", listId] as const;
}
export const RECENT_COOKS_QUERY_KEY = ["recent-cooks"] as const;
export function cookEventsQueryKey(recipeId: string) {
  return ["cook-events", recipeId] as const;
}
