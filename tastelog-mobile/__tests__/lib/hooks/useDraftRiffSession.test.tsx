/**
 * Phase 13.9 Slice G — useDraftRiffSession parity + draft-specific behavior.
 *
 * Tests follow useRiffSession.test.tsx conventions (proxied env mock,
 * jest.mock on lib/api/riff to capture helper calls, renderHook with a
 * QueryClientProvider wrapper).
 *
 * Recipe-anchored useRiffSession tests are unaffected — they mock the
 * recipe helpers; we mock the draft helpers separately. The two test
 * suites do not share fixtures or interfere.
 */

import React, { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockEnv = {
  EXPO_PUBLIC_API_BASE_URL: "http://test.local",
  EXPO_PUBLIC_WEB_BASE_URL: undefined,
  EXPO_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  EXPO_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  EXPO_PUBLIC_SENTRY_DSN: "",
  EXPO_PUBLIC_RIFF_STREAMING: false,
};

jest.mock("../../../lib/config", () => ({
  env: new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (mockEnv as Record<string, unknown>)[prop];
      },
    },
  ),
}));

jest.mock("../../../lib/api/riff", () => ({
  postDraftRiffTurn: jest.fn(),
  postDraftRiffSave: jest.fn(),
  streamDraftRiffTurn: jest.fn(),
}));

import {
  postDraftRiffSave,
  postDraftRiffTurn,
  streamDraftRiffTurn,
  type RiffStreamCallbacks,
} from "../../../lib/api/riff";
import { useDraftRiffSession } from "../../../lib/hooks/useDraftRiffSession";
import { ApiError } from "../../../lib/errors";

const mockPostDraftRiffTurn = postDraftRiffTurn as jest.MockedFunction<
  typeof postDraftRiffTurn
>;
const mockPostDraftRiffSave = postDraftRiffSave as jest.MockedFunction<
  typeof postDraftRiffSave
>;
const mockStreamDraftRiffTurn = streamDraftRiffTurn as jest.MockedFunction<
  typeof streamDraftRiffTurn
>;

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useDraftRiffSession (sync path)", () => {
  beforeEach(() => {
    mockPostDraftRiffTurn.mockReset();
    mockPostDraftRiffSave.mockReset();
    mockStreamDraftRiffTurn.mockReset();
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = false;
  });

  it("calls postDraftRiffTurn with /api/drafts anchor and conditional-spread body", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Adapt for dairy-free");
    });

    await waitFor(() => {
      expect(mockPostDraftRiffTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockPostDraftRiffTurn).toHaveBeenCalledWith({
      draftId: "draft-1",
      message: "Adapt for dairy-free",
    });
  });

  it("reuses the session_id returned by the first turn", async () => {
    mockPostDraftRiffTurn
      .mockResolvedValueOnce({
        session_id: "sess-draft-xyz",
        assistant_message: "first",
      })
      .mockResolvedValueOnce({
        session_id: "sess-draft-xyz",
        assistant_message: "second",
      });

    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("First");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-draft-xyz");
    });

    act(() => {
      result.current.sendMessage("Second");
    });
    await waitFor(() => {
      expect(mockPostDraftRiffTurn).toHaveBeenCalledTimes(2);
    });

    expect(mockPostDraftRiffTurn).toHaveBeenNthCalledWith(2, {
      draftId: "draft-1",
      message: "Second",
      sessionId: "sess-draft-xyz",
    });
  });

  it("rolls back the optimistic user message on error", async () => {
    mockPostDraftRiffTurn.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Will fail");
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).not.toBeNull();
  });

  it("forwards entryPoint to postDraftRiffTurn when provided", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
    const { result } = renderHook(
      () => useDraftRiffSession("draft-1", { entryPoint: "draft_review" }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Adapt it");
    });

    await waitFor(() => {
      expect(mockPostDraftRiffTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockPostDraftRiffTurn).toHaveBeenCalledWith({
      draftId: "draft-1",
      message: "Adapt it",
      entryPoint: "draft_review",
    });
  });

  it("surfaces backend dict-detail error codes (DRAFT_EXPIRED) on the error field", async () => {
    const apiErr = new ApiError({
      kind: "http",
      status: 404,
      message: "Draft expired.",
      detail: { code: "DRAFT_EXPIRED", message: "Draft expired." },
    });
    mockPostDraftRiffTurn.mockRejectedValue(apiErr);

    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Adapt it");
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe(apiErr);
    expect((result.current.error?.detail as { code?: string })?.code).toBe(
      "DRAFT_EXPIRED",
    );
  });
});

