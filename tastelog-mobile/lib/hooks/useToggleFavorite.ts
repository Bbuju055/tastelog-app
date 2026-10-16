import { useMutation, useQueryClient } from "@tanstack/react-query";

import { patchRecipeFavorite } from "../api/endpoints";
import { RECIPES_QUERY_KEY, recipeDetailQueryKey } from "../queryKeys";
import { hapticTap, hapticWarning } from "../haptics/haptics";
import type { RecipeDetailResponse, RecipeSearchResult } from "../api/schemas";
import type { ApiError } from "../errors";

type ToggleFavoriteVars = {
  recipeId: string;
  favorite: boolean;
};

type OptimisticSnapshot = {
  previousList: RecipeSearchResult[] | undefined;
  previousDetail: RecipeDetailResponse | undefined;
};

export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation<RecipeDetailResponse, ApiError, ToggleFavoriteVars, OptimisticSnapshot>({
    mutationFn: ({ recipeId, favorite }) =>
      patchRecipeFavorite(recipeId, { favorite }),
    onMutate: async ({ recipeId, favorite }) => {
      const detailKey = recipeDetailQueryKey(recipeId);

      await Promise.all([
        queryClient.cancelQueries({ queryKey: RECIPES_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: detailKey }),
      ]);

      const previousList = queryClient.getQueryData<RecipeSearchResult[]>(RECIPES_QUERY_KEY);
      const previousDetail = queryClient.getQueryData<RecipeDetailResponse>(detailKey);

      queryClient.setQueryData<RecipeSearchResult[]>(RECIPES_QUERY_KEY, (old) =>
        old?.map((r) => (r.id === recipeId ? { ...r, favorite } : r)),
      );

      if (previousDetail) {
        queryClient.setQueryData<RecipeDetailResponse>(detailKey, {
          ...previousDetail,
          favorite,
        });
      }

      hapticTap();

      return { previousList, previousDetail };
    },
    onError: (_err, { recipeId }, context) => {
      if (context?.previousList !== undefined) {
        queryClient.setQueryData(RECIPES_QUERY_KEY, context.previousList);
      }
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(recipeDetailQueryKey(recipeId), context.previousDetail);
      }
      hapticWarning();
    },
    onSettled: (_data, _err, { recipeId }) => {
      void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: recipeDetailQueryKey(recipeId) });
    },
  });
}
