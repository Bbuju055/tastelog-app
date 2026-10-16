/**
 * Voice Commands Hook
 *
 * Runtime / state-machine layer for Phase 9.C Cooking Mode voice control.
 * Spec: docs/phase9c-voice-commands.md §3, §4, §5, §6, §8.
 *
 * Architecture:
 * - Pure callback dispatch — never calls haptics. The cook-screen handlers
 *   own haptics; voice fires the same handlers, so haptics happen for free.
 * - Permission flow is lazy: nothing is requested on mount. The cook screen
 *   calls `requestPermissions()` on first toggle.
 * - Audio session uses `mixWithOthers` so background music keeps playing.
 * - Recognition runs on-device (`requiresOnDeviceRecognition: true`) so the
 *   feature works offline and has no network latency.
 *
 * Command guard sequence (spec §5.3, applied per result event):
 *   1. parseVoiceCommand → null      → ignore
 *   2. within DEBOUNCE_MS of last fire → ignore
 *   3. options.isTransitioning        → ignore
 *   4. "next"   AND !canGoNext        → ignore
 *   5. "back"   AND !canGoPrev        → ignore
 *   6. "repeat" is bounds-free         (spec §8: works on single-step recipe)
 *   7. fire callback + update lastCommand
 *
 * Auto-restart and circuit breaker:
 * - On the native "end" event (iOS silence timeout or natural session
 *   close), if still enabled and not circuit-tripped, schedule a 300 ms
 *   restart. Three restart-related failures within 10 s trip the circuit;
 *   the user must toggle off-then-on to retry.
 * - Self-initiated abort (toggle-off / unmount) emits an "error" event
 *   with code "aborted". This is suppressed via `intentionalAbortRef`;
 *   it does NOT count toward the circuit breaker and does NOT surface
 *   as a user-visible error.
 * - "no-speech" errors (silence) are quiet — auto-restart on "end"
 *   handles them.
 *
 * Permission denial messaging:
 * - When a permission is denied with `canAskAgain: true`, the message
 *   omits Settings (a fresh request will re-prompt).
 * - When denied with `canAskAgain: false`, the message includes a
 *   "Open Settings" hint so the cook screen can render an affordance.
 * - The hook never imports Linking; opening Settings is a UI concern
 *   (slice 4).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionOptions,
  type ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";

import { parseVoiceCommand, type VoiceCommand } from "./parseVoiceCommand";

export type VoiceCommandsPermissionStatus =
  | "undetermined"
  | "granted"
  | "denied";

export type UseVoiceCommandsOptions = {
  enabled: boolean;
  onNext: () => void;
  onBack: () => void;
  onRepeat: () => void;
  canGoNext: boolean;
  canGoPrev: boolean;
  isTransitioning: boolean;
};

export type UseVoiceCommandsResult = {
  isListening: boolean;
  lastCommand: VoiceCommand;
  permissionStatus: VoiceCommandsPermissionStatus;
  error: string | null;
  requestPermissions: () => Promise<boolean>;
};

const DEBOUNCE_MS = 1500;
const RESTART_DELAY_MS = 300;
const MAX_RESTART_FAILURES = 3;
const RESTART_FAILURE_WINDOW_MS = 10_000;

/**
 * Spec §6 verbatim. Module-level export so tests can assert call args
 * without duplicating the spec strings.
 */
export const VOICE_COMMAND_START_OPTIONS: ExpoSpeechRecognitionOptions = {
  lang: "en-US",
  continuous: true,
  interimResults: true,
  requiresOnDeviceRecognition: true,
  iosTaskHint: "confirmation",
  contextualStrings: ["next", "back", "repeat", "previous", "forward", "again"],
  iosCategory: {
    category: "playAndRecord",
    categoryOptions: ["mixWithOthers", "defaultToSpeaker"],
  },
};

const ERROR_MESSAGE_SPEECH_DENIED = "Speech recognition access was denied.";
const ERROR_MESSAGE_SPEECH_DENIED_OPEN_SETTINGS =
  "Speech recognition access was denied. Open Settings to enable it.";
const ERROR_MESSAGE_MIC_DENIED = "Microphone access was denied.";
const ERROR_MESSAGE_MIC_DENIED_OPEN_SETTINGS =
  "Microphone access was denied. Open Settings to enable it.";
const ERROR_MESSAGE_CIRCUIT_TRIPPED =
  "Voice recognition stopped responding. Toggle voice off and on to retry.";

