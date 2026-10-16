import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteRecipe } from "../api/endpoints";
import {
  RECIPES_QUERY_KEY,
  RECENT_COOKS_QUERY_KEY,
  cookEventsQueryKey,
  recipeDetailQueryKey,
} from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import { removeDismissedRecentCook } from "../recentCooks/dismissedRecentCooks";
import type { RecentCookResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useDeleteRecipe() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, string>({
    mutationFn: (recipeId) => deleteRecipe(recipeId),
    onSuccess: async (_data, recipeId) => {
      hapticSuccess();
      // Device-local dismissal-marker cleanup — fire-and-forget through the
      // serialized storage queue; the helper resolves false on failure and
      // never rejects, so this cannot delay navigation or throw.
      void removeDismissedRecentCook(recipeId);
      // Cancel any in-flight recent-cooks fetch BEFORE cache surgery — a
      // response that started before the server delete could otherwise land
      // after the filter below and restore the deleted recipe's card.
      await queryClient.cancelQueries({ queryKey: RECENT_COOKS_QUERY_KEY });
      queryClient.removeQueries({ queryKey: recipeDetailQueryKey(recipeId) });
      queryClient.removeQueries({ queryKey: cookEventsQueryKey(recipeId) });
      queryClient.setQueryData<RecentCookResponse[]>(
        RECENT_COOKS_QUERY_KEY,
        (previous) => previous?.filter((cook) => cook.recipe_id !== recipeId),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: RECENT_COOKS_QUERY_KEY }),
      ]);
    },
    onError: () => {
      hapticWarning();
    },
  });
}
