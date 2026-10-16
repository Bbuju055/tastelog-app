import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logCookEvent } from "../api/endpoints";
import { cookEventsQueryKey, RECENT_COOKS_QUERY_KEY } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { CookEventResponse, RecentCookResponse } from "../api/schemas";
import type { ApiError } from "../errors";

type LogCookVars = {
  recipeId: string;
  recipeTitle: string;
  userId: string;
  rating?: number;
  notes?: string;
  scale?: string;
};

type LogCookContext = {
  previousCookEvents?: CookEventResponse[];
  previousRecentCooks?: RecentCookResponse[];
};

/**
 * Generate a temporary UUID for optimistic inserts.
 * Replaced by the real server-assigned ID on refetch.
 */
function tempUUID(): string {
  return "00000000-0000-0000-0000-" + Date.now().toString(16).padStart(12, "0");
}

export function useLogCook() {
  const queryClient = useQueryClient();

  return useMutation<CookEventResponse, ApiError, LogCookVars, LogCookContext>({
    mutationFn: ({ recipeId, rating, notes, scale }) =>
      logCookEvent(recipeId, {
        ...(rating !== undefined ? { rating } : {}),
        ...(notes ? { notes } : {}),
        ...(scale ? { scale } : {}),
      }),

    onMutate: async (vars) => {
      const eventsKey = cookEventsQueryKey(vars.recipeId);
      await queryClient.cancelQueries({ queryKey: eventsKey });
      await queryClient.cancelQueries({ queryKey: RECENT_COOKS_QUERY_KEY });

      const previousCookEvents =
        queryClient.getQueryData<CookEventResponse[]>(eventsKey);
      const previousRecentCooks =
        queryClient.getQueryData<RecentCookResponse[]>(RECENT_COOKS_QUERY_KEY);

      const now = new Date().toISOString();
      const id = tempUUID();

      // Optimistic insert into cook events (full shape)
      const optimisticEvent: CookEventResponse = {
        id,
        recipe_id: vars.recipeId,
        user_id: vars.userId,
        cooked_at: now,
        rating: vars.rating ?? null,
        notes: vars.notes ?? null,
        scale: vars.scale ?? null,
        created_at: now,
      };

      queryClient.setQueryData<CookEventResponse[]>(eventsKey, (old) => [
        optimisticEvent,
        ...(old ?? []),
      ]);

      // Optimistic insert into recent cooks (lightweight shape)
      const optimisticRecent: RecentCookResponse = {
        id,
        recipe_id: vars.recipeId,
        recipe_title: vars.recipeTitle,
        cooked_at: now,
        rating: vars.rating ?? null,
      };

      queryClient.setQueryData<RecentCookResponse[]>(
        RECENT_COOKS_QUERY_KEY,
        (old) => [optimisticRecent, ...(old ?? [])],
      );

      return { previousCookEvents, previousRecentCooks };
    },

    onError: (_err, vars, context) => {
      hapticWarning();
      if (context?.previousCookEvents) {
        queryClient.setQueryData(
          cookEventsQueryKey(vars.recipeId),
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

    onSettled: async (_data, _err, vars) => {
      await queryClient.invalidateQueries({
        queryKey: cookEventsQueryKey(vars.recipeId),
      });
      await queryClient.invalidateQueries({
        queryKey: RECENT_COOKS_QUERY_KEY,
      });
    },
  });
}
