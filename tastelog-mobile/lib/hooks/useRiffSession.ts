/**
 * Riff session hook.
 *
 * Phase 13.1 shape: in-memory conversation state + React Query mutation
 * driving the synchronous /riff endpoint.
 *
 * Phase 13.5 (Slice 4) adds streaming-path scaffolding alongside the sync
 * path. The streaming driver itself is wired in subsequent segments; in
 * Slice 4A the streaming state machine remains in `idle`, so `isStreaming`
 * is always false and the public surface preserves sync-path behavior
 * bit-for-bit.
 *
 * Purely local — no query cache entries, no persistence. When the screen
 * unmounts, the session id and messages are discarded; the server rows
 * remain.
 */

import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import {
  postRiffSave,
  postRiffTurn,
  streamRiffTurn,
  type RiffStreamHandle,
  type RiffTransportError,
} from "../api/riff";
import type {
  RiffSaveResponse,
  RiffStreamErrorEvent,
  RiffTurnResponse,
} from "../api/schemas";
import { env } from "../config";
import {
  apiErrorFromNetwork,
  apiErrorFromTimeout,
  apiErrorFromValidation,
  isApiError,
  type ApiError,
} from "../errors";

export type RiffRole = "user" | "assistant";

// Strip ```recipe-json fenced blocks from displayed assistant text. The full
// text is preserved server-side on riff_messages.content; only the on-screen
// copy is cleaned. Mirrors the regex in api/core/riff.py::_RECIPE_BLOCK_PATTERN
// so the UI shows what the user actually wants to read (prose), not the
// machine-extracted JSON payload.
const RECIPE_BLOCK_REGEX = /```recipe-json\s*\n[\s\S]*?\n```/g;

function stripRecipeBlocks(text: string): string {
  // Replace with a paragraph break so prose either side of the block stays
  // separated when Claude doesn't already put blank lines around it.
  // Trailing trim absorbs the break when the block is at the very end.
  return text.replace(RECIPE_BLOCK_REGEX, "\n\n").trim();
}

// Streaming-aware variant for the partial assistant bubble. The terminal
// stripRecipeBlocks regex only matches a CLOSED fence — during streaming
// the closing ``` arrives last, so a naive call would leak the entire raw
// JSON payload into the bubble until `done`. This helper additionally
// truncates at any unclosed `\`\`\`recipe-json` opener so the JSON stays
// hidden while it's being generated.
function stripRecipeBlocksStreaming(text: string): string {
  let cleaned = text.replace(RECIPE_BLOCK_REGEX, "\n\n");
  const openIdx = cleaned.indexOf("```recipe-json");
  if (openIdx >= 0) {
    cleaned = cleaned.substring(0, openIdx);
  }
  return cleaned.trim();
}

// Type guard: discriminates RiffTransportError from RiffStreamErrorEvent.
// RiffStreamErrorEvent (server-emitted, V1 §16-G code) has no `kind`
// field; RiffTransportError (library/transport-level) carries
// kind: "transport". Direct `err.kind` access on the union is unsafe —
// use this guard at every branch point.
function isRiffTransportError(
  err: RiffStreamErrorEvent | RiffTransportError,
): err is RiffTransportError {
  return "kind" in err && err.kind === "transport";
}

export type RiffMessage = {
  role: RiffRole;
  content: string;
  // 13.2 — only on assistant messages that came back from the 13.2+ server.
  // Absent on optimistic user appends and on assistant rows from 13.1-era
  // responses (where the schema's optional fields are nullish).
  id?: string;
  // server-validated ParsedRecipe.model_dump() shape (client does not re-validate)
  generatedRecipe?: Record<string, unknown> | null;
};

// Extract the recipe_id from an ApiError whose detail matches the
// ALREADY_SAVED dict shape ({ code: "ALREADY_SAVED", recipe_id: string }).
// Returns null for anything else. Used by saveMutation onError to translate
// the idempotent-retry 409 into graceful success (Issue 1; body duplication
// with useDraftRiffSession is the documented §7.3 convention).
function extractAlreadySavedRecipeId(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const detail = err.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return null;
  }
  const dict = detail as Record<string, unknown>;
  if (dict.code !== "ALREADY_SAVED") return null;
  const recipeId = dict.recipe_id;
  return typeof recipeId === "string" && recipeId.length > 0
    ? recipeId
    : null;
}