export function useVoiceCommands(
  options: UseVoiceCommandsOptions,
): UseVoiceCommandsResult {
  const [isListening, setIsListening] = useState(false);
  const [lastCommand, setLastCommand] = useState<VoiceCommand>(null);
  const [permissionStatus, setPermissionStatus] =
    useState<VoiceCommandsPermissionStatus>("undetermined");
  const [error, setError] = useState<string | null>(null);

  // Latest options held in a ref so event listeners read the current
  // canGoNext / isTransitioning / callbacks without re-subscribing.
  const optionsRef = useRef<UseVoiceCommandsOptions>(options);
  optionsRef.current = options;

  // NEGATIVE_INFINITY sentinel: the very first command can never be
  // debounced, even when Date.now() starts at 0 under fake-timers tests.
  const lastCommandTimeRef = useRef<number>(Number.NEGATIVE_INFINITY);

  // Tracks which command (if any) has fired during the current iOS
  // recognition cycle. Reset on isFinal events (utterance boundary) and
  // on "end" events (session boundary, defense-in-depth). Prevents
  // interim+final pairs from double-firing the same command. See
  // Gate 9.C-VT.
  const firedCommandInCurrentCycleRef = useRef<VoiceCommand | null>(null);

  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartFailureCountRef = useRef<number>(0);
  const restartFailureWindowStartRef = useRef<number>(0);
  const circuitTrippedRef = useRef<boolean>(false);

  // Set true immediately before any self-initiated abort() call. The
  // following "error" event with code "aborted" is then suppressed.
  const intentionalAbortRef = useRef<boolean>(false);

  function clearRestartTimer(): void {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }

  function recordRestartFailure(): void {
    const now = Date.now();
    if (
      restartFailureCountRef.current === 0 ||
      now - restartFailureWindowStartRef.current > RESTART_FAILURE_WINDOW_MS
    ) {
      restartFailureWindowStartRef.current = now;
      restartFailureCountRef.current = 1;
    } else {
      restartFailureCountRef.current += 1;
    }
    if (restartFailureCountRef.current >= MAX_RESTART_FAILURES) {
      circuitTrippedRef.current = true;
      clearRestartTimer();
      setError(ERROR_MESSAGE_CIRCUIT_TRIPPED);
      setIsListening(false);
    }
  }

  function resetRestartFailureTracking(): void {
    restartFailureCountRef.current = 0;
    restartFailureWindowStartRef.current = 0;
    circuitTrippedRef.current = false;
  }

  useSpeechRecognitionEvent("start", () => {
    setIsListening(true);
  });

  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
    // Defense-in-depth cycle reset: the result handler also resets on
    // isFinal events, but iOS may emit "end" without a preceding final.
    firedCommandInCurrentCycleRef.current = null;
    if (!optionsRef.current.enabled) return;
    if (circuitTrippedRef.current) return;
    clearRestartTimer();
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      try {
        ExpoSpeechRecognitionModule.start(VOICE_COMMAND_START_OPTIONS);
      } catch {
        recordRestartFailure();
      }
    }, RESTART_DELAY_MS);
  });

  useSpeechRecognitionEvent(
    "error",
    (event: ExpoSpeechRecognitionErrorEvent) => {
      if (event.error === "aborted" && intentionalAbortRef.current) {
        intentionalAbortRef.current = false;
        return;
      }
      if (event.error === "not-allowed") {
        setPermissionStatus("denied");
        setError(ERROR_MESSAGE_MIC_DENIED);
        circuitTrippedRef.current = true;
        clearRestartTimer();
        setIsListening(false);
        return;
      }
      if (event.error === "no-speech") {
        // Quiet kitchen / silence timeout. Auto-restart on "end" recovers.
        return;
      }
      recordRestartFailure();
    },
  );

  useSpeechRecognitionEvent(
    "result",
    (event: ExpoSpeechRecognitionResultEvent) => {
      // Process interim AND final events for low-latency dispatch — iOS
      // finalization waits for silence (~500ms-1.5s after the user stops
      // speaking), which made commands feel laggy when we acted only on
      // final events. The cycle ref locks the utterance after the first
      // command fires; ANY subsequent command — same OR different — is
      // blocked until the cycle resets. The cycle resets in the finally
      // block on isFinal events (utterance boundary) and in the "end"
      // handler (defense-in-depth). The existing 1500ms debounce stays
      // as a backstop. Trade-off pinned by tests: same-utterance
      // corrections like "next, wait, back" no longer succeed since the
      // first command locks the cycle until the utterance ends.
      try {
        const transcript = event.results[0]?.transcript ?? "";
        const command = parseVoiceCommand(transcript);
        if (command === null) return;

        // Cycle lock: any prior command accepted in this utterance wins.
        if (firedCommandInCurrentCycleRef.current !== null) return;

        const now = Date.now();
        if (now - lastCommandTimeRef.current < DEBOUNCE_MS) return;

        const opts = optionsRef.current;
        if (opts.isTransitioning) return;
        if (command === "next" && !opts.canGoNext) return;
        if (command === "back" && !opts.canGoPrev) return;

        lastCommandTimeRef.current = now;
        firedCommandInCurrentCycleRef.current = command;
        setLastCommand(command);

        if (command === "next") opts.onNext();
        else if (command === "back") opts.onBack();
        else opts.onRepeat();
      } finally {
        if (event.isFinal) {
          firedCommandInCurrentCycleRef.current = null;
        }
      }
    },
  );

  useEffect(() => {
    if (options.enabled && permissionStatus === "granted") {
      resetRestartFailureTracking();
      try {
        ExpoSpeechRecognitionModule.start(VOICE_COMMAND_START_OPTIONS);
      } catch {
        recordRestartFailure();
      }
      return () => {
        intentionalAbortRef.current = true;
        clearRestartTimer();
        ExpoSpeechRecognitionModule.abort();
      };
    }
    return () => {
      clearRestartTimer();
    };
  }, [options.enabled, permissionStatus]);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    const speech =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!speech.granted) {
      setPermissionStatus("denied");
      setError(
        speech.canAskAgain
          ? ERROR_MESSAGE_SPEECH_DENIED
          : ERROR_MESSAGE_SPEECH_DENIED_OPEN_SETTINGS,
      );
      return false;
    }
    const mic =
      await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync();
    if (!mic.granted) {
      setPermissionStatus("denied");
      setError(
        mic.canAskAgain
          ? ERROR_MESSAGE_MIC_DENIED
          : ERROR_MESSAGE_MIC_DENIED_OPEN_SETTINGS,
      );
      return false;
    }
    setPermissionStatus("granted");
    setError(null);
    return true;
  }, []);

  return {
    isListening,
    lastCommand,
    permissionStatus,
    error,
    requestPermissions,
  };
}
