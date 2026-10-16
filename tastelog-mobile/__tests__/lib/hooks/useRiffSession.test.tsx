import React, { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// `mockEnv` is mutated per-test to flip the streaming flag without
// reloading modules. The "mock" prefix on the local variable is
// required by Jest's static analysis for jest.mock() factories that
// reference variables defined in the same file.
const mockEnv = {
  EXPO_PUBLIC_API_BASE_URL: "http://test.local",
  EXPO_PUBLIC_WEB_BASE_URL: undefined,
  EXPO_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  EXPO_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  EXPO_PUBLIC_SENTRY_DSN: "",
  EXPO_PUBLIC_RIFF_STREAMING: false,
};

jest.mock("../../../lib/config", () => ({
  // Proxy defers each property read to test runtime, AFTER mockEnv has
  // been assigned. A direct `env: mockEnv` reference doesn't work because
  // jest.mock factories execute during the module require chain, which
  // happens BEFORE the const mockEnv assignment runs (Babel hoists imports
  // above top-level declarations). Reading env.X via Proxy.get correctly
  // sees the initialized mockEnv at test runtime.
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
  postRiffTurn: jest.fn(),
  postRiffSave: jest.fn(),
  streamRiffTurn: jest.fn(),
}));

import {
  postRiffSave,
  postRiffTurn,
  streamRiffTurn,
  type RiffStreamCallbacks,
} from "../../../lib/api/riff";
import { ApiError } from "../../../lib/errors";
import { useRiffSession } from "../../../lib/hooks/useRiffSession";

const mockPostRiffTurn = postRiffTurn as jest.MockedFunction<typeof postRiffTurn>;
const mockPostRiffSave = postRiffSave as jest.MockedFunction<typeof postRiffSave>;
const mockStreamRiffTurn = streamRiffTurn as jest.MockedFunction<
  typeof streamRiffTurn
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

describe("useRiffSession", () => {
  beforeEach(() => {
    mockPostRiffTurn.mockReset();
    mockPostRiffSave.mockReset();
    mockStreamRiffTurn.mockReset();
    // Default to sync path. Streaming-mode describe block flips this true.
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = false;
  });

  it("optimistically appends the user message on send", () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Make it spicier");
    });

    expect(result.current.messages).toEqual([
      { role: "user", content: "Make it spicier" },
    ]);
  });

  it("appends the assistant message on success", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "Use chili oil.",
    });
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Make it spicier");
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });
    expect(result.current.messages[1]).toEqual({
      role: "assistant",
      content: "Use chili oil.",
      // 13.2: hook always populates generatedRecipe (?? null) on assistant
      // messages. id is undefined here because the mock returns a 13.1-era
      // payload (no assistant_message_id) — Jest's toEqual ignores undefined
      // properties, so we don't need to assert on it.
      generatedRecipe: null,
    });
    expect(result.current.error).toBeNull();
  });

  it("rolls back the optimistic user message on error", async () => {
    mockPostRiffTurn.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
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

  it("reuses the returned session_id on subsequent sends", async () => {
    mockPostRiffTurn
      .mockResolvedValueOnce({
        session_id: "sess-xyz",
        assistant_message: "First reply",
      })
      .mockResolvedValueOnce({
        session_id: "sess-xyz",
        assistant_message: "Second reply",
      });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("First");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-xyz");
    });

    act(() => {
      result.current.sendMessage("Second");
    });
    await waitFor(() => {
      expect(mockPostRiffTurn).toHaveBeenCalledTimes(2);
    });

    // First call omits sessionId (session didn't exist yet)
    expect(mockPostRiffTurn).toHaveBeenNthCalledWith(1, {
      recipeId: "recipe-1",
      message: "First",
    });
    // Second call reuses sessionId captured from the first response
    expect(mockPostRiffTurn).toHaveBeenNthCalledWith(2, {
      recipeId: "recipe-1",
      message: "Second",
      sessionId: "sess-xyz",
    });
  });

  it("drops concurrent sends while a turn is pending", async () => {
    let resolvePending: ((value: {
      session_id: string;
      assistant_message: string;
    }) => void) | undefined;
    mockPostRiffTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("First");
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    act(() => {
      result.current.sendMessage("Second");
    });
    expect(mockPostRiffTurn).toHaveBeenCalledTimes(1);

    // Clean up the pending mutation so the test can settle.
    act(() => {
      resolvePending?.({ session_id: "s", assistant_message: "reply" });
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("ignores send when input is whitespace-only", () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("   \n\t");
    });

    expect(mockPostRiffTurn).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Phase 13.2 — generated_recipe mapping + saveRecipe mutation
  // -------------------------------------------------------------------------

  it("strips fenced recipe-json blocks from displayed assistant content (13.2.1)", async () => {
    const recipe = {
      title: "X",
      servings: null,
      prep_time: null,
      cook_time: null,
      confidence: 1.0,
      ingredients: [],
      steps: [],
    } as Record<string, unknown>;
    const fullText =
      "Here's how I'd adapt it:\n\n```recipe-json\n" +
      JSON.stringify(recipe) +
      "\n```";
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-strip",
      assistant_message: fullText,
      assistant_message_id: "msg-strip",
      generated_recipe: recipe,
    });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    // The displayed content has the fenced block removed and is trimmed.
    expect(result.current.messages[1].content).toBe("Here's how I'd adapt it:");
    // The structured payload is still routed through generatedRecipe for the CTA.
    expect(result.current.messages[1].generatedRecipe).toEqual(recipe);
  });

  it("maps assistant_message_id and generated_recipe from server response", async () => {
    const recipe = {
      title: "Adapted",
      servings: "4",
      prep_time: null,
      cook_time: null,
      confidence: 1.0,
      ingredients: [],
      steps: [],
    } as Record<string, unknown>;
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-abc",
      assistant_message: "Here's the version",
      assistant_message_id: "msg-1",
      generated_recipe: recipe,
    });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Adapt it");
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });

    expect(result.current.messages[1]).toEqual({
      role: "assistant",
      content: "Here's the version",
      id: "msg-1",
      generatedRecipe: recipe,
    });
  });

  it("saveRecipe calls postRiffSave with mapped args", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-abc",
      assistant_message: "Saved version",
      assistant_message_id: "msg-1",
      generated_recipe: {
        title: "X",
        servings: null,
        prep_time: null,
        cook_time: null,
        confidence: 1.0,
        ingredients: [],
        steps: [],
      } as Record<string, unknown>,
    });
    mockPostRiffSave.mockResolvedValue({ recipe_id: "new-recipe-uuid" });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    // Send a turn first so sessionId + assistant message id are populated.
    act(() => {
      result.current.sendMessage("Make it dairy-free");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-abc");
    });

    act(() => {
      result.current.saveRecipe("msg-1", "Dairy-Free");
    });

    await waitFor(() => {
      expect(mockPostRiffSave).toHaveBeenCalledWith({
        recipeId: "recipe-1",
        sessionId: "sess-abc",
        messageId: "msg-1",
        riffLabel: "Dairy-Free",
      });
    });
  });

  it("savedMessageIds updates on save success", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-abc",
      assistant_message: "Saved version",
      assistant_message_id: "msg-1",
      generated_recipe: {
        title: "X",
        servings: null,
        prep_time: null,
        cook_time: null,
        confidence: 1.0,
        ingredients: [],
        steps: [],
      } as Record<string, unknown>,
    });
    mockPostRiffSave.mockResolvedValue({ recipe_id: "new-recipe-uuid" });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Make it dairy-free");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-abc");
    });

    expect(result.current.savedMessageIds.has("msg-1")).toBe(false);

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });
    await waitFor(() => {
      expect(result.current.savedMessageIds.has("msg-1")).toBe(true);
    });
  });

  it("translates 409 ALREADY_SAVED into graceful success (Issue 1 idempotent retry)", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-abc",
      assistant_message: "Saved version",
      assistant_message_id: "msg-1",
      generated_recipe: {
        title: "X",
        servings: null,
        prep_time: null,
        cook_time: null,
        confidence: 1.0,
        ingredients: [],
        steps: [],
      } as Record<string, unknown>,
    });
    const conflict = new ApiError({
      kind: "http",
      status: 409,
      message: "Already saved.",
      detail: { code: "ALREADY_SAVED", recipe_id: "rec-existing" },
    });
    mockPostRiffSave.mockRejectedValue(conflict);

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Make it dairy-free");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-abc");
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });

    // The retry resolves to the SAME recipe: CTA flips to saved and no
    // error surfaces.
    await waitFor(() => {
      expect(result.current.savedMessageIds.has("msg-1")).toBe(true);
    });
    expect(result.current.saveError).toBeNull();
  });

  it("drops concurrent saveRecipe calls while a save is pending", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-abc",
      assistant_message: "...",
      assistant_message_id: "msg-1",
      generated_recipe: {
        title: "X",
        servings: null,
        prep_time: null,
        cook_time: null,
        confidence: 1.0,
        ingredients: [],
        steps: [],
      } as Record<string, unknown>,
    });
    let resolveSave: ((value: { recipe_id: string }) => void) | undefined;
    mockPostRiffSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Make it dairy-free");
    });
    await waitFor(() => {
      expect(result.current.sessionId).toBe("sess-abc");
    });

    act(() => {
      result.current.saveRecipe("msg-1", null);
    });
    await waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    // Second tap while the first save is still in-flight: must be dropped.
    act(() => {
      result.current.saveRecipe("msg-1", null);
    });
    expect(mockPostRiffSave).toHaveBeenCalledTimes(1);

    // Settle so the test runner can clean up.
    act(() => {
      resolveSave?.({ recipe_id: "x" });
    });
    await waitFor(() => {
      expect(result.current.isSaving).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 13.8 — entryPoint plumbing (sync path)
  // -------------------------------------------------------------------------

  it("forwards entryPoint to postRiffTurn when option is provided", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
    const { result } = renderHook(
      () => useRiffSession("recipe-1", { entryPoint: "grocery_substitute" }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Sub for X?");
    });

    await waitFor(() => {
      expect(mockPostRiffTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockPostRiffTurn).toHaveBeenCalledWith({
      recipeId: "recipe-1",
      message: "Sub for X?",
      entryPoint: "grocery_substitute",
    });
  });

  it("omits entryPoint from postRiffTurn when no options are passed", async () => {
    mockPostRiffTurn.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    await waitFor(() => {
      expect(mockPostRiffTurn).toHaveBeenCalledTimes(1);
    });
    // Regression guard for default callers — call shape must NOT include
    // entryPoint when the hook's options arg is omitted (conditional spread).
    const callArg = mockPostRiffTurn.mock.calls[0]![0];
    expect(callArg).not.toHaveProperty("entryPoint");
  });
});

// ---------------------------------------------------------------------------
// Phase 13.5 — Streaming-mode tests
// ---------------------------------------------------------------------------
//
// These tests exercise the streaming path (env.EXPO_PUBLIC_RIFF_STREAMING =
// true) by mocking lib/api/riff.streamRiffTurn. The mock captures the
// callbacks object passed by the hook so each test can dispatch synthetic
// SSE events to drive the state machine.
//
// Pattern per test:
//   1. flag is flipped to true in beforeEach
//   2. result.current.sendMessage("...") triggers sendStreaming
//   3. await waitFor(streamRiffTurn called) drains microtasks so the
//      hook's `await streamRiffTurn(...)` resolves and handleRef is set
//   4. dispatch synthetic events via capturedCallbacks!.onXxx(...)
//      wrapped in `await act(async () => ...)` so React flushes state
//   5. assert on result.current.<state>

describe("useRiffSession (streaming mode)", () => {
  let capturedCallbacks: RiffStreamCallbacks | null;
  let mockCancelHandle: jest.Mock;

  beforeEach(() => {
    mockPostRiffTurn.mockReset();
    mockPostRiffSave.mockReset();
    mockStreamRiffTurn.mockReset();
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = true;
    capturedCallbacks = null;
    mockCancelHandle = jest.fn();
    mockStreamRiffTurn.mockImplementation(async (args) => {
      capturedCallbacks = args.callbacks;
      return { cancel: mockCancelHandle };
    });
  });

  afterEach(() => {
    mockEnv.EXPO_PUBLIC_RIFF_STREAMING = false;
  });

  it("streams the golden path: idle → sending → streaming → completed", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    expect(result.current.isStreaming).toBe(false);

    act(() => {
      result.current.sendMessage("Hi");
    });

    // Synchronously after sendMessage: optimistic user bubble + sending state.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.currentPartialAssistantMessage).toBeNull();

    // streamRiffTurn was called; await drains the microtask so the hook
    // stores the handle (post-await continuation in sendStreaming).
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    expect(capturedCallbacks).not.toBeNull();
    const cb = capturedCallbacks!;

    // session_resolved + user_message_committed — no visible state change.
    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });
    expect(result.current.sessionId).toBe("sess-1");
    expect(result.current.isStreaming).toBe(true);

    // First delta → streaming_assistant.
    await act(async () => {
      cb.onAssistantDelta({ text: "Hello", seq: 0 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Hello");
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      cb.onAssistantDelta({ text: " there", seq: 1 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Hello there");

    // assistant_complete + done → completed.
    await act(async () => {
      cb.onAssistantComplete({ assistant_message_id: "asst-msg-1" });
      cb.onDone();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "Hello there",
        id: "asst-msg-1",
        generatedRecipe: null,
      },
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.streamError).toBeNull();
  });

  it("handles zero-delta success when assistant_complete fires before any delta", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      // No deltas — assistant_complete fires directly.
      cb.onAssistantComplete({ assistant_message_id: "asst-msg-1" });
      cb.onDone();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    // Canonical assistant message is committed with empty content
    // (stripRecipeBlocks of "" returns ""). Save CTA gating in RiffChat
    // already filters empty bubbles via hasVisibleContent — this hook
    // commits the message regardless; the rendering layer hides it.
    expect(result.current.messages).toEqual([
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "",
        id: "asst-msg-1",
        generatedRecipe: null,
      },
    ]);
  });

  it("accumulates assistant deltas into currentPartialAssistantMessage", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });

    await act(async () => {
      cb.onAssistantDelta({ text: "Hello", seq: 0 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Hello");

    // Trailing whitespace mid-stream is hidden by stripRecipeBlocksStreaming's
    // trim — display jumps directly from "Hello" to "Hello world" once the
    // next non-whitespace token arrives. partialTextRef stays raw underneath.
    await act(async () => {
      cb.onAssistantDelta({ text: " ", seq: 1 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Hello");

    await act(async () => {
      cb.onAssistantDelta({ text: "world", seq: 2 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Hello world");

    // Mid-stream: messages still contains only the optimistic user
    // bubble — no canonical assistant message is appended until done.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("commits canonical assistant message on done and clears partial", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "Hello world", seq: 0 });
    });

    // Mid-stream snapshot: partial set, no canonical yet.
    expect(result.current.currentPartialAssistantMessage).toBe("Hello world");
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      cb.onAssistantComplete({ assistant_message_id: "asst-1" });
      cb.onDone();
    });

    // Post-done: partial cleared, canonical appended exactly once.
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toEqual({
      role: "assistant",
      content: "Hello world",
      id: "asst-1",
      generatedRecipe: null,
    });
    expect(result.current.isStreaming).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6B — Seq gap detection (contract §5)
  // -------------------------------------------------------------------------
  // The hook tracks expectedSeqRef per turn (initialized to 0). Any delta
  // whose `seq` differs from the expected next value triggers stream
  // failure: cancel, error state, partial discarded, user bubble preserved,
  // no canonical commit.

  it("treats a skipped seq as stream failure: cancels, errors, keeps user bubble", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      // Valid first delta
      cb.onAssistantDelta({ text: "first ", seq: 0 });
    });
    // Display strips trailing whitespace; partialTextRef stays raw.
    expect(result.current.currentPartialAssistantMessage).toBe("first");

    // Skipped seq: expected 1, got 3.
    await act(async () => {
      cb.onAssistantDelta({ text: "skipped", seq: 3 });
    });

    // Stream cancelled, error state set.
    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toEqual({
      kind: "transport",
      code: "TRANSPORT_EXCEPTION",
      message: expect.stringContaining("expected seq 1, got 3"),
      retryable: false,
    });
    // Compatibility ApiError populated for legacy `error` consumers.
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toContain("expected seq 1, got 3");
    // User bubble preserved per directive Option X. No canonical
    // assistant message appended.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);

    // Subsequent callbacks become no-ops via terminatedRef. A delta
    // arriving after the gap-error must not mutate state further.
    await act(async () => {
      cb.onAssistantDelta({ text: "late", seq: 4 });
      cb.onAssistantComplete({ assistant_message_id: "asst-late" });
      cb.onDone();
    });
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
  });

  it("treats a duplicate seq as stream failure: cancels, errors, keeps user bubble", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "first ", seq: 0 });
      cb.onAssistantDelta({ text: "second", seq: 1 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("first second");

    // Duplicate seq: expected 2, got 1 (replay of prior delta).
    await act(async () => {
      cb.onAssistantDelta({ text: "duplicated", seq: 1 });
    });

    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toEqual({
      kind: "transport",
      code: "TRANSPORT_EXCEPTION",
      message: expect.stringContaining("expected seq 2, got 1"),
      retryable: false,
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("treats a non-zero first seq as stream failure", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });

    // Very first delta arrives with seq=2 (expected 0). Per contract §5,
    // server-emitted seq starts at 0; anything else fails the stream
    // immediately.
    await act(async () => {
      cb.onAssistantDelta({ text: "wrong start", seq: 2 });
    });

    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toEqual({
      kind: "transport",
      code: "TRANSPORT_EXCEPTION",
      message: expect.stringContaining("expected seq 0, got 2"),
      retryable: false,
    });
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  // -------------------------------------------------------------------------
  // 6C — Cancel + error paths
  // -------------------------------------------------------------------------

  it("cancels mid-flight before first delta: keeps user bubble, no error", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.cancel();
    });

    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("cancels mid-stream after deltas: keeps user bubble, discards partial, no error", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "partial ", seq: 0 });
      cb.onAssistantDelta({ text: "text", seq: 1 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("partial text");

    act(() => {
      result.current.cancel();
    });

    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("pre-delta server error (RATE_LIMIT, retryable=true) transitions to error state", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      // Server-emitted RiffStreamErrorEvent: NO `kind` field. Code is from
      // the V1 §16-G server catalog. Pre-delta server errors may be
      // retryable per §8.
      cb.onError({
        code: "RATE_LIMIT",
        message: "Rate limit hit. Try again in a moment.",
        retryable: true,
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    // streamError preserves the server shape verbatim (no kind field).
    expect(result.current.streamError).toEqual({
      code: "RATE_LIMIT",
      message: "Rate limit hit. Try again in a moment.",
      retryable: true,
    });
    // Compatibility ApiError populated (network-kind via the hook's
    // isRiffTransportError discriminator: server events fall to the
    // apiErrorFromNetwork branch since no `kind` field).
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe(
      "Rate limit hit. Try again in a moment.",
    );
    // User bubble preserved per directive Option X.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("mid-stream server error (MODEL_ERROR, retryable=false): keeps user bubble, discards partial", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "partial ", seq: 0 });
      cb.onAssistantDelta({ text: "text", seq: 1 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("partial text");

    await act(async () => {
      // Server-emitted, no `kind`. Mid-stream errors are retryable=false
      // per §8 (no auto-resume).
      cb.onError({
        code: "MODEL_ERROR",
        message: "The model returned an error.",
        retryable: false,
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toEqual({
      code: "MODEL_ERROR",
      message: "The model returned an error.",
      retryable: false,
    });
    expect(result.current.error).not.toBeNull();
    // No canonical assistant message — partial discarded.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("transport error clears partial and preserves user bubble", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "partial", seq: 0 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("partial");

    await act(async () => {
      // Library/transport-level error: distinct from server
      // RiffStreamErrorEvent. Has `kind: "transport"` and TRANSPORT_*
      // code namespace per Item 3.
      cb.onError({
        kind: "transport",
        code: "TRANSPORT_ERROR",
        message: "Stream closed before completion",
        retryable: false,
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.streamError).toEqual({
      kind: "transport",
      code: "TRANSPORT_ERROR",
      message: "Stream closed before completion",
      retryable: false,
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe(
      "Stream closed before completion",
    );
    // User bubble preserved per directive Option X. No canonical assistant.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("subsequent send after error clears streamError and starts a new turn", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("First");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb1 = capturedCallbacks!;

    // First turn errors out via a transport error pre-delta.
    await act(async () => {
      cb1.onSessionResolved({ session_id: "sess-1" });
      cb1.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb1.onError({
        kind: "transport",
        code: "TRANSPORT_ERROR",
        message: "Stream closed before completion",
        retryable: false,
      });
    });
    expect(result.current.streamError).not.toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.messages).toEqual([
      { role: "user", content: "First" },
    ]);

    // User retries by sending again. New turn must:
    //   - reset streamError + streamingApiError to null
    //   - optimistically append a new user bubble
    //   - re-call streamRiffTurn
    act(() => {
      result.current.sendMessage("Second");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(2);
    });

    // Errors cleared at the top of sendStreaming.
    expect(result.current.streamError).toBeNull();
    expect(result.current.error).toBeNull();
    // Both user bubbles persisted (the first turn's user row exists
    // server-side; rolling back would diverge from server state).
    expect(result.current.messages).toEqual([
      { role: "user", content: "First" },
      { role: "user", content: "Second" },
    ]);
    expect(result.current.isStreaming).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6D — Race conditions + concurrent-send guard
  // -------------------------------------------------------------------------

  it("cancelling during stream open closes the handle when it resolves", async () => {
    // Override the default mock with a controllable Promise so we can
    // call cancel() while streamRiffTurn is still pending — exercising
    // path 2 of cancel() (streamingInFlightRef set, handleRef null) and
    // the race guard inside sendStreaming's try block.
    let resolveStreamPromise:
      | ((handle: { cancel: () => void }) => void)
      | undefined;
    mockStreamRiffTurn.mockReset();
    mockCancelHandle = jest.fn();
    mockStreamRiffTurn.mockImplementation((args) => {
      capturedCallbacks = args.callbacks;
      return new Promise((resolve) => {
        resolveStreamPromise = resolve;
      });
    });

    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("Hi");
    });

    // streamingInFlightRef is true; handleRef.current is still null because
    // streamRiffTurn hasn't resolved.
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(mockCancelHandle).not.toHaveBeenCalled();

    // User taps Cancel during the open. Hook path 2 sets terminatedRef
    // synchronously and transitions to cancelled.
    act(() => {
      result.current.cancel();
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamError).toBeNull();
    expect(result.current.error).toBeNull();
    // Handle still hasn't resolved — no cancel invocation yet.
    expect(mockCancelHandle).not.toHaveBeenCalled();

    // Now resolve the Promise. The hook's try block sees terminatedRef
    // and calls handle.cancel() per the race guard.
    await act(async () => {
      resolveStreamPromise!({ cancel: mockCancelHandle });
    });

    // Race guard fired: handle was closed even though it wasn't yet
    // stored when the user tapped Cancel.
    expect(mockCancelHandle).toHaveBeenCalledTimes(1);
    // No leak into messages or state.
    expect(result.current.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(result.current.currentPartialAssistantMessage).toBeNull();
  });

  it("silently drops concurrent sends while a streaming turn is in flight", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("First");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    // First turn opens; setup events fire but no terminal callback yet.
    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "first turn streaming...", seq: 0 });
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.currentPartialAssistantMessage).toBe(
      "first turn streaming...",
    );

    // Concurrent send: second sendMessage while the first turn is mid-stream.
    // Per directive, this is silently dropped (mirrors sync-path
    // mutation.isPending guard).
    act(() => {
      result.current.sendMessage("Second");
    });

    // streamRiffTurn was NOT called a second time.
    expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    // No second user bubble appended.
    expect(result.current.messages).toEqual([
      { role: "user", content: "First" },
    ]);
    // First turn's partial state intact.
    expect(result.current.currentPartialAssistantMessage).toBe(
      "first turn streaming...",
    );

    // Settle the first turn so the test runner can clean up.
    await act(async () => {
      cb.onAssistantComplete({ assistant_message_id: "asst-1" });
      cb.onDone();
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 6F — Streaming-aware recipe-block strip (Phase 13.5 verification fix #1)
  //
  // The terminal stripRecipeBlocks regex only matches CLOSED fences. The
  // partial bubble must additionally truncate at any unclosed
  // ```recipe-json opener so the JSON payload doesn't leak on screen while
  // it's being generated. partialTextRef stays raw so the canonical commit
  // path on `done` is unchanged.
  // -------------------------------------------------------------------------

  it("hides text from an unclosed ```recipe-json opener while streaming", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("full recipe please");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });

    // First delta: prose opens.
    await act(async () => {
      cb.onAssistantDelta({ text: "Here you go.\n\n", seq: 0 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Here you go.");

    // Second delta: opening fence arrives (no close yet). The bubble must
    // truncate at the fence — no JSON visible.
    await act(async () => {
      cb.onAssistantDelta({
        text: '```recipe-json\n{"title":"Spicy',
        seq: 1,
      });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Here you go.");

    // Third delta: more JSON. Still no close — bubble unchanged.
    await act(async () => {
      cb.onAssistantDelta({ text: ' Pasta",\n  "ingredients":[]', seq: 2 });
    });
    expect(result.current.currentPartialAssistantMessage).toBe("Here you go.");
  });

  it("strips a fully-closed recipe-json block from the partial bubble once the fence closes", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("full recipe please");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
    });

    // Build up to a complete fenced block.
    await act(async () => {
      cb.onAssistantDelta({ text: "Here you go.\n\n", seq: 0 });
      cb.onAssistantDelta({
        text: '```recipe-json\n{"title":"X"}\n```',
        seq: 1,
      });
    });
    // The closing ``` arrived in the second delta, so the regex matches
    // and the entire block is stripped from the partial bubble. No JSON
    // is visible.
    expect(result.current.currentPartialAssistantMessage).toBe("Here you go.");
  });

  it("preserves stripRecipeBlocks behavior on the canonical assistant message committed at done", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("full recipe please");
    });
    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });
    const cb = capturedCallbacks!;

    await act(async () => {
      cb.onSessionResolved({ session_id: "sess-1" });
      cb.onUserMessageCommitted({ user_message_id: "user-msg-1" });
      cb.onAssistantDelta({ text: "Here you go.\n\n", seq: 0 });
      cb.onAssistantDelta({
        text: '```recipe-json\n{"title":"X"}\n```',
        seq: 1,
      });
      cb.onAssistantComplete({ assistant_message_id: "asst-1" });
      cb.onDone();
    });

    // Canonical message: stripped of the fenced block, prose preserved.
    expect(result.current.currentPartialAssistantMessage).toBeNull();
    expect(result.current.messages).toEqual([
      { role: "user", content: "full recipe please" },
      {
        role: "assistant",
        content: "Here you go.",
        id: "asst-1",
        generatedRecipe: null,
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Phase 13.8 — entryPoint plumbing (streaming path)
  // -------------------------------------------------------------------------

  it("forwards entryPoint to streamRiffTurn when option is provided", async () => {
    const { result } = renderHook(
      () => useRiffSession("recipe-1", { entryPoint: "grocery_substitute" }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.sendMessage("Sub for X?");
    });

    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });

    const callArg = mockStreamRiffTurn.mock.calls[0]![0];
    expect(callArg.recipeId).toBe("recipe-1");
    expect(callArg.message).toBe("Sub for X?");
    expect(callArg.entryPoint).toBe("grocery_substitute");
  });

  it("omits entryPoint from streamRiffTurn when no options are passed", async () => {
    const { result } = renderHook(() => useRiffSession("recipe-1"), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    await waitFor(() => {
      expect(mockStreamRiffTurn).toHaveBeenCalledTimes(1);
    });

    // Regression guard for default callers — call shape must NOT include
    // entryPoint when the hook's options arg is omitted (conditional spread).
    const callArg = mockStreamRiffTurn.mock.calls[0]![0];
    expect(callArg).not.toHaveProperty("entryPoint");
  });
});
