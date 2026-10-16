import React, { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// 15.2.4-CF-RC1 — recipe deletion must clean every Recently Cooked projection.
//
// Real QueryClient; only the endpoint boundary is mocked. Proves the mandated
// order: cancel in-flight recent-cooks work → remove the recipe's cook-event
// cache → filter every recent-cook entry for the deleted recipe → invalidate
// recent cooks (and recipes) so server truth is re-established.
// ---------------------------------------------------------------------------

jest.mock("../../lib/api/endpoints", () => ({
  deleteRecipe: jest.fn(),
}));

// Marker cleanup is requested through the serialized storage helper —
// mocked here so this suite stays a pure cache/ordering test.
jest.mock("../../lib/recentCooks/dismissedRecentCooks", () => ({
  removeDismissedRecentCook: jest.fn(() => Promise.resolve(true)),
}));

import { deleteRecipe } from "../../lib/api/endpoints";
import { removeDismissedRecentCook } from "../../lib/recentCooks/dismissedRecentCooks";
import { useDeleteRecipe } from "../../lib/hooks/useDeleteRecipe";
import {
  RECIPES_QUERY_KEY,
  RECENT_COOKS_QUERY_KEY,
  cookEventsQueryKey,
  recipeDetailQueryKey,
} from "../../lib/queryKeys";
import type {
  CookEventResponse,
  RecentCookResponse,
} from "../../lib/api/schemas";

const mockDeleteRecipe = deleteRecipe as jest.MockedFunction<
  typeof deleteRecipe
>;

const DELETED_RECIPE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RECIPE_ID = "22222222-2222-4222-8222-222222222222";

const RECENT_COOKS: RecentCookResponse[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    recipe_id: DELETED_RECIPE_ID,
    recipe_title: "Sunday Stew",
    cooked_at: "2026-07-14T10:00:00Z",
    rating: 4,
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    recipe_id: OTHER_RECIPE_ID,
    recipe_title: "Miso Soup",
    cooked_at: "2026-07-13T10:00:00Z",
    rating: null,
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    recipe_id: DELETED_RECIPE_ID,
    recipe_title: "Sunday Stew",
    cooked_at: "2026-07-12T10:00:00Z",
    rating: null,
  },
];

const COOK_EVENTS: CookEventResponse[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    recipe_id: DELETED_RECIPE_ID,
    user_id: "99999999-9999-4999-8999-999999999999",
    cooked_at: "2026-07-14T10:00:00Z",
    rating: 4,
    notes: null,
    scale: null,
    created_at: "2026-07-14T10:00:00Z",
  },
];

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useDeleteRecipe — Recently Cooked cache cleanup (15.2.4-CF-RC1)", () => {
  beforeEach(() => {
    mockDeleteRecipe.mockReset();
    (removeDismissedRecentCook as jest.Mock).mockClear();
  });

  test("cancels recent-cooks work before cache surgery, filters the deleted recipe's entries, removes its cook-event cache, and invalidates both caches", async () => {
    const client = makeClient();
    client.setQueryData(RECENT_COOKS_QUERY_KEY, RECENT_COOKS);
    client.setQueryData(cookEventsQueryKey(DELETED_RECIPE_ID), COOK_EVENTS);
    client.setQueryData(recipeDetailQueryKey(DELETED_RECIPE_ID), {
      id: DELETED_RECIPE_ID,
    });

    const cancelSpy = jest.spyOn(client, "cancelQueries");
    const setDataSpy = jest.spyOn(client, "setQueryData");
    const removeSpy = jest.spyOn(client, "removeQueries");
    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    mockDeleteRecipe.mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteRecipe(), {
      wrapper: makeWrapper(client),
    });
    act(() => {
      result.current.mutate(DELETED_RECIPE_ID);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // In-flight recent-cooks work is cancelled BEFORE the cache edit.
    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: RECENT_COOKS_QUERY_KEY,
    });
    const cancelOrder = cancelSpy.mock.invocationCallOrder[0];
    const recentCooksWriteIndex = setDataSpy.mock.calls.findIndex(
      ([key]) => key === RECENT_COOKS_QUERY_KEY,
    );
    expect(recentCooksWriteIndex).toBeGreaterThanOrEqual(0);
    const writeOrder =
      setDataSpy.mock.invocationCallOrder[recentCooksWriteIndex];
    expect(cancelOrder).toBeLessThan(writeOrder);
    // Cancellation is step 1 — ahead of ALL cache surgery, including the
    // removeQueries calls.
    expect(cancelOrder).toBeLessThan(removeSpy.mock.invocationCallOrder[0]);

    // Every event for the deleted recipe is filtered; unrelated recipes remain.
    expect(client.getQueryData(RECENT_COOKS_QUERY_KEY)).toEqual([
      RECENT_COOKS[1],
    ]);

    // The deleted recipe's cook-event and detail caches are removed.
    expect(removeSpy).toHaveBeenCalledWith({
      queryKey: cookEventsQueryKey(DELETED_RECIPE_ID),
    });
    expect(
      client.getQueryData(cookEventsQueryKey(DELETED_RECIPE_ID)),
    ).toBeUndefined();
    expect(
      client.getQueryData(recipeDetailQueryKey(DELETED_RECIPE_ID)),
    ).toBeUndefined();

    // Server truth is re-established: recent cooks AND recipes invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: RECENT_COOKS_QUERY_KEY,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: RECIPES_QUERY_KEY,
    });

    // Device-local dismissal-marker cleanup is requested for the deleted
    // recipe (fire-and-forget — must not gate the cache work above).
    expect(removeDismissedRecentCook).toHaveBeenCalledTimes(1);
    expect(removeDismissedRecentCook).toHaveBeenCalledWith(DELETED_RECIPE_ID);
  });

  test("leaves an unseeded recent-cooks cache absent (updater no-op) while still invalidating", async () => {
    const client = makeClient();
    mockDeleteRecipe.mockResolvedValue(undefined);
    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useDeleteRecipe(), {
      wrapper: makeWrapper(client),
    });
    act(() => {
      result.current.mutate(DELETED_RECIPE_ID);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(RECENT_COOKS_QUERY_KEY)).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: RECENT_COOKS_QUERY_KEY,
    });
  });

  test("on server error, caches are untouched and nothing is invalidated (existing error behavior preserved)", async () => {
    const client = makeClient();
    client.setQueryData(RECENT_COOKS_QUERY_KEY, RECENT_COOKS);
    client.setQueryData(cookEventsQueryKey(DELETED_RECIPE_ID), COOK_EVENTS);

    const invalidateSpy = jest.spyOn(client, "invalidateQueries");
    mockDeleteRecipe.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useDeleteRecipe(), {
      wrapper: makeWrapper(client),
    });
    act(() => {
      result.current.mutate(DELETED_RECIPE_ID);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData(RECENT_COOKS_QUERY_KEY)).toEqual(RECENT_COOKS);
    expect(
      client.getQueryData(cookEventsQueryKey(DELETED_RECIPE_ID)),
    ).toEqual(COOK_EVENTS);
    expect(invalidateSpy).not.toHaveBeenCalled();
    // A failed deletion never touches dismissal markers.
    expect(removeDismissedRecentCook).not.toHaveBeenCalled();
  });
});
