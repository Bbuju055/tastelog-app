import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listGroceryLists,
  getGroceryList,
  patchGroceryItem,
} from "../api/endpoints";
import {
  GROCERY_LISTS_QUERY_KEY,
  groceryListDetailQueryKey,
} from "../queryKeys";
import type {
  GroceryListResponse,
  GroceryListDetailResponse,
  GroceryItemResponse,
} from "../api/schemas";
import type { ApiError } from "../errors";

type ToggleVars = { itemId: string; checked: boolean };

type ToggleContext = {
  previous?: GroceryListDetailResponse;
  queryKey: ReturnType<typeof groceryListDetailQueryKey>;
};

export function useGrocery() {
  const queryClient = useQueryClient();
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [userSelected, setUserSelected] = useState(false);

  // Fetch all lists (sorted by updated_at desc from backend)
  const listsQuery = useQuery<GroceryListResponse[], ApiError>({
    queryKey: GROCERY_LISTS_QUERY_KEY,
    queryFn: () => listGroceryLists(),
  });

  const lists = listsQuery.data ?? [];
  const firstListId = lists[0]?.id ?? null;

  // Auto-sync to newest list unless the user has manually picked one.
  // Clear userSelected when the selected list no longer exists (deleted).
  useEffect(() => {
    if (userSelected && activeListId) {
      const stillExists = lists.some((l) => l.id === activeListId);
      if (!stillExists) {
        setUserSelected(false);
        setActiveListId(firstListId);
      }
    } else {
      setActiveListId(firstListId);
    }
  }, [firstListId, lists, userSelected, activeListId]);

  const selectList = useCallback((listId: string) => {
    setUserSelected(true);
    setActiveListId(listId);
  }, []);

  const isDetailEnabled = activeListId !== null;

  // Fetch detail (items) for the active list
  const detailQuery = useQuery<GroceryListDetailResponse, ApiError>({
    queryKey: groceryListDetailQueryKey(activeListId!),
    queryFn: () => getGroceryList(activeListId!),
    enabled: isDetailEnabled,
  });

  // Optimistic toggle mutation with typed context
  const toggleMutation = useMutation<
    GroceryItemResponse,
    ApiError,
    ToggleVars,
    ToggleContext
  >({
    mutationFn: ({ itemId, checked }) =>
      patchGroceryItem(itemId, { checked }),

    onMutate: async ({ itemId, checked }) => {
      const queryKey = groceryListDetailQueryKey(activeListId!);
      await queryClient.cancelQueries({ queryKey });

      const previous =
        queryClient.getQueryData<GroceryListDetailResponse>(queryKey);

      if (previous) {
        queryClient.setQueryData<GroceryListDetailResponse>(queryKey, {
          ...previous,
          items: previous.items.map((item) =>
            item.id === itemId ? { ...item, checked } : item,
          ),
        });
      }

      return { previous, queryKey };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },

    onSettled: () => {
      if (activeListId) {
        queryClient.invalidateQueries({
          queryKey: groceryListDetailQueryKey(activeListId),
        });
      }
    },
  });

  const toggleItem = useCallback(
    (itemId: string, checked: boolean) => {
      if (!activeListId) return;
      toggleMutation.mutate({ itemId, checked });
    },
    [activeListId, toggleMutation.mutate],
  );

  return {
    lists,
    activeListId,
    selectList,
    activeList: detailQuery.data ?? null,
    items: detailQuery.data?.items ?? [],
    isLoading: listsQuery.isLoading || (isDetailEnabled && detailQuery.isLoading),
    error: listsQuery.error ?? detailQuery.error ?? null,
    refetch: useCallback(async () => {
      await listsQuery.refetch();
      if (activeListId) await detailQuery.refetch();
    }, [listsQuery, detailQuery, activeListId]),
    toggleItem,
    toggleError: toggleMutation.error,
  };
}