type SendVars = {
  message: string;
};

type SendContext = {
  previousMessages: RiffMessage[];
};

type SaveVars = {
  messageId: string;
  label: string | null;
};

// Streaming-path state machine (Phase 13.5, contract §11). In Slice 4A the
// driver is not yet wired, so `streamingPhase` only ever holds "idle".
// Subsequent slices (4B onward) drive transitions through the other
// states.
type StreamingPhase =
  | "idle"
  | "sending_user_message"
  | "streaming_assistant"
  | "cancelling"
  | "completed"
  | "error"
  | "cancelled";

export function useRiffSession(
  recipeId: string,
  options?: { entryPoint?: string },
) {
  const entryPoint = options?.entryPoint;

  const [messages, setMessages] = useState<RiffMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Phase 13.5 streaming-path state. Inactive until the streaming driver
  // lands in subsequent slices; included in 4A so the public hook surface
  // stabilizes early and consumers (RiffChat) can be migrated against the
  // final shape.
  const handleRef = useRef<RiffStreamHandle | null>(null);
  const [streamingPhase, setStreamingPhase] =
    useState<StreamingPhase>("idle");
  const [
    currentPartialAssistantMessage,
    setCurrentPartialAssistantMessage,
  ] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<
    RiffStreamErrorEvent | RiffTransportError | null
  >(null);

  // Compatibility ApiError for the public `error` field. Public `error`
  // becomes (streamingApiError ?? mutation.error) so the sync path is
  // unchanged when no streaming turn has run, and existing consumers
  // reading hook.error.message keep working without knowing about the
  // streaming-specific RiffStreamErrorEvent / RiffTransportError union.
  const [streamingApiError, setStreamingApiError] =
    useState<ApiError | null>(null);

  // Per-turn streaming-driver refs. Reset at the start of each
  // sendStreaming call. Read from inside react-native-sse callbacks.
  const partialTextRef = useRef<string>("");
  const terminatedRef = useRef<boolean>(false);
  const assistantIdRef = useRef<string | null>(null);
  const generatedRecipeRef = useRef<Record<string, unknown> | null>(null);
  // Expected next assistant_delta.seq for client-side gap detection
  // (contract §5). Server emits monotonic seq from 0; any deviation
  // from the expected next value fails the stream.
  const expectedSeqRef = useRef<number>(0);

  // Synchronous in-flight gate. Set true at the very top of
  // sendStreaming, set false on each terminal path (onDone, onError,
  // catch, cancel — including the cancel-during-open branch). Prevents
  // concurrent sends across the async window before streamRiffTurn
  // resolves and handleRef is populated. Mirrors the protection
  // mutation.isPending gives the sync path.
  const streamingInFlightRef = useRef<boolean>(false);

  const mutation = useMutation<
    RiffTurnResponse,
    ApiError,
    SendVars,
    SendContext
  >({
    mutationFn: ({ message }) =>
      postRiffTurn({
        recipeId,
        message,
        ...(sessionId ? { sessionId } : {}),
        ...(entryPoint ? { entryPoint } : {}),
      }),

    onMutate: ({ message }) => {
      // Snapshot pre-mutation messages so onError can roll back cleanly.
      const previousMessages = messages;
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      return { previousMessages };
    },

    onSuccess: (data) => {
      // First turn establishes session_id; subsequent turns re-use it
      // because the mutationFn closure re-reads this state on re-render.
      setSessionId(data.session_id);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          // Strip the fenced recipe-json block from display — extraction is
          // server-side, the client only needs the prose for the chat bubble.
          content: stripRecipeBlocks(data.assistant_message),
          // Map nullish (13.1-era server) → undefined / null. The UI uses
          // `id` presence + `generatedRecipe !== null` to decide CTA visibility.
          id: data.assistant_message_id ?? undefined,
          generatedRecipe: data.generated_recipe ?? null,
        },
      ]);
    },

    onError: (_err, _vars, context) => {
      if (context) {
        setMessages(context.previousMessages);
      }
    },
  });

  const saveMutation = useMutation<RiffSaveResponse, ApiError, SaveVars>({
    mutationFn: ({ messageId, label }) => {
      // Defensive — the UI guards on sessionId before invoking saveRecipe,
      // but if the session somehow cleared mid-flight we want a clear
      // failure rather than a silent broken request.
      if (!sessionId) {
        throw new Error("Invariant: saveRecipe called without sessionId");
      }
      return postRiffSave({
        recipeId,
        sessionId,
        messageId,
        riffLabel: label,
      });
    },

    onSuccess: (_data, { messageId }) => {
      setSavedMessageIds((prev) => {
        const next = new Set(prev);
        next.add(messageId);
        return next;
      });
    },

    onError: (err, { messageId }) => {
      // Issue 1: the atomic save is idempotent on the originating riff
      // message (recipes.source_riff_message_id). A retry after an
      // ambiguous timeout resolves to the SAME recipe via HTTP 409
      // {code: ALREADY_SAVED, recipe_id}: translate to graceful success
      // at the hook layer (mirrors useDraftRiffSession's contract).
      const alreadySavedId = extractAlreadySavedRecipeId(err);
      if (alreadySavedId) {
        setSavedMessageIds((prev) => {
          const next = new Set(prev);
          next.add(messageId);
          return next;
        });
      }
    },
  });

  const saveRecipe = useCallback(
    (messageId: string, label: string | null) => {
      // Guards: drop double-tap, drop already-saved (cross-session
      // persistence is the documented V1 limitation).
      if (saveMutation.isPending) return;
      if (savedMessageIds.has(messageId)) return;
      saveMutation.mutate({ messageId, label });
    },
    [saveMutation, savedMessageIds],
  );

  // Cancel the active streaming turn. Three reachable paths:
  //   1. Established stream (handleRef set): close the handle, clear
  //      per-turn state, transition to cancelled.
  //   2. Cancel-during-open (streamingInFlightRef set, handleRef null):
  //      sendStreaming is still awaiting streamRiffTurn(...). Set
  //      terminatedRef so the awaited handle gets immediately closed
  //      when it resolves (the streaming try block checks this after
  //      await). Transition to cancelled now.
  //   3. Idle (neither set): no-op.
  //
  // None of the three paths roll back the optimistic user bubble or
  // set error / streamError. Per directive item 3 (Option X): user
  // cancel keeps the bubble; the server-side user row exists.
  const cancel = useCallback(() => {
    // Path 2: cancel-during-open
    if (streamingInFlightRef.current && !handleRef.current) {
      terminatedRef.current = true;
      streamingInFlightRef.current = false;
      partialTextRef.current = "";
      assistantIdRef.current = null;
      generatedRecipeRef.current = null;
      setStreamingPhase("cancelled");
      setCurrentPartialAssistantMessage(null);
      return;
    }
    // Path 3: idle
    if (!handleRef.current) return;
    // Path 1: established stream
    handleRef.current.cancel();
    handleRef.current = null;
    terminatedRef.current = true;
    streamingInFlightRef.current = false;
    partialTextRef.current = "";
    assistantIdRef.current = null;
    generatedRecipeRef.current = null;
    setStreamingPhase("cancelled");
    setCurrentPartialAssistantMessage(null);
    // streamError / streamingApiError intentionally NOT cleared —
    // cancel is not an error. (onError sets them; cancel does not.)
  }, []);

  const sendStreaming = useCallback(
    async (text: string) => {
      // Concurrent-send guard, refs only (synchronous reads — no
      // dependence on async React state). Mirrors the sync path's
      // `if (mutation.isPending) return;` semantics. Per directive
      // item 1: silently drop concurrent sends.
      if (streamingInFlightRef.current || handleRef.current) return;

      streamingInFlightRef.current = true;

      // Reset all per-turn state synchronously so subsequent reads in
      // callbacks see fresh values.
      partialTextRef.current = "";
      terminatedRef.current = false;
      assistantIdRef.current = null;
      generatedRecipeRef.current = null;
      expectedSeqRef.current = 0;
      setStreamingPhase("sending_user_message");
      setCurrentPartialAssistantMessage(null);
      setStreamError(null);
      setStreamingApiError(null);

      // Optimistic user append — matches sync-path onMutate pattern.
      // Per directive item 3 (Option X): this bubble is NOT rolled back
      // on streaming errors or user cancel; the server-side user row
      // exists and a rollback would diverge from server state.
      setMessages((prev) => [...prev, { role: "user", content: text }]);

      try {
        const handle = await streamRiffTurn({
          recipeId,
          message: text,
          ...(sessionId ? { sessionId } : {}),
          ...(entryPoint ? { entryPoint } : {}),
          callbacks: {
            onSessionResolved: (e) => {
              if (terminatedRef.current) return;
              // First turn establishes the session id; subsequent turns
              // reuse it (server validates the recipe match).
              setSessionId(e.session_id);
            },
            onUserMessageCommitted: () => {
              if (terminatedRef.current) return;
              // Server confirmed the user row. No visible state
              // transition per directive item 2: phase remains
              // sending_user_message until first delta or zero-delta
              // assistant_complete.
            },
            onAssistantDelta: (e) => {
              if (terminatedRef.current) return;
              // Seq gap detection (contract §5). Server emits monotonic
              // seq from 0; any deviation from the expected next value
              // (missing, duplicate, or out-of-order) fails the stream.
              // Cancel, discard partial, set error. No auto-retry per
              // §9. User bubble preserved per directive Option X.
              if (e.seq !== expectedSeqRef.current) {
                const expected = expectedSeqRef.current;
                terminatedRef.current = true;
                streamingInFlightRef.current = false;
                if (handleRef.current) {
                  handleRef.current.cancel();
                  handleRef.current = null;
                }
                partialTextRef.current = "";
                assistantIdRef.current = null;
                generatedRecipeRef.current = null;
                setCurrentPartialAssistantMessage(null);
                const seqError: RiffTransportError = {
                  kind: "transport",
                  code: "TRANSPORT_EXCEPTION",
                  message: `Stream delta out of order (expected seq ${expected}, got ${e.seq})`,
                  retryable: false,
                };
                setStreamError(seqError);
                setStreamingApiError(
                  apiErrorFromNetwork({
                    message: seqError.message,
                    cause: seqError,
                  }),
                );
                setStreamingPhase("error");
                return;
              }
              expectedSeqRef.current += 1;
              partialTextRef.current += e.text;
              // Display the sanitized partial — see stripRecipeBlocksStreaming.
              // partialTextRef stays raw so onDone's stripRecipeBlocks(...)
              // commit path is unchanged.
              setCurrentPartialAssistantMessage(
                stripRecipeBlocksStreaming(partialTextRef.current),
              );
              setStreamingPhase("streaming_assistant");
            },
            onAssistantComplete: (e) => {
              if (terminatedRef.current) return;
              // Stash the id; canonical message is committed on `done`
              // so generated_recipe_ready (which arrives between
              // assistant_complete and done) can be incorporated into
              // the same single message append.
              assistantIdRef.current = e.assistant_message_id;
            },
            onGeneratedRecipeReady: (e) => {
              if (terminatedRef.current) return;
              generatedRecipeRef.current = e.generated_recipe;
            },
            onError: (err) => {
              if (terminatedRef.current) return;
              terminatedRef.current = true;
              streamingInFlightRef.current = false;
              partialTextRef.current = "";
              assistantIdRef.current = null;
              generatedRecipeRef.current = null;
              handleRef.current = null;
              setCurrentPartialAssistantMessage(null);
              setStreamError(err);
              // Compatibility ApiError surface so existing
              // hook.error.message consumers keep working. Map
              // TRANSPORT_TIMEOUT to apiErrorFromTimeout; everything
              // else becomes apiErrorFromNetwork (closest semantic
              // match — server SSE error events and library-transport
              // failures are both "the network round trip failed").
              const apiErr =
                isRiffTransportError(err) && err.code === "TRANSPORT_TIMEOUT"
                  ? apiErrorFromTimeout({ cause: err })
                  : apiErrorFromNetwork({
                      message: err.message,
                      cause: err,
                    });
              setStreamingApiError(apiErr);
              setStreamingPhase("error");
              // Per directive item 3 / Slice 4 Option X: do NOT roll
              // back the optimistic user bubble. Server-side user row
              // exists; the next turn's history will re-include it.
            },
            onDone: () => {
              if (terminatedRef.current) return;
              terminatedRef.current = true;
              streamingInFlightRef.current = false;
              // Commit a single canonical assistant message:
              //   content: stripped accumulated delta text
              //     (stripRecipeBlocks mirrors sync-path treatment so
              //      the on-screen prose excludes the fenced JSON; the
              //      server stores the full text on
              //      riff_messages.content unchanged.)
              //   id: from assistant_complete (undefined if that event
              //     somehow didn't fire — defensive)
              //   generatedRecipe: from generated_recipe_ready (null
              //     when no recipe block was extracted)
              const fullText = stripRecipeBlocks(partialTextRef.current);
              const assistantId = assistantIdRef.current;
              const generatedRecipe = generatedRecipeRef.current;
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: fullText,
                  id: assistantId ?? undefined,
                  generatedRecipe: generatedRecipe ?? null,
                },
              ]);
              partialTextRef.current = "";
              assistantIdRef.current = null;
              generatedRecipeRef.current = null;
              handleRef.current = null;
              setCurrentPartialAssistantMessage(null);
              setStreamingPhase("completed");
            },
          },
        });
        // Race guard: if the user tapped Cancel during the await
        // (path 2 of cancel()), terminatedRef is now true. Close the
        // freshly-opened handle immediately so it doesn't leak. Phase
        // and refs were already cleaned in cancel().
        if (terminatedRef.current) {
          handle.cancel();
        } else {
          handleRef.current = handle;
        }
      } catch (err) {
        // streamRiffTurn rejects only before EventSource is constructed
        // (e.g. getAccessToken returned null → apiErrorFromValidation).
        // Any post-construction failure flows through onError instead.
        if (terminatedRef.current) return;
        terminatedRef.current = true;
        streamingInFlightRef.current = false;
        partialTextRef.current = "";
        assistantIdRef.current = null;
        generatedRecipeRef.current = null;
        handleRef.current = null;
        setCurrentPartialAssistantMessage(null);
        const apiErr = isApiError(err)
          ? err
          : apiErrorFromValidation({
              message:
                err instanceof Error
                  ? err.message
                  : "Failed to open stream",
            });
        setStreamingApiError(apiErr);
        setStreamError({
          kind: "transport",
          code: "TRANSPORT_EXCEPTION",
          message: apiErr.message,
          retryable: false,
        });
        setStreamingPhase("error");
      }
    },
    [recipeId, sessionId, entryPoint],
  );

  // sendMessage is the public entry point. It branches on the
  // streaming flag and delegates to either sendStreaming (the
  // post-13.5 driver) or the sync mutation. Declared after
  // sendStreaming so the closure references it lexically (TS would
  // otherwise reject on use-before-declaration of a const arrow).
  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (env.EXPO_PUBLIC_RIFF_STREAMING) {
        // Streaming path. sendStreaming has its own concurrent-send
        // guard via streamingInFlightRef + handleRef; no need to also
        // gate on mutation.isPending here. The void discards the
        // returned Promise — sendStreaming's own catch handles
        // pre-EventSource failures, and post-EventSource errors flow
        // through the streaming callbacks (no unhandled-rejection
        // surface).
        void sendStreaming(trimmed);
        return;
      }

      // Sync path — preserved bit-for-bit. Guard against double-tap /
      // concurrent sends — the session_id must settle from turn N
      // before turn N+1 dispatches, otherwise a second server-side
      // session would be created.
      if (mutation.isPending) return;
      mutation.mutate({ message: trimmed });
    },
    [mutation, sendStreaming],
  );

  const isStreaming =
    streamingPhase === "sending_user_message" ||
    streamingPhase === "streaming_assistant" ||
    streamingPhase === "cancelling";

  return {
    messages,
    sessionId,
    sendMessage,
    isLoading: isStreaming || mutation.isPending,
    isStreaming,
    cancel,
    currentPartialAssistantMessage,
    streamError,
    error: streamingApiError ?? mutation.error,
    // 13.2 additions
    savedMessageIds,
    saveRecipe,
    isSaving: saveMutation.isPending,
    // ALREADY_SAVED is a graceful success (idempotent retry), never an
    // error surface.
    saveError: extractAlreadySavedRecipeId(saveMutation.error)
      ? null
      : saveMutation.error,
  };
}

// Phase 13.9 — public return-type alias. useDraftRiffSession returns a
// value type-compatible with this alias so Slice H's <RiffChat /> can take
// a single anchor-agnostic controller prop. Type-only export; no runtime
// change to useRiffSession.
export type RiffSessionController = ReturnType<typeof useRiffSession>;
