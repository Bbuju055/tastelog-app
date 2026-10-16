/**
 * useUpdateRecipe (Issue 3), the hook is PURE TRANSPORT (plan section
 * 7.2): mutationFn resolves the parsed detail response or rejects with the
 * typed error, and the hook itself performs NO side effects, no cache
 * writes, no invalidation, no haptics. The edit screen owns every outcome
 * under generation ownership.
 */

import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockUpdateRecipeContent = jest.fn();
jest.mock("../../../lib/api/endpoints", () => ({
  updateRecipeContent: (...args: unknown[]) => mockUpdateRecipeContent(...args),
}));

const mockHapticSuccess = jest.fn();
const mockHapticWarning = jest.fn();
jest.mock("../../../lib/haptics/haptics", () => ({
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
  hapticWarning: (...args: unknown[]) => mockHapticWarning(...args),
  hapticTap: jest.fn(),
}));

import { useUpdateRecipe } from "../../../lib/hooks/useUpdateRecipe";
import { ApiError } from "../../../lib/errors";

const BODY = {
  expected_content_rev: 3,
  mutation_id: "00000000-0000-4000-8000-000000000001",
  fields: { title: "Better" },
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
  const setDataSpy = jest.spyOn(queryClient, "setQueryData");
  const removeSpy = jest.spyOn(queryClient, "removeQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, invalidateSpy, setDataSpy, removeSpy };
}

describe("useUpdateRecipe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes variables through to the endpoint and resolves its response", async () => {
    const response = { id: "recipe-1", content_rev: 4 };
    mockUpdateRecipeContent.mockResolvedValueOnce(response);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateRecipe(), { wrapper });

    result.current.mutate({ recipeId: "recipe-1", body: BODY });

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mockUpdateRecipeContent).toHaveBeenCalledWith("recipe-1", BODY);
  });

  it("success performs NO cache writes, NO invalidation, NO haptics", async () => {
    mockUpdateRecipeContent.mockResolvedValueOnce({ id: "recipe-1" });
    const { wrapper, invalidateSpy, setDataSpy, removeSpy } = makeWrapper();
    const { result } = renderHook(() => useUpdateRecipe(), { wrapper });

    result.current.mutate({ recipeId: "recipe-1", body: BODY });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(setDataSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(mockHapticSuccess).not.toHaveBeenCalled();
    expect(mockHapticWarning).not.toHaveBeenCalled();
  });

  it("surfaces the typed ApiError unchanged with no side effects", async () => {
    const conflict = new ApiError({
      message: "conflict",
      kind: "http",
      status: 409,
      detail: { code: "EDIT_CONFLICT" },
    });
    mockUpdateRecipeContent.mockRejectedValueOnce(conflict);
    const { wrapper, invalidateSpy, setDataSpy } = makeWrapper();
    const { result } = renderHook(() => useUpdateRecipe(), { wrapper });

    result.current.mutate({ recipeId: "recipe-1", body: BODY });

    await waitFor(() => expect(result.current.error).toBe(conflict));
    expect(result.current.error?.status).toBe(409);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(setDataSpy).not.toHaveBeenCalled();
    expect(mockHapticWarning).not.toHaveBeenCalled();
  });
});
