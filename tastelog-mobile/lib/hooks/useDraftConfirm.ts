import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmDraft, deleteDraft } from "../api/endpoints";
import { DRAFTS_QUERY_KEY, RECIPES_QUERY_KEY, draftDetailQueryKey } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { DraftConfirmRequest, RecipeDetailResponse } from "../api/schemas";
import type { ApiError } from "../errors";

type ConfirmVars = { draftId: string; patch?: DraftConfirmRequest };

export function useDraftConfirm() {
  const queryClient = useQueryClient();

  return useMutation<RecipeDetailResponse, ApiError, ConfirmVars>({
    mutationFn: ({ draftId, patch }) => confirmDraft(draftId, patch),
    // 15.2 Gate A (F2): the success haptic is owned by SuccessBeat — the
    // confirm flow always mounts it. (useDraftDelete below keeps its own
    // haptic: Discard has no beat.)
    onSuccess: async (_data, vars) => {
      // New recipe should appear in list immediately.
      await queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });

      // Draft is gone; update pending drafts list and remove detail cache.
      await queryClient.invalidateQueries({ queryKey: DRAFTS_QUERY_KEY });
      await queryClient.removeQueries({ queryKey: draftDetailQueryKey(vars.draftId) });
    },
    onError: () => {
      hapticWarning();
    },
  });
}

export function useDraftDelete() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, string>({
    mutationFn: (draftId) => deleteDraft(draftId),
    onSuccess: async (_data, draftId) => {
      hapticSuccess();
      await queryClient.invalidateQueries({ queryKey: DRAFTS_QUERY_KEY });
      await queryClient.removeQueries({ queryKey: draftDetailQueryKey(draftId) });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
