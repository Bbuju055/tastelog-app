import { useQuery } from "@tanstack/react-query";
import { getDraft } from "../api/endpoints";
import { draftDetailQueryKey } from "../queryKeys";
import type { DraftResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useDraft(draftId: string | undefined) {
  return useQuery<DraftResponse, ApiError>({
    queryKey: draftDetailQueryKey(draftId ?? "__missing__"),
    queryFn: () => getDraft(draftId as string),
    enabled: !!draftId,
  });
}
