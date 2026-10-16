import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createGroceryList } from "../api/endpoints";
import { GROCERY_LISTS_QUERY_KEY } from "../queryKeys";
import { hapticSuccess, hapticWarning } from "../haptics/haptics";
import type { GroceryListResponse } from "../api/schemas";
import type { CreateGroceryListRequest } from "../api/schemas";
import type { ApiError } from "../errors";

export function useCreateGroceryList() {
  const queryClient = useQueryClient();

  return useMutation<GroceryListResponse, ApiError, CreateGroceryListRequest>({
    mutationFn: (body) => createGroceryList(body),
    onSuccess: async () => {
      hapticSuccess();
      await queryClient.invalidateQueries({ queryKey: GROCERY_LISTS_QUERY_KEY });
    },
    onError: () => {
      hapticWarning();
    },
  });
}
