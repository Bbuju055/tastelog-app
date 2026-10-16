import { useQuery } from "@tanstack/react-query";
import { getCookEvents } from "../api/endpoints";
import { cookEventsQueryKey } from "../queryKeys";
import type { CookEventResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useCookEvents(recipeId: string | undefined) {
  return useQuery<CookEventResponse[], ApiError>({
    queryKey: cookEventsQueryKey(recipeId ?? "missing"),
    queryFn: () => {
      if (!recipeId) throw new Error("Missing recipeId");
      return getCookEvents(recipeId);
    },
    enabled: !!recipeId,
  });
}