describe("useDraftRiffSession (save flow)", () => {
  const generatedRecipe = {
    title: "Dairy-Free",
    servings: null,
    prep_time: null,
    cook_time: null,
    confidence: 1.0,
    ingredients: [],
    steps: [],
  } as Record<string, unknown>;

  beforeEach(() => {
    mockPostDraftRiffTurn.mockReset();
    mockPostDraftRiffSave.mockReset();
    mockStreamDraftRiffTurn.mockReset();
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = false;
  });

  it("calls postDraftRiffSave with mapped args and invokes onSaveSuccess on 2xx", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "Here you go.",
      assistant_message_id: "msg-1",
      generated_recipe: generatedRecipe,
    });
    mockPostDraftRiffSave.mockResolvedValue({ recipe_id: "rec-new" });

    const onSaveSuccess = jest.fn();
    const { result } = renderHook(
      () => useDraftRiffSession("draft-1", { onSaveSuccess }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-1");
    });

    act(() => {
      result.current.saveRecipe("msg-1", "Dairy-Free");
    });

    await waitFor(() => {
      expect(mockPostDraftRiffSave).toHaveBeenCalledTimes(1);
    });
    expect(mockPostDraftRiffSave).toHaveBeenCalledWith({
      draftId: "draft-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      riffLabel: "Dairy-Free",
    });
    await waitFor(() => {
      expect(result.current.savedMessageIds.has("msg-1")).toBe(true);
    });
    expect(onSaveSuccess).toHaveBeenCalledWith("rec-new");
    expect(result.current.saveError).toBeNull();
  });

  it("translates 409 ALREADY_SAVED into a graceful success (onSaveSuccess fires, saveError is null)", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "Here you go.",
      assistant_message_id: "msg-1",
      generated_recipe: generatedRecipe,
    });
    // Backend signals idempotency: session was already migrated to
    // recipe-anchored by an earlier save. The hook must treat this as
    // graceful success at the consumer surface.
    const conflict = new ApiError({
      kind: "http",
      status: 409,
      message: "Already saved.",
      detail: { code: "ALREADY_SAVED", recipe_id: "rec-existing" },
    });
    mockPostDraftRiffSave.mockRejectedValue(conflict);

    const onSaveSuccess = jest.fn();
    const { result } = renderHook(
      () => useDraftRiffSession("draft-1", { onSaveSuccess }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-1");
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });

    await waitFor(() => {
      expect(result.current.savedMessageIds.has("msg-1")).toBe(true);
    });
    expect(onSaveSuccess).toHaveBeenCalledWith("rec-existing");
    // 409 → saveError masked to null (business-level success).
    expect(result.current.saveError).toBeNull();
  });

  it("propagates non-ALREADY_SAVED save failures through saveError", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "...",
      assistant_message_id: "msg-1",
      generated_recipe: generatedRecipe,
    });
    const expired = new ApiError({
      kind: "http",
      status: 404,
      message: "Draft expired.",
      detail: { code: "DRAFT_EXPIRED", message: "Draft expired." },
    });
    mockPostDraftRiffSave.mockRejectedValue(expired);

    const onSaveSuccess = jest.fn();
    const { result } = renderHook(
      () => useDraftRiffSession("draft-1", { onSaveSuccess }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-1");
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });

    // Wait on saveError settling, not on isSaving === false: isSaving
    // starts as false (mutation idle), so a naïve waitFor on isSaving
    // can exit before the mutation has even kicked in.
    await waitFor(() => {
      expect(result.current.saveError).toBe(expired);
    });
    // Non-409 error: saveError NOT masked. savedMessageIds NOT populated.
    // onSaveSuccess NOT called.
    expect(result.current.savedMessageIds.has("msg-1")).toBe(false);
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  it("drops concurrent saveRecipe calls while a save is pending", async () => {
    mockPostDraftRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "...",
      assistant_message_id: "msg-1",
      generated_recipe: generatedRecipe,
    });
    let resolveSave: ((value: { recipe_id: string }) => void) | undefined;
    mockPostDraftRiffSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-1");
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });
    await waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });
    expect(mockPostDraftRiffSave).toHaveBeenCalledTimes(1);

    act(() => {
      resolveSave?.({ recipe_id: "rec-new" });
    });
    await waitFor(() => {
      expect(result.current.isSaving).toBe(false);
    });
  });
});

describe("useDraftRiffSession (streaming mode)", () => {
  let capturedCallbacks: RiffStreamCallbacks | null;
  let mockCancelHandle: jest.Mock;

  beforeEach(() => {
    mockPostDraftRiffTurn.mockReset();
    mockPostDraftRiffSave.mockReset();
    mockStreamDraftRiffTurn.mockReset();
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = true;
    capturedCallbacks = null;
    mockCancelHandle = jest.fn();
    mockStreamDraftRiffTurn.mockImplementation(async (args) => {
      capturedCallbacks = args.callbacks;
      return { cancel: mockCancelHandle };
    });
  });

  afterEach(() => {
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = false;
  });

  it("calls streamDraftRiffTurn with the /api/drafts anchor", async () => {
    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });

    await waitFor(() => {
      expect(mockStreamDraftRiffTurn).toHaveBeenCalledTimes(1);
    });
    const callArg = mockStreamDraftRiffTurn.mock.calls[0]![0];
    expect(callArg.draftId).toBe("draft-1");
    expect(callArg.message).toBe("Hi");
    expect(callArg).not.toHaveProperty("entryPoint");
  });

  it("streams the golden path through draft helpers", async () => {
    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });

    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(result.current.isStreaming).toBe(true);

    await waitFor(() => {
      expect(mockStreamDraftRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "Sure thing.", seq: 0 });
      cb.onAssistantComplete({ assistant_message_id: "asst-1" });
      cb.onDone();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.sessionId).toBe("sess-1");
    expect(result.current.messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "Sure thing.",
        id: "asst-1",
        generatedRecipe: null,
      },
    ]);
  });

  it("supports cancel-during-open via the same race-guard path as useRiffSession", async () => {
    let resolveStreamPromise:
      | ((handle: { cancel: () => void }) => void)
      | undefined;
    mockStreamDraftRiffTurn.mockReset();
    mockCancelHandle = jest.fn();
    mockStreamDraftRiffTurn.mockImplementation((args) => {
      capturedCallbacks = args.callbacks;
      return new Promise((resolve) => {
        resolveStreamPromise = resolve;
      });
    });

    const { result } = renderHook(() => useDraftRiffSession("draft-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.isStreaming).toBe(false);
    expect(mockCancelHandle).not.toHaveBeenCalled();

    await act(async () => {
      resolveStreamPromise!({ cancel: mockCancelHandle });
    });

    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });
});
