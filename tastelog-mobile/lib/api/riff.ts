/**
 * Riff mode API client.
 *
 * Phase 13.1 endpoint POST /api/recipes/{recipe_id}/riff returns
 * { session_id, assistant_message, ... }.
 *
 * Phase 13.5 adds streamRiffTurn(...) for the SSE streaming variant.
 * The two coexist; the active hook (useRiffSession) chooses based on
 * env.EXPO_PUBLIC_RIFF_STREAMING. Sync path is the default fallback.
 *
 * Timeout is higher than the default 20s because Claude text generation
 * occasionally tails past that; still well under the client-wide cap.
 */

import EventSource from "react-native-sse";

import { getAccessToken } from "../auth/supabase";
import { env } from "../config";
import { apiErrorFromValidation } from "../errors";
import { apiFetch } from "./client";
import {
  assistantCompleteEventSchema,
  assistantDeltaEventSchema,
  doneEventSchema,
  generatedRecipeReadyEventSchema,
  riffSaveResponseSchema,
  riffStreamErrorEventSchema,
  riffTurnResponseSchema,
  sessionResolvedEventSchema,
  userMessageCommittedEventSchema,
  type AssistantCompleteEvent,
  type AssistantDeltaEvent,
  type GeneratedRecipeReadyEvent,
  type RiffSaveResponse,
  type RiffStreamErrorEvent,
  type RiffTurnResponse,
  type SessionResolvedEvent,
  type UserMessageCommittedEvent,
} from "./schemas";

const RIFF_TIMEOUT_MS = 60_000;

type PostRiffTurnArgs = {
  recipeId: string;
  message: string;
  sessionId?: string;
  entryPoint?: string;
};

