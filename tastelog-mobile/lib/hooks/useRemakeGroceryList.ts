import { useMutation, useQueryClient } from "@tanstack/react-query";

import { remakeGroceryList } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { GroceryRemakeResponse, RemakeRequest } from "../api/schemas";
import type { ApiError } from "../errors";

export function useRemakeGroceryList() {
  const queryClient = useQueryClient();

  return useMutation<GroceryRemakeResponse, ApiError, RemakeRequest>({
    mutationFn: (body) => remakeGroceryList(body),
    onSuccess: async () => {
      hapticSuccess();
      await queryClient.invalidateQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
