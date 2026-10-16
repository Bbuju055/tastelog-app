// Phase 14.2B / 14.2C — Tier A cheap-read scenario.
// Skeleton only. NOT to be executed in Phase 14.2B/C.
// Execution belongs to Phase 14.2E (dry-run) after seed populates IDs.

import http from "k6/http";
import { check, sleep } from "k6";
import { loadEnv, ENDPOINTS } from "../lib/config.js";
import { bearerHeader, requireJwtFromEnv } from "../lib/auth.js";

export const options = {
  vus: 25,
  duration: "1m",
};

export function setup() {
  const env = loadEnv();
  const jwt = requireJwtFromEnv();
  return {
    baseUrl: env.baseUrl,
    jwt,
    recipeId: env.recipeId,
    listId: env.listId,
    searchQuery: env.searchQuery,
  };
}

export default function (data) {
  const { baseUrl, jwt, recipeId, listId, searchQuery } = data;
  const headers = bearerHeader(jwt);

  const requests = [
    { name: "health", path: ENDPOINTS.health, authed: false },
    { name: "recipesList", path: ENDPOINTS.recipesList, authed: true },
    {
      name: "recipeDetail",
      path: ENDPOINTS.recipeDetail(recipeId),
      authed: true,
    },
    {
      name: "recipeSearch",
      path: ENDPOINTS.recipeSearch(searchQuery),
      authed: true,
    },
    { name: "groceryLists", path: ENDPOINTS.groceryLists, authed: true },
    {
      name: "groceryListDetail",
      path: ENDPOINTS.groceryListDetail(listId),
      authed: true,
    },
    { name: "draftsList", path: ENDPOINTS.draftsList, authed: true },
    {
      name: "recipeCooks",
      path: ENDPOINTS.recipeCooks(recipeId),
      authed: true,
    },
    { name: "cooksRecent", path: ENDPOINTS.cooksRecent, authed: true },
  ];

  for (const req of requests) {
    const res = http.get(`${baseUrl}${req.path}`, {
      headers: req.authed ? headers : {},
      tags: { endpoint: req.name },
    });
    check(res, {
      [`${req.name} 2xx`]: (r) => r.status >= 200 && r.status < 300,
    });
  }

  sleep(1);
}
