import { useQuery } from "@tanstack/react-query";
import { listRecipes } from "../api/endpoints";
import { RECIPES_QUERY_KEY } from "../queryKeys";
import type { RecipeSearchResult } from "../api/schemas";
import type { ApiError } from "../errors";

export function useRecipes() {
  return useQuery<RecipeSearchResult[], ApiError>({
    queryKey: RECIPES_QUERY_KEY,
    queryFn: () => listRecipes(),
  });
}
