import { useMutation, useQueryClient } from "@tanstack/react-query";

import { addManualGroceryItem } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY, groceryListDetailQueryKey } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { AddManualItemRequest, GroceryRemakeResponse } from "../api/schemas";
import type { ApiError } from "../errors";

export function useAddManualItem() {
  const queryClient = useQueryClient();

  return useMutation<GroceryRemakeResponse, ApiError, AddManualItemRequest>({
    mutationFn: (body) => addManualGroceryItem(body),
    onSuccess: async (data) => {
      hapticSuccess();
      await queryClient.invalidateQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
      await queryClient.invalidateQueries({
        queryKey: groceryListDetailQueryKey(data.list.id),
      });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
