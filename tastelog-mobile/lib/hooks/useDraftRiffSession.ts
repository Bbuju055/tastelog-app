/**
 * Draft-anchored Riff session hook (Phase 13.9).
 *
 * Sibling to useRiffSession. Same public return contract (RiffSessionController
 * from useRiffSession.ts); same streaming-vs-sync branching via
 * EXPO_PUBLIC_RIFF_STREAMING; same in-memory conversation state with no
 * persistence and no query cache.
 *
 * Only three differences from useRiffSession:
 *   1. URL anchor — calls postDraftRiffTurn / streamDraftRiffTurn /
 *      postDraftRiffSave (POST /api/drafts/{draftId}/...).
 *   2. onSaveSuccess option — invoked when save resolves with a recipe id.
 *      Used by the draft Riff route (Slice H) to navigate to the newly
 *      created recipe per docs/capture-draft-riff-contract.md §6.2.
 *   3. HTTP 409 ALREADY_SAVED translation — backend signals idempotency
 *      when a previous save already migrated this session to recipe-
 *      anchored. detail: { code: "ALREADY_SAVED", recipe_id }. The hook
 *      treats this as a graceful success at the consumer surface:
 *      savedMessageIds is populated, onSaveSuccess fires with the
 *      recipe_id, and saveError is masked to null.
 *
 * Body duplication of useRiffSession is intentional per
 * docs/capture-draft-riff-contract.md §7.3 (zero recipe-path regression
 * risk > body-duplication cost).
 */

