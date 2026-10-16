// Phase 14.2B — env loader and Tier A endpoint constants for k6 scenarios.
// Phase 14.2C — extended to require seed-derived recipe/list/search IDs.
// Tier B / Tier C endpoint constants intentionally deferred to 14.2C / 14.2D.

import { assertLoadTarget } from "./target-guard.js";

function requireEnvName(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${name} is required but missing or empty. Refusing to run.`,
    );
  }
  return value.trim();
}

export function loadEnv() {
  const baseUrl = assertLoadTarget(__ENV.LOADTEST_API_BASE_URL);
  const recipeId = requireEnvName(__ENV.LOADTEST_RECIPE_ID, "LOADTEST_RECIPE_ID");
  const listId = requireEnvName(__ENV.LOADTEST_LIST_ID, "LOADTEST_LIST_ID");
  const searchQuery = requireEnvName(
    __ENV.LOADTEST_SEARCH_QUERY,
    "LOADTEST_SEARCH_QUERY",
  );
  return { baseUrl, recipeId, listId, searchQuery };
}

export const ENDPOINTS = {
  health: "/health",
  recipesList: "/api/recipes",
  recipeDetail: (id) => `/api/recipes/${id}`,
  recipeSearch: (q) => `/api/recipes/search?q=${encodeURIComponent(q)}`,
  groceryLists: "/api/grocery/lists",
  groceryListDetail: (id) => `/api/grocery/lists/${id}`,
  draftsList: "/api/drafts",
  recipeCooks: (id) => `/api/recipes/${id}/cooks`,
  cooksRecent: "/api/cooks/recent",
};