export async function postRiffTurn({
  recipeId,
  message,
  sessionId,
  entryPoint,
}: PostRiffTurnArgs): Promise<RiffTurnResponse> {
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/riff`,
    method: "POST",
    body: {
      message,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(entryPoint ? { entry_point: entryPoint } : {}),
    },
    schema: riffTurnResponseSchema,
    authMode: "user",
    auth: "required",
    timeoutMs: RIFF_TIMEOUT_MS,
  });
}

type PostRiffSaveArgs = {
  recipeId: string;
  sessionId: string;
  messageId: string;
  riffLabel: string | null;
};

/**
 * Save a riff-generated recipe to the cookbook (Phase 13.2).
 *
 * DB-only write — uses the apiFetch default timeout. No idempotency header:
 * client-side guards (mutation pending + savedMessageIds set) handle dedup.
 */
export async function postRiffSave({
  recipeId,
  sessionId,
  messageId,
  riffLabel,
}: PostRiffSaveArgs): Promise<RiffSaveResponse> {
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/riff/save`,
    method: "POST",
    body: {
      session_id: sessionId,
      message_id: messageId,
      riff_label: riffLabel,
    },
    schema: riffSaveResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

// ---------------------------------------------------------------------------
// Phase 13.5 — Streaming Riff turn (sibling of postRiffTurn)
// ---------------------------------------------------------------------------

/**
 * Transport-layer error surfaced through onError. Distinct from the server
 * `error` event (which uses RiffStreamErrorEvent's V1 §16-G code catalog).
 * The kind discriminator lets callers branch.
 */
export type RiffTransportError = {
  kind: "transport";
  code: "TRANSPORT_ERROR" | "TRANSPORT_TIMEOUT" | "TRANSPORT_EXCEPTION";
  message: string;
  retryable: boolean;
};

export type RiffStreamCallbacks = {
  onSessionResolved: (event: SessionResolvedEvent) => void;
  onUserMessageCommitted: (event: UserMessageCommittedEvent) => void;
  onAssistantDelta: (event: AssistantDeltaEvent) => void;
  onAssistantComplete: (event: AssistantCompleteEvent) => void;
  onGeneratedRecipeReady: (event: GeneratedRecipeReadyEvent) => void;
  onError: (error: RiffStreamErrorEvent | RiffTransportError) => void;
  onDone: () => void;
};

export type RiffStreamHandle = {
  cancel: () => void;
};

type StreamRiffTurnArgs = {
  recipeId: string;
  message: string;
  sessionId?: string;
  entryPoint?: string;
  callbacks: RiffStreamCallbacks;
};

// Custom event names we register with react-native-sse. None overlap with
// the library's built-in 'open' | 'message' | 'error' | 'close'.
type RiffEventName =
  | "session_resolved"
  | "user_message_committed"
  | "assistant_delta"
  | "assistant_complete"
  | "generated_recipe_ready"
  | "done";

/**
 * Open a streaming Riff turn against POST /api/recipes/{id}/riff/stream.
 *
 * Returns a handle with cancel() once the EventSource is constructed and
 * the JWT is in hand. The actual streaming proceeds via callbacks; the
 * Promise itself does NOT await `done`.
 *
 * Callback contract:
 *   - onSessionResolved fires exactly once, before any delta.
 *   - onUserMessageCommitted fires exactly once, before any delta.
 *   - onAssistantDelta fires zero or more times (each carries `text` and
 *     monotonic `seq` from 0).
 *   - onAssistantComplete fires once on success, after all deltas.
 *   - onGeneratedRecipeReady fires zero-or-once, after onAssistantComplete.
 *   - onError fires zero-or-once, terminal — for either a server `error`
 *     event (V1 §16-G code) or a transport-layer failure (TRANSPORT_*).
 *     onError and onDone are mutually exclusive: only one terminal
 *     callback fires per turn.
 *   - onDone fires once on clean completion.
 *   - cancel() may be called any time; subsequent terminal callbacks are
 *     suppressed (idempotent). Cancel itself fires no terminal callback.
 *   - An unexpected `close` (no prior done/error/cancel) is reported as a
 *     transport error with message "Stream closed before completion" so
 *     the hook exits the streaming state cleanly instead of hanging.
 *
 * Validation: each event payload is parsed through its Zod schema. Parse
 * failure is treated as a transport error — onError fires with
 * TRANSPORT_EXCEPTION, the stream is closed, no further callbacks run.
 *
 * No retry. No reconnect (pollingInterval: 0). Manual re-send only per
 * contract §9.
 */
export async function streamRiffTurn(
  args: StreamRiffTurnArgs,
): Promise<RiffStreamHandle> {
  const { recipeId, message, sessionId, entryPoint, callbacks } = args;

  const token = await getAccessToken();
  if (!token) {
    throw apiErrorFromValidation({
      message:
        "Authentication required, but no active session is available.",
    });
  }

  const url = `${env.EXPO_PUBLIC_API_BASE_URL}/api/recipes/${encodeURIComponent(
    recipeId,
  )}/riff/stream`;

  const es = new EventSource<RiffEventName>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      session_id: sessionId ?? null,
      ...(entryPoint ? { entry_point: entryPoint } : {}),
    }),
    pollingInterval: 0, // §9 — no auto-reconnect
    withCredentials: false,
  });

  // Idempotency: only the first terminal callback (onError or onDone)
  // fires; subsequent close/error events from the library are suppressed.
  // Cancel sets terminated=true without firing a terminal callback.
  let terminated = false;

  const safeClose = () => {
    try {
      es.close();
    } catch {
      // ignore close errors during cleanup
    }
  };

  const fireTransportError = (
    code: RiffTransportError["code"],
    message: string,
    retryable: boolean,
  ) => {
    if (terminated) return;
    terminated = true;
    safeClose();
    callbacks.onError({ kind: "transport", code, message, retryable });
  };

  // Wire-shape parse helper — fail-fast on malformed events.
  const parseOrTransportError = <T>(
    schema: { safeParse: (x: unknown) => { success: boolean; data?: T } },
    raw: string | null,
    eventName: string,
  ): T | null => {
    if (raw === null) {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Empty data on ${eventName} event`,
        false,
      );
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Malformed JSON on ${eventName} event`,
        false,
      );
      return null;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Schema mismatch on ${eventName} event`,
        false,
      );
      return null;
    }
    return parsed.data as T;
  };

  es.addEventListener("session_resolved", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      sessionResolvedEventSchema,
      event.data,
      "session_resolved",
    );
    if (parsed) callbacks.onSessionResolved(parsed);
  });

  es.addEventListener("user_message_committed", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      userMessageCommittedEventSchema,
      event.data,
      "user_message_committed",
    );
    if (parsed) callbacks.onUserMessageCommitted(parsed);
  });

  es.addEventListener("assistant_delta", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      assistantDeltaEventSchema,
      event.data,
      "assistant_delta",
    );
    if (parsed) callbacks.onAssistantDelta(parsed);
  });

  es.addEventListener("assistant_complete", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      assistantCompleteEventSchema,
      event.data,
      "assistant_complete",
    );
    if (parsed) callbacks.onAssistantComplete(parsed);
  });

  es.addEventListener("generated_recipe_ready", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      generatedRecipeReadyEventSchema,
      event.data,
      "generated_recipe_ready",
    );
    if (parsed) callbacks.onGeneratedRecipeReady(parsed);
  });

  es.addEventListener("done", (event) => {
    if (terminated) return;
    // done payload is empty {} per contract; we still parse it so any
    // unexpected shape surfaces as transport error.
    const parsed = parseOrTransportError(
      doneEventSchema,
      event.data,
      "done",
    );
    if (parsed === null) return;
    terminated = true;
    safeClose();
    callbacks.onDone();
  });

  es.addEventListener("error", (event) => {
    if (terminated) return;
    // The library's `error` listener receives a discriminated union of
    // ErrorEvent | TimeoutEvent | ExceptionEvent. We translate to either
    // a server-side RiffStreamErrorEvent (when message data is present
    // and parses cleanly through riffStreamErrorEventSchema) or a
    // RiffTransportError otherwise.
    if (event.type === "error") {
      // Library's "error" type carries `message`, `xhrStatus`, `xhrState`.
      // For SSE-named-event "error" emitted by the server, the library
      // currently routes through this same listener with a string `data`
      // field. Try parsing as a server event first; fall through to
      // transport error if no parseable payload. This dual-routing
      // disambiguation needs on-device verification.
      const dataField = (event as unknown as { data?: string | null }).data;
      if (typeof dataField === "string" && dataField.length > 0) {
        let json: unknown;
        try {
          json = JSON.parse(dataField);
        } catch {
          json = null;
        }
        const parsed = riffStreamErrorEventSchema.safeParse(json);
        if (parsed.success) {
          terminated = true;
          safeClose();
          callbacks.onError(parsed.data);
          return;
        }
      }
      fireTransportError(
        "TRANSPORT_ERROR",
        event.message ||
          `Transport error (xhrStatus=${event.xhrStatus ?? "?"})`,
        false,
      );
    } else if (event.type === "timeout") {
      fireTransportError("TRANSPORT_TIMEOUT", "Stream timed out", true);
    } else if (event.type === "exception") {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        event.message || "Transport exception",
        false,
      );
    } else {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        "Unknown transport error",
        false,
      );
    }
  });

  es.addEventListener("close", () => {
    if (terminated) {
      // Expected close: follows done, error, or user cancel — the
      // terminal callback already fired (or cancel suppressed it).
      // Idempotent no-op.
      return;
    }
    // Unexpected close: the connection dropped without the server
    // emitting `done` or `error`, and the user did not cancel. Common
    // causes: network drop, server crash mid-stream, library-internal
    // close. Surface as a transport error so the hook exits
    // streaming_assistant cleanly instead of hanging on the partial
    // bubble.
    //
    // retryable=false matches contract §8/§9 "Mid-stream after partial
    // output → no auto-resume, retryable=false". The conservative
    // alignment with mid-stream semantics. The UI may still offer a
    // manual "Try again" button — retryable only suppresses automated
    // retry.
    terminated = true;
    callbacks.onError({
      kind: "transport",
      code: "TRANSPORT_ERROR",
      message: "Stream closed before completion",
      retryable: false,
    });
  });

  return {
    cancel: () => {
      if (terminated) return;
      terminated = true;
      safeClose();
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 13.9 — Draft-anchored Riff (Capture / Draft Review)
// ---------------------------------------------------------------------------
// Sibling helpers to the recipe-anchored ones above. Wire shapes are
// byte-identical — backend Slices D / E / F return the same
// RiffTurnResponse / RiffStreamErrorEvent / RiffSaveResponse / SSE event
// schemas; only the URL path differs (/api/drafts/{id}/... instead of
// /api/recipes/{id}/...). Bodies match the recipe helpers exactly:
//   - postDraftRiffTurn mirrors postRiffTurn (conditional-spread session_id,
//     conditional-spread entry_point).
//   - streamDraftRiffTurn mirrors streamRiffTurn (session_id: sessionId ?? null
//     ALWAYS present per the recipe stream helper's existing behavior,
//     conditional-spread entry_point).
//   - postDraftRiffSave mirrors postRiffSave.
//
// 409 ALREADY_SAVED translation lives in useDraftRiffSession, NOT here —
// the helper propagates ApiError with `detail` preserved; the hook layer
// translates the business outcome to onSaveSuccess.
//
// Body duplication of streamRiffTurn into streamDraftRiffTurn is intentional
// per docs/capture-draft-riff-contract.md §7.3 (zero risk of recipe-path
// regression > body duplication cost). If a third anchor ever appears,
// extract a shared core then.

type PostDraftRiffTurnArgs = {
  draftId: string;
  message: string;
  sessionId?: string;
  entryPoint?: string;
};

export async function postDraftRiffTurn({
  draftId,
  message,
  sessionId,
  entryPoint,
}: PostDraftRiffTurnArgs): Promise<RiffTurnResponse> {
  return apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}/riff`,
    method: "POST",
    body: {
      message,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(entryPoint ? { entry_point: entryPoint } : {}),
    },
    schema: riffTurnResponseSchema,
    authMode: "user",
    auth: "required",
    timeoutMs: RIFF_TIMEOUT_MS,
  });
}