import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import {
  postDraftRiffSave,
  postDraftRiffTurn,
  streamDraftRiffTurn,
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
import type { RiffMessage, RiffSessionController } from "./useRiffSession";

const RECIPE_BLOCK_REGEX = /```recipe-json\s*\n[\s\S]*?\n```/g;

function stripRecipeBlocks(text: string): string {
  return text.replace(RECIPE_BLOCK_REGEX, "\n\n").trim();
}

function stripRecipeBlocksStreaming(text: string): string {
  let cleaned = text.replace(RECIPE_BLOCK_REGEX, "\n\n");
  const openIdx = cleaned.indexOf("```recipe-json");
  if (openIdx >= 0) {
    cleaned = cleaned.substring(0, openIdx);
  }
  return cleaned.trim();
}

function isRiffTransportError(
  err: RiffStreamErrorEvent | RiffTransportError,
): err is RiffTransportError {
  return "kind" in err && err.kind === "transport";
}

// Extract the recipe_id from an ApiError whose detail matches the
// ALREADY_SAVED dict shape ({ code: "ALREADY_SAVED", recipe_id: string }).
// Returns null for anything else. Used by saveMutation onError to translate
// 409 → graceful success.
function extractAlreadySavedRecipeId(err: ApiError | unknown): string | null {
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

type StreamingPhase =
  | "idle"
  | "sending_user_message"
  | "streaming_assistant"
  | "cancelling"
  | "completed"
  | "error"
  | "cancelled";

export type UseDraftRiffSessionOptions = {
  entryPoint?: string;
  // Called when save resolves with a recipe id — either via 2xx (normal
  // save) or via 409 ALREADY_SAVED (idempotent retry). The Slice H route
  // owns navigation; the hook owns savedMessageIds dedupe.
  onSaveSuccess?: (recipeId: string) => void;
};

export function useDraftRiffSession(
  draftId: string,
  options?: UseDraftRiffSessionOptions,
): RiffSessionController {
  const entryPoint = options?.entryPoint;
  const onSaveSuccess = options?.onSaveSuccess;

  const [messages, setMessages] = useState<RiffMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );

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

  const [streamingApiError, setStreamingApiError] =
    useState<ApiError | null>(null);

  const partialTextRef = useRef<string>("");
  const terminatedRef = useRef<boolean>(false);
  const assistantIdRef = useRef<string | null>(null);
  const generatedRecipeRef = useRef<Record<string, unknown> | null>(null);
  const expectedSeqRef = useRef<number>(0);

  const streamingInFlightRef = useRef<boolean>(false);

  const mutation = useMutation<
    RiffTurnResponse,
    ApiError,
    SendVars,
    SendContext
  >({
    mutationFn: ({ message }) =>
      postDraftRiffTurn({
        draftId,
        message,
        ...(sessionId ? { sessionId } : {}),
        ...(entryPoint ? { entryPoint } : {}),
      }),

    onMutate: ({ message }) => {
      const previousMessages = messages;
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      return { previousMessages };
    },

    onSuccess: (data) => {
      setSessionId(data.session_id);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: stripRecipeBlocks(data.assistant_message),
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
      if (!sessionId) {
        throw new Error("Invariant: saveRecipe called without sessionId");
      }
      return postDraftRiffSave({
        draftId,
        sessionId,
        messageId,
        riffLabel: label,
      });
    },

    onSuccess: (data, { messageId }) => {
      setSavedMessageIds((prev) => {
        const next = new Set(prev);
        next.add(messageId);
        return next;
      });
      onSaveSuccess?.(data.recipe_id);
    },

    onError: (err, { messageId }) => {
      // 409 ALREADY_SAVED — translate to graceful success. The mutation
      // still records error state internally; the saveError public field
      // is masked downstream by the alreadySavedRecipeId check.
      const recipeId = extractAlreadySavedRecipeId(err);
      if (recipeId) {
        setSavedMessageIds((prev) => {
          const next = new Set(prev);
          next.add(messageId);
          return next;
        });
        onSaveSuccess?.(recipeId);
      }
    },
  });

  const saveRecipe = useCallback(
    (messageId: string, label: string | null) => {
      if (saveMutation.isPending) return;
      if (savedMessageIds.has(messageId)) return;
      saveMutation.mutate({ messageId, label });
    },
    [saveMutation, savedMessageIds],
  );

  const cancel = useCallback(() => {
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
    if (!handleRef.current) return;
    handleRef.current.cancel();
    handleRef.current = null;
    terminatedRef.current = true;
    streamingInFlightRef.current = false;
    partialTextRef.current = "";
    assistantIdRef.current = null;
    generatedRecipeRef.current = null;
    setStreamingPhase("cancelled");
    setCurrentPartialAssistantMessage(null);
  }, []);

  const sendStreaming = useCallback(
    async (text: string) => {
      if (streamingInFlightRef.current || handleRef.current) return;

      streamingInFlightRef.current = true;

      partialTextRef.current = "";
      terminatedRef.current = false;
      assistantIdRef.current = null;
      generatedRecipeRef.current = null;
      expectedSeqRef.current = 0;
      setStreamingPhase("sending_user_message");
      setCurrentPartialAssistantMessage(null);
      setStreamError(null);
      setStreamingApiError(null);

      setMessages((prev) => [...prev, { role: "user", content: text }]);

      try {
        const handle = await streamDraftRiffTurn({
          draftId,
          message: text,
          ...(sessionId ? { sessionId } : {}),
          ...(entryPoint ? { entryPoint } : {}),
          callbacks: {
            onSessionResolved: (e) => {
              if (terminatedRef.current) return;
              setSessionId(e.session_id);
            },
            onUserMessageCommitted: () => {
              if (terminatedRef.current) return;
            },
            onAssistantDelta: (e) => {
              if (terminatedRef.current) return;
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
              setCurrentPartialAssistantMessage(
                stripRecipeBlocksStreaming(partialTextRef.current),
              );
              setStreamingPhase("streaming_assistant");
            },
            onAssistantComplete: (e) => {
              if (terminatedRef.current) return;
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
              const apiErr =
                isRiffTransportError(err) && err.code === "TRANSPORT_TIMEOUT"
                  ? apiErrorFromTimeout({ cause: err })
                  : apiErrorFromNetwork({
                      message: err.message,
                      cause: err,
                    });
              setStreamingApiError(apiErr);
              setStreamingPhase("error");
            },
            onDone: () => {
              if (terminatedRef.current) return;
              terminatedRef.current = true;
              streamingInFlightRef.current = false;
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
        if (terminatedRef.current) {
          handle.cancel();
        } else {
          handleRef.current = handle;
        }
      } catch (err) {
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
    [draftId, sessionId, entryPoint],
  );

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (env.EXPO_PUBLIC_RIFF_STREAMING) {
        void sendStreaming(trimmed);
        return;
      }

      if (mutation.isPending) return;
      mutation.mutate({ message: trimmed });
    },
    [mutation, sendStreaming],
  );

  const isStreaming =
    streamingPhase === "sending_user_message" ||
    streamingPhase === "streaming_assistant" ||
    streamingPhase === "cancelling";

  // 409 ALREADY_SAVED is a business-level success at the consumer surface
  // (the recipe exists; onSaveSuccess already fired). Mask the underlying
  // mutation error so saveError reflects "real" failures only — transport,
  // 5xx, expired draft mid-save, etc.
  const alreadySavedRecipeId = saveMutation.error
    ? extractAlreadySavedRecipeId(saveMutation.error)
    : null;
  const saveError = alreadySavedRecipeId ? null : saveMutation.error;

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
    savedMessageIds,
    saveRecipe,
    isSaving: saveMutation.isPending,
    saveError,
  };
}
