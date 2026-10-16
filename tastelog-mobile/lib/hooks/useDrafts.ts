import { useQuery } from "@tanstack/react-query";
import { listDrafts } from "../api/endpoints";
import { DRAFTS_QUERY_KEY } from "../queryKeys";
import type { DraftResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useDrafts() {
  return useQuery<DraftResponse[], ApiError>({
    queryKey: DRAFTS_QUERY_KEY,
    queryFn: () => listDrafts(),
  });
}
