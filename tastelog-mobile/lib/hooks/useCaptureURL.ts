import { useMutation, useQueryClient } from "@tanstack/react-query";
import { captureURL } from "../api/endpoints";
import { hapticWarning } from "../haptics/haptics";
import type { DraftResponse } from "../api/schemas";
import type { ApiError } from "../errors";
import { DRAFTS_QUERY_KEY } from "../queryKeys";

export function useCaptureURL() {
  const queryClient = useQueryClient();
  // idempotencyKey: minted by the screen when the URL is typed and kept until
  // it changes, so re-submitting the same URL replays the same attempt.
  return useMutation<DraftResponse, ApiError, { url: string; idempotencyKey: string }>({
    mutationFn: ({ url, idempotencyKey }) => captureURL(url, idempotencyKey),
    // 15.2 Gate A (F2): the success haptic is owned by SuccessBeat — the
    // visible acknowledgment every successful capture mounts.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DRAFTS_QUERY_KEY });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
