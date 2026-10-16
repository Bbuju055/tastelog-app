import { useMutation } from "@tanstack/react-query";
import { updateRecipeContent } from "../api/endpoints";
import type {
  RecipeContentUpdateRequest,
  RecipeDetailResponse,
} from "../api/schemas";
import type { ApiError } from "../errors";

/**
 * useUpdateRecipe (Issue 3), PURE TRANSPORT.
 *
 * mutationFn returns the parsed RecipeDetailResponse or throws the typed
 * ApiError; NOTHING else lives here. No onSuccess/onError side effects: no
 * haptics, no cache writes, no invalidation, no navigation. The EDIT SCREEN
 * owns every outcome under latest-operation generation ownership (plan
 * section 7.2), a hook-owned effect could fire for a superseded save and
 * escape that ownership, which is exactly the rescue-3 H5 defect class.
 *
 * Deep-import this hook (never via the lib/hooks barrel): screen suites
 * mock the barrel as object literals. Same precedent as useNavigationGuard.
 */

export type UpdateRecipeVariables = {
  recipeId: string;
  body: RecipeContentUpdateRequest;
};

export function useUpdateRecipe() {
  return useMutation<RecipeDetailResponse, ApiError, UpdateRecipeVariables>({
    mutationFn: ({ recipeId, body }) => updateRecipeContent(recipeId, body),
  });
}
