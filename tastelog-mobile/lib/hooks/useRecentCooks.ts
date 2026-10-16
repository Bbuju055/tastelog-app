import { useQuery } from "@tanstack/react-query";
import { getRecentCooks } from "../api/endpoints";
import { RECENT_COOKS_QUERY_KEY } from "../queryKeys";
import type { RecentCookResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useRecentCooks() {
  return useQuery<RecentCookResponse[], ApiError>({
    queryKey: [...RECENT_COOKS_QUERY_KEY],
    queryFn: () => getRecentCooks(10),
  });
}
