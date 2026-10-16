import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteGroceryList } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY, groceryListDetailQueryKey } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { ApiError } from "../errors";

export function useDeleteGroceryList() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, string>({
    mutationFn: (listId) => deleteGroceryList(listId),
    onSuccess: async (_data, listId) => {
      hapticSuccess();
      queryClient.removeQueries({ queryKey: groceryListDetailQueryKey(listId) });
      await queryClient.invalidateQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
