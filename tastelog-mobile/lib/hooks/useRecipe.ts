import { useQuery } from "@tanstack/react-query";
import { getRecipe } from "../api/endpoints";
import { recipeDetailQueryKey } from "../queryKeys";
import type { RecipeDetailResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useRecipe(recipeId: string | undefined) {
  return useQuery<RecipeDetailResponse, ApiError>({
    queryKey: recipeDetailQueryKey(recipeId ?? "missing"),
    queryFn: () => {
      if (!recipeId) throw new Error("Missing recipeId");
      return getRecipe(recipeId);
    },
    enabled: !!recipeId,
  });
}
