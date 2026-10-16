import { useMutation, useQueryClient } from "@tanstack/react-query";

import { renameGroceryList } from "../api/endpoints";
import {
  GROCERY_LISTS_QUERY_KEY,
  groceryListDetailQueryKey,
} from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type {
  GroceryListResponse,
  GroceryListDetailResponse,
} from "../api/schemas";
import type { ApiError } from "../errors";

type RenameVars = { listId: string; name: string };

type RenameContext = {
  previousLists?: GroceryListResponse[];
  previousDetail?: GroceryListDetailResponse;
};

export function useRenameGroceryList() {
  const queryClient = useQueryClient();

  return useMutation<GroceryListResponse, ApiError, RenameVars, RenameContext>({
    mutationFn: ({ listId, name }) => renameGroceryList(listId, { name }),

    onMutate: async ({ listId, name: rawName }) => {
      const name = rawName.trim();
      await queryClient.cancelQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
      await queryClient.cancelQueries({
        queryKey: groceryListDetailQueryKey(listId),
      });

      const previousLists =
        queryClient.getQueryData<GroceryListResponse[]>(GROCERY_LISTS_QUERY_KEY);
      const previousDetail =
        queryClient.getQueryData<GroceryListDetailResponse>(
          groceryListDetailQueryKey(listId),
        );

      // Optimistic update on list cache
      if (previousLists) {
        queryClient.setQueryData<GroceryListResponse[]>(
          GROCERY_LISTS_QUERY_KEY,
          previousLists.map((l) =>
            l.id === listId ? { ...l, display_name: name } : l,
          ),
        );
      }

      // Optimistic update on detail cache
      if (previousDetail) {
        queryClient.setQueryData<GroceryListDetailResponse>(
          groceryListDetailQueryKey(listId),
          { ...previousDetail, display_name: name },
        );
      }

      return { previousLists, previousDetail };
    },

    onSuccess: () => {
      hapticSuccess();
    },

    onError: (_err, { listId }, context) => {
      hapticWarning();
      if (context?.previousLists) {
        queryClient.setQueryData(GROCERY_LISTS_QUERY_KEY, context.previousLists);
      }
      if (context?.previousDetail) {
        queryClient.setQueryData(
          groceryListDetailQueryKey(listId),
          context.previousDetail,
        );
      }
    },

    onSettled: (_data, _err, { listId }) => {
      queryClient.invalidateQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: groceryListDetailQueryKey(listId),
      });
    },
  });
}
