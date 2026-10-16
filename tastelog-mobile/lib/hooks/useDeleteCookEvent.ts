import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteCookEvent } from "../api/endpoints";
import { cookEventsQueryKey, RECENT_COOKS_QUERY_KEY } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { CookEventResponse, RecentCookResponse } from "../api/schemas";
import type { ApiError } from "../errors";

type DeleteCookVars = { cookEventId: string; recipeId: string };

type DeleteCookContext = {
  previousCookEvents?: CookEventResponse[];
  previousRecentCooks?: RecentCookResponse[];
};

export function useDeleteCookEvent() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, DeleteCookVars, DeleteCookContext>({
    mutationFn: ({ cookEventId }) => deleteCookEvent(cookEventId),

    onMutate: async ({ cookEventId, recipeId }) => {
      const eventsKey = cookEventsQueryKey(recipeId);
      await queryClient.cancelQueries({ queryKey: eventsKey });
      await queryClient.cancelQueries({ queryKey: RECENT_COOKS_QUERY_KEY });

      const previousCookEvents =
        queryClient.getQueryData<CookEventResponse[]>(eventsKey);
      const previousRecentCooks =
        queryClient.getQueryData<RecentCookResponse[]>(RECENT_COOKS_QUERY_KEY);

      if (previousCookEvents) {
        queryClient.setQueryData<CookEventResponse[]>(
          eventsKey,
          previousCookEvents.filter((e) => e.id !== cookEventId),
        );
      }

      if (previousRecentCooks) {
        queryClient.setQueryData<RecentCookResponse[]>(
          RECENT_COOKS_QUERY_KEY,
          previousRecentCooks.filter((e) => e.id !== cookEventId),
        );
      }

      return { previousCookEvents, previousRecentCooks };
    },

    onError: (_err, { recipeId }, context) => {
      hapticWarning();
      if (context?.previousCookEvents) {
        queryClient.setQueryData(
          cookEventsQueryKey(recipeId),
          context.previousCookEvents,
        );
      }
      if (context?.previousRecentCooks) {
        queryClient.setQueryData(
          RECENT_COOKS_QUERY_KEY,
          context.previousRecentCooks,
        );
      }
    },

    onSuccess: () => {
      hapticSuccess();
    },

    onSettled: async (_data, _err, { recipeId }) => {
      await queryClient.invalidateQueries({
        queryKey: cookEventsQueryKey(recipeId),
      });
      await queryClient.invalidateQueries({
        queryKey: RECENT_COOKS_QUERY_KEY,
      });
    },
  });
}
