import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteGroceryItem } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY, groceryListDetailQueryKey } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { GroceryListDetailResponse } from "../api/schemas";
import type { ApiError } from "../errors";

type DeleteItemVars = { itemId: string; listId: string };

type DeleteItemContext = {
  previous?: GroceryListDetailResponse;
};

export function useDeleteGroceryItem() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, DeleteItemVars, DeleteItemContext>({
    mutationFn: ({ itemId }) => deleteGroceryItem(itemId),

    onMutate: async ({ itemId, listId }) => {
      const queryKey = groceryListDetailQueryKey(listId);
      await queryClient.cancelQueries({ queryKey });
      await queryClient.cancelQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });

      const previous =
        queryClient.getQueryData<GroceryListDetailResponse>(queryKey);

      if (previous) {
        queryClient.setQueryData<GroceryListDetailResponse>(queryKey, {
          ...previous,
          items: previous.items.filter((item) => item.id !== itemId),
        });
      }

      return { previous };
    },

    onError: (_err, { listId }, context) => {
      hapticWarning();
      if (context?.previous) {
        queryClient.setQueryData(
          groceryListDetailQueryKey(listId),
          context.previous,
        );
      }
    },

    onSuccess: () => {
      hapticSuccess();
    },

    onSettled: async (_data, _err, { listId }) => {
      await queryClient.invalidateQueries({
        queryKey: groceryListDetailQueryKey(listId),
      });
      await queryClient.invalidateQueries({
        queryKey: GROCERY_LISTS_QUERY_KEY,
      });
    },
  });
}