type PostDraftRiffSaveArgs = {
  draftId: string;
  sessionId: string;
  messageId: string;
  riffLabel: string | null;
};

/**
 * Save a Riff-generated recipe to the cookbook from a draft-anchored session
 * (Phase 13.9). The atomic save RPC (`save_draft_riff_recipe`, migration 023)
 * inserts the recipe, migrates the session to recipe-anchored, and deletes
 * the source draft — all in a single transaction.
 *
 * 409 with `detail: { code: "ALREADY_SAVED", recipe_id }` indicates an
 * idempotent retry: a previous save already migrated this session. The
 * helper propagates the ApiError unchanged; useDraftRiffSession's
 * saveMutation onError translates it into a graceful onSaveSuccess call.
 */
export async function postDraftRiffSave({
  draftId,
  sessionId,
  messageId,
  riffLabel,
}: PostDraftRiffSaveArgs): Promise<RiffSaveResponse> {
  return apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}/riff/save`,
    method: "POST",
    body: {
      session_id: sessionId,
      message_id: messageId,
      riff_label: riffLabel,
    },
    schema: riffSaveResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

type StreamDraftRiffTurnArgs = {
  draftId: string;
  message: string;
  sessionId?: string;
  entryPoint?: string;
  callbacks: RiffStreamCallbacks;
};

/**
 * Open a streaming draft-anchored Riff turn against
 * POST /api/drafts/{id}/riff/stream.
 *
 * Body, event listeners, parse helpers, and terminal-callback idempotency
 * are byte-identical to streamRiffTurn — the canonical reference. Only the
 * URL changes from /api/recipes/{id}/riff/stream to /api/drafts/{id}/riff/stream.
 * Maintain parity if streamRiffTurn evolves.
 *
 * Body shape: matches existing streamRiffTurn exactly. streamRiffTurn uses
 * `session_id: sessionId ?? null` (always-present), so streamDraftRiffTurn
 * uses the same shape.
 */
export async function streamDraftRiffTurn(
  args: StreamDraftRiffTurnArgs,
): Promise<RiffStreamHandle> {
  const { draftId, message, sessionId, entryPoint, callbacks } = args;

  const token = await getAccessToken();
  if (!token) {
    throw apiErrorFromValidation({
      message:
        "Authentication required, but no active session is available.",
    });
  }

  const url = `${env.EXPO_PUBLIC_API_BASE_URL}/api/drafts/${encodeURIComponent(
    draftId,
  )}/riff/stream`;

  const es = new EventSource<RiffEventName>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      session_id: sessionId ?? null,
      ...(entryPoint ? { entry_point: entryPoint } : {}),
    }),
    pollingInterval: 0, // §9 — no auto-reconnect
    withCredentials: false,
  });

  // Idempotency: only the first terminal callback (onError or onDone)
  // fires; subsequent close/error events from the library are suppressed.
  // Cancel sets terminated=true without firing a terminal callback.
  let terminated = false;

  const safeClose = () => {
    try {
      es.close();
    } catch {
      // ignore close errors during cleanup
    }
  };

  const fireTransportError = (
    code: RiffTransportError["code"],
    message: string,
    retryable: boolean,
  ) => {
    if (terminated) return;
    terminated = true;
    safeClose();
    callbacks.onError({ kind: "transport", code, message, retryable });
  };

  // Wire-shape parse helper — fail-fast on malformed events.
  const parseOrTransportError = <T>(
    schema: { safeParse: (x: unknown) => { success: boolean; data?: T } },
    raw: string | null,
    eventName: string,
  ): T | null => {
    if (raw === null) {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Empty data on ${eventName} event`,
        false,
      );
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Malformed JSON on ${eventName} event`,
        false,
      );
      return null;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        `Schema mismatch on ${eventName} event`,
        false,
      );
      return null;
    }
    return parsed.data as T;
  };

  es.addEventListener("session_resolved", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      sessionResolvedEventSchema,
      event.data,
      "session_resolved",
    );
    if (parsed) callbacks.onSessionResolved(parsed);
  });

  es.addEventListener("user_message_committed", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      userMessageCommittedEventSchema,
      event.data,
      "user_message_committed",
    );
    if (parsed) callbacks.onUserMessageCommitted(parsed);
  });

  es.addEventListener("assistant_delta", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      assistantDeltaEventSchema,
      event.data,
      "assistant_delta",
    );
    if (parsed) callbacks.onAssistantDelta(parsed);
  });

  es.addEventListener("assistant_complete", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      assistantCompleteEventSchema,
      event.data,
      "assistant_complete",
    );
    if (parsed) callbacks.onAssistantComplete(parsed);
  });

  es.addEventListener("generated_recipe_ready", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      generatedRecipeReadyEventSchema,
      event.data,
      "generated_recipe_ready",
    );
    if (parsed) callbacks.onGeneratedRecipeReady(parsed);
  });

  es.addEventListener("done", (event) => {
    if (terminated) return;
    const parsed = parseOrTransportError(
      doneEventSchema,
      event.data,
      "done",
    );
    if (parsed === null) return;
    terminated = true;
    safeClose();
    callbacks.onDone();
  });

  es.addEventListener("error", (event) => {
    if (terminated) return;
    if (event.type === "error") {
      const dataField = (event as unknown as { data?: string | null }).data;
      if (typeof dataField === "string" && dataField.length > 0) {
        let json: unknown;
        try {
          json = JSON.parse(dataField);
        } catch {
          json = null;
        }
        const parsed = riffStreamErrorEventSchema.safeParse(json);
        if (parsed.success) {
          terminated = true;
          safeClose();
          callbacks.onError(parsed.data);
          return;
        }
      }
      fireTransportError(
        "TRANSPORT_ERROR",
        event.message ||
          `Transport error (xhrStatus=${event.xhrStatus ?? "?"})`,
        false,
      );
    } else if (event.type === "timeout") {
      fireTransportError("TRANSPORT_TIMEOUT", "Stream timed out", true);
    } else if (event.type === "exception") {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        event.message || "Transport exception",
        false,
      );
    } else {
      fireTransportError(
        "TRANSPORT_EXCEPTION",
        "Unknown transport error",
        false,
      );
    }
  });

  es.addEventListener("close", () => {
    if (terminated) return;
    terminated = true;
    callbacks.onError({
      kind: "transport",
      code: "TRANSPORT_ERROR",
      message: "Stream closed before completion",
      retryable: false,
    });
  });

  return {
    cancel: () => {
      if (terminated) return;
      terminated = true;
      safeClose();
    },
  };
}
