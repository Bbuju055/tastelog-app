import { useQuery } from "@tanstack/react-query";

import { listGroceryLists } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY } from "../queryKeys";
import type { GroceryListResponse } from "../api/schemas";
import type { ApiError } from "../errors";

/**
 * Lightweight read-only hook for grocery list summaries.
 *
 * Shares the same query key as useGrocery — no duplicate fetches.
 * Use when you need list count / names without the full grocery
 * detail/toggle machinery.
 */
export function useGroceryLists() {
  const query = useQuery<GroceryListResponse[], ApiError>({
    queryKey: GROCERY_LISTS_QUERY_KEY,
    queryFn: () => listGroceryLists(),
  });

  return {
    lists: query.data ?? [],
    isLoading: query.isLoading,
  };
}
