import { act, renderHook } from "@testing-library/react-native";

// Capture event listeners passed to useSpeechRecognitionEvent so tests
// can fire synthetic events. Cleared in beforeEach so each test starts
// from a clean slate.
const mockListeners = new Map<string, (payload: unknown) => void>();

jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    requestMicrophonePermissionsAsync: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(
    (eventName: string, listener: (payload: unknown) => void) => {
      mockListeners.set(eventName, listener);
    },
  ),
}));

import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import {
  VOICE_COMMAND_START_OPTIONS,
  useVoiceCommands,
  type UseVoiceCommandsOptions,
} from "../../../lib/cooking/useVoiceCommands";

const mockModule = ExpoSpeechRecognitionModule as jest.Mocked<
  typeof ExpoSpeechRecognitionModule
>;

// Mock at the test boundary; the hook reads only `.granted` and
// `.canAskAgain`, so casting from a minimal stub is the cheapest way to
// satisfy Expo's PermissionResponse type without restating its full enum
// shape. `as` casts are confined to this file.
type SpeechPermResp = Awaited<
  ReturnType<typeof ExpoSpeechRecognitionModule.requestPermissionsAsync>
>;
type MicPermResp = Awaited<
  ReturnType<
    typeof ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync
  >
>;
const grantedSpeech = { granted: true, canAskAgain: true } as SpeechPermResp;
const grantedMic = { granted: true, canAskAgain: true } as MicPermResp;
const deniedSpeechAsk = { granted: false, canAskAgain: true } as SpeechPermResp;
const deniedSpeechNoAsk = {
  granted: false,
  canAskAgain: false,
} as SpeechPermResp;
const deniedMicAsk = { granted: false, canAskAgain: true } as MicPermResp;
const deniedMicNoAsk = { granted: false, canAskAgain: false } as MicPermResp;

function makeOptions(
  overrides: Partial<UseVoiceCommandsOptions> = {},
): UseVoiceCommandsOptions {
  return {
    enabled: false,
    onNext: jest.fn(),
    onBack: jest.fn(),
    onRepeat: jest.fn(),
    canGoNext: true,
    canGoPrev: true,
    isTransitioning: false,
    ...overrides,
  };
}

function fireResult(transcript: string, isFinal: boolean = true): void {
  act(() => {
    mockListeners.get("result")?.({
      isFinal,
      results: [{ transcript, confidence: 0.9, segments: [] }],
    });
  });
}

function fireError(code: string): void {
  act(() => {
    mockListeners.get("error")?.({ error: code, message: "x" });
  });
}

function fireEnd(): void {
  act(() => {
    mockListeners.get("end")?.(null);
  });
}

/**
 * Drives the hook through: render(disabled) -> grant permissions ->
 * rerender(enabled). Returns helpers with stable callback refs so tests
 * can verify which callback fires for a given transcript.
 */
async function setupGrantedAndEnabled(
  extraOptions: Partial<UseVoiceCommandsOptions> = {},
): Promise<{
  result: ReturnType<typeof renderHook<unknown, UseVoiceCommandsOptions>>["result"];
  callbacks: { onNext: jest.Mock; onBack: jest.Mock; onRepeat: jest.Mock };
  rerender: (overrides?: Partial<UseVoiceCommandsOptions>) => void;
  disable: (overrides?: Partial<UseVoiceCommandsOptions>) => void;
  unmount: () => void;
}> {
  mockModule.requestPermissionsAsync.mockResolvedValue(grantedSpeech);
  mockModule.requestMicrophonePermissionsAsync.mockResolvedValue(grantedMic);

  const callbacks = {
    onNext: jest.fn(),
    onBack: jest.fn(),
    onRepeat: jest.fn(),
  };
  const baseOpts = (
    overrides: Partial<UseVoiceCommandsOptions> = {},
  ): UseVoiceCommandsOptions => ({
    enabled: false,
    onNext: callbacks.onNext,
    onBack: callbacks.onBack,
    onRepeat: callbacks.onRepeat,
    canGoNext: true,
    canGoPrev: true,
    isTransitioning: false,
    ...extraOptions,
    ...overrides,
  });

  const { result, rerender, unmount } = renderHook(
    (opts: UseVoiceCommandsOptions) => useVoiceCommands(opts),
    { initialProps: baseOpts() },
  );
  await act(async () => {
    await result.current.requestPermissions();
  });
  rerender(baseOpts({ enabled: true }));

  return {
    result,
    callbacks,
    rerender: (overrides: Partial<UseVoiceCommandsOptions> = {}) =>
      rerender(baseOpts({ enabled: true, ...overrides })),
    disable: (overrides: Partial<UseVoiceCommandsOptions> = {}) =>
      rerender(baseOpts({ enabled: false, ...overrides })),
    unmount,
  };
}

describe("useVoiceCommands", () => {
  beforeEach(() => {
    mockListeners.clear();
    mockModule.start.mockReset();
    mockModule.stop.mockReset();
    mockModule.abort.mockReset();
    mockModule.requestPermissionsAsync.mockReset();
    mockModule.requestMicrophonePermissionsAsync.mockReset();
    jest.useRealTimers();
  });

  describe("initial state", () => {
    it("isListening starts false", () => {
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      expect(result.current.isListening).toBe(false);
    });
    it("permissionStatus starts undetermined", () => {
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      expect(result.current.permissionStatus).toBe("undetermined");
    });
    it("error starts null", () => {
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      expect(result.current.error).toBeNull();
    });
    it("lastCommand starts null", () => {
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      expect(result.current.lastCommand).toBeNull();
    });
  });

  describe("enable/disable lifecycle", () => {
    it("enabled=true after granted permissions calls start()", async () => {
      await setupGrantedAndEnabled();
      expect(mockModule.start).toHaveBeenCalledTimes(1);
    });
    it("calls start() with the spec VOICE_COMMAND_START_OPTIONS", async () => {
      await setupGrantedAndEnabled();
      expect(mockModule.start).toHaveBeenCalledWith(
        VOICE_COMMAND_START_OPTIONS,
      );
    });
    it("disable triggers abort()", async () => {
      const { disable } = await setupGrantedAndEnabled();
      disable();
      expect(mockModule.abort).toHaveBeenCalledTimes(1);
    });
    it("enabled=false from initial state does NOT call start()", () => {
      renderHook(() => useVoiceCommands(makeOptions({ enabled: false })));
      expect(mockModule.start).not.toHaveBeenCalled();
    });
    it("enabled=true without permission grant does NOT call start()", () => {
      renderHook(() => useVoiceCommands(makeOptions({ enabled: true })));
      expect(mockModule.start).not.toHaveBeenCalled();
    });
  });

  describe("permissions", () => {
    it("requests speech permission before microphone permission", async () => {
      const callOrder: string[] = [];
      mockModule.requestPermissionsAsync.mockImplementation(async () => {
        callOrder.push("speech");
        return grantedSpeech;
      });
      mockModule.requestMicrophonePermissionsAsync.mockImplementation(
        async () => {
          callOrder.push("mic");
          return grantedMic;
        },
      );
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      await act(async () => {
        await result.current.requestPermissions();
      });
      expect(callOrder).toEqual(["speech", "mic"]);
    });

    it("both granted returns true with status granted and error null", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(grantedSpeech);
      mockModule.requestMicrophonePermissionsAsync.mockResolvedValue(
        grantedMic,
      );
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      let returned: boolean | null = null;
      await act(async () => {
        returned = await result.current.requestPermissions();
      });
      expect(returned).toBe(true);
      expect(result.current.permissionStatus).toBe("granted");
      expect(result.current.error).toBeNull();
    });

    it("speech denied with canAskAgain=true sets denied + message excludes 'Settings'", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(deniedSpeechAsk);
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      let returned: boolean | null = null;
      await act(async () => {
        returned = await result.current.requestPermissions();
      });
      expect(returned).toBe(false);
      expect(result.current.permissionStatus).toBe("denied");
      expect(result.current.error).toMatch(/speech recognition/i);
      expect(result.current.error).not.toMatch(/Settings/);
    });

    it("speech denied with canAskAgain=false sets denied + message INCLUDES 'Settings'", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(deniedSpeechNoAsk);
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      let returned: boolean | null = null;
      await act(async () => {
        returned = await result.current.requestPermissions();
      });
      expect(returned).toBe(false);
      expect(result.current.permissionStatus).toBe("denied");
      expect(result.current.error).toMatch(/speech recognition/i);
      expect(result.current.error).toMatch(/Settings/);
    });

    it("mic denied with canAskAgain=true sets denied + message excludes 'Settings'", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(grantedSpeech);
      mockModule.requestMicrophonePermissionsAsync.mockResolvedValue(
        deniedMicAsk,
      );
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      let returned: boolean | null = null;
      await act(async () => {
        returned = await result.current.requestPermissions();
      });
      expect(returned).toBe(false);
      expect(result.current.permissionStatus).toBe("denied");
      expect(result.current.error).toMatch(/microphone/i);
      expect(result.current.error).not.toMatch(/Settings/);
    });

    it("mic denied with canAskAgain=false sets denied + message INCLUDES 'Settings'", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(grantedSpeech);
      mockModule.requestMicrophonePermissionsAsync.mockResolvedValue(
        deniedMicNoAsk,
      );
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      let returned: boolean | null = null;
      await act(async () => {
        returned = await result.current.requestPermissions();
      });
      expect(returned).toBe(false);
      expect(result.current.permissionStatus).toBe("denied");
      expect(result.current.error).toMatch(/microphone/i);
      expect(result.current.error).toMatch(/Settings/);
    });

    it("repeated requestPermissions resolves cleanly", async () => {
      mockModule.requestPermissionsAsync.mockResolvedValue(grantedSpeech);
      mockModule.requestMicrophonePermissionsAsync.mockResolvedValue(
        grantedMic,
      );
      const { result } = renderHook(() => useVoiceCommands(makeOptions()));
      await act(async () => {
        await result.current.requestPermissions();
      });
      await act(async () => {
        await result.current.requestPermissions();
      });
      expect(result.current.permissionStatus).toBe("granted");
      expect(result.current.error).toBeNull();
    });
  });

  describe("result event command dispatch", () => {
    it("'next' transcript fires onNext and updates lastCommand", async () => {
      const { result, callbacks } = await setupGrantedAndEnabled();
      fireResult("next");
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
      expect(callbacks.onBack).not.toHaveBeenCalled();
      expect(callbacks.onRepeat).not.toHaveBeenCalled();
      expect(result.current.lastCommand).toBe("next");
    });
    it("'back' transcript fires onBack and updates lastCommand", async () => {
      const { result, callbacks } = await setupGrantedAndEnabled();
      fireResult("back");
      expect(callbacks.onBack).toHaveBeenCalledTimes(1);
      expect(result.current.lastCommand).toBe("back");
    });
    it("'repeat' transcript fires onRepeat and updates lastCommand", async () => {
      const { result, callbacks } = await setupGrantedAndEnabled();
      fireResult("repeat");
      expect(callbacks.onRepeat).toHaveBeenCalledTimes(1);
      expect(result.current.lastCommand).toBe("repeat");
    });
    it("empty transcript fires no callback and lastCommand stays null", async () => {
      const { result, callbacks } = await setupGrantedAndEnabled();
      fireResult("");
      expect(callbacks.onNext).not.toHaveBeenCalled();
      expect(callbacks.onBack).not.toHaveBeenCalled();
      expect(callbacks.onRepeat).not.toHaveBeenCalled();
      expect(result.current.lastCommand).toBeNull();
    });
    it("conversational noise fires no callback", async () => {
      const { result, callbacks } = await setupGrantedAndEnabled();
      fireResult("how long should I stir");
      expect(callbacks.onNext).not.toHaveBeenCalled();
      expect(result.current.lastCommand).toBeNull();
    });
    it("last-match-wins propagates: 'please go back' fires onBack only", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("please go back");
      expect(callbacks.onBack).toHaveBeenCalledTimes(1);
      expect(callbacks.onNext).not.toHaveBeenCalled();
    });
  });

  describe("interim + cycle dedup (Gate 9.C-VT)", () => {
    it("interim event fires the command for low latency", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false);
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
    });

    it("interim followed by final with same command fires once (cycle dedup)", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false);
      fireResult("next", true);
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
    });

    it("two interim events of same command in one cycle fire once", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false);
      fireResult("next", false);
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
    });

    it("isFinal resets the cycle so the next utterance can fire the same command", async () => {
      jest.useFakeTimers({ now: 0 });
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false); // utterance 1 interim — fires
      fireResult("next", true); // utterance 1 final — cycle blocks, then resets
      jest.advanceTimersByTime(2000); // pass debounce
      fireResult("next", false); // utterance 2 interim — fires
      expect(callbacks.onNext).toHaveBeenCalledTimes(2);
    });

    it("end event resets the cycle as defense-in-depth", async () => {
      jest.useFakeTimers({ now: 0 });
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false); // interim — fires, cycle locked
      fireEnd(); // session end — cycle resets
      jest.advanceTimersByTime(2000); // pass debounce
      fireResult("next", false); // new cycle interim — fires
      expect(callbacks.onNext).toHaveBeenCalledTimes(2);
    });

    it("same-utterance correction within debounce: 'next' then 'back' fires next, back blocked", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false); // interim — fires next, cycle locked
      fireResult("back", false); // interim — different command, cycle blocks (debounce too)
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
      expect(callbacks.onBack).not.toHaveBeenCalled();
    });

    it("cycle lock blocks a second command even past the debounce window", async () => {
      jest.useFakeTimers({ now: 0 });
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next", false); // interim — fires next, cycle locked
      jest.advanceTimersByTime(2000); // past 1500ms debounce
      fireResult("back", false); // interim — cycle still locked, debounce no longer applies
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
      expect(callbacks.onBack).not.toHaveBeenCalled();
    });
  });

  describe("command guards", () => {
    it("isTransitioning blocks 'next'", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ isTransitioning: true });
      fireResult("next");
      expect(callbacks.onNext).not.toHaveBeenCalled();
    });
    it("isTransitioning blocks 'repeat' too", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ isTransitioning: true });
      fireResult("repeat");
      expect(callbacks.onRepeat).not.toHaveBeenCalled();
    });
    it("canGoNext=false blocks 'next'", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ canGoNext: false });
      fireResult("next");
      expect(callbacks.onNext).not.toHaveBeenCalled();
    });
    it("canGoPrev=false blocks 'back'", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ canGoPrev: false });
      fireResult("back");
      expect(callbacks.onBack).not.toHaveBeenCalled();
    });
    it("canGoNext=false does NOT block 'repeat'", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ canGoNext: false });
      fireResult("repeat");
      expect(callbacks.onRepeat).toHaveBeenCalledTimes(1);
    });
    it("canGoPrev=false does NOT block 'repeat'", async () => {
      const { rerender, callbacks } = await setupGrantedAndEnabled();
      rerender({ canGoPrev: false });
      fireResult("repeat");
      expect(callbacks.onRepeat).toHaveBeenCalledTimes(1);
    });
  });

  describe("debounce", () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: 0 });
    });

    it("two 'next' events within 1500ms — second is ignored", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next");
      jest.advanceTimersByTime(1499);
      fireResult("next");
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
    });
    it("two 'next' events 1500ms apart — both fire", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next");
      jest.advanceTimersByTime(1500);
      fireResult("next");
      expect(callbacks.onNext).toHaveBeenCalledTimes(2);
    });
    it("debounce is global across commands: 'next' then 'back' within window — 'back' ignored", async () => {
      const { callbacks } = await setupGrantedAndEnabled();
      fireResult("next");
      jest.advanceTimersByTime(500);
      fireResult("back");
      expect(callbacks.onNext).toHaveBeenCalledTimes(1);
      expect(callbacks.onBack).not.toHaveBeenCalled();
    });
  });

  describe("auto-restart and circuit breaker", () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: 0 });
    });

    it("'end' event with enabled=true triggers start() after 300ms", async () => {
      await setupGrantedAndEnabled();
      mockModule.start.mockClear();
      fireEnd();
      expect(mockModule.start).not.toHaveBeenCalled();
      jest.advanceTimersByTime(300);
      expect(mockModule.start).toHaveBeenCalledWith(
        VOICE_COMMAND_START_OPTIONS,
      );
    });

    it("'end' event with enabled=false does NOT trigger start()", async () => {
      const { disable } = await setupGrantedAndEnabled();
      disable();
      mockModule.start.mockClear();
      fireEnd();
      jest.advanceTimersByTime(300);
      expect(mockModule.start).not.toHaveBeenCalled();
    });

    it("3 non-aborted/non-not-allowed/non-no-speech errors trip the circuit", async () => {
      const { result } = await setupGrantedAndEnabled();
      fireError("audio-capture");
      fireError("audio-capture");
      fireError("audio-capture");
      expect(result.current.error).toMatch(/stopped responding/i);
      mockModule.start.mockClear();
      fireEnd();
      jest.advanceTimersByTime(300);
      expect(mockModule.start).not.toHaveBeenCalled();
    });

    it("disable then enable after circuit trip resets the counter and restarts", async () => {
      const { result, disable, rerender } = await setupGrantedAndEnabled();
      fireError("audio-capture");
      fireError("audio-capture");
      fireError("audio-capture");
      expect(result.current.error).toMatch(/stopped responding/i);
      disable();
      mockModule.start.mockClear();
      rerender();
      expect(mockModule.start).toHaveBeenCalledWith(
        VOICE_COMMAND_START_OPTIONS,
      );
    });
  });

  describe("error handling", () => {
    it("'not-allowed' sets permissionStatus=denied with a microphone-denied message", async () => {
      const { result } = await setupGrantedAndEnabled();
      fireError("not-allowed");
      expect(result.current.permissionStatus).toBe("denied");
      expect(result.current.error).toMatch(/microphone/i);
    });
    it("'aborted' from a self-initiated abort is suppressed", async () => {
      const { result, disable } = await setupGrantedAndEnabled();
      disable();
      fireError("aborted");
      expect(result.current.error).toBeNull();
      expect(result.current.permissionStatus).toBe("granted");
    });
    it("'no-speech' is silent and does not trip the circuit breaker", async () => {
      const { result } = await setupGrantedAndEnabled();
      fireError("no-speech");
      fireError("no-speech");
      fireError("no-speech");
      expect(result.current.error).toBeNull();
    });
    it("3 non-special-cased errors count toward the circuit breaker", async () => {
      const { result } = await setupGrantedAndEnabled();
      fireError("network");
      expect(result.current.error).toBeNull();
      fireError("network");
      expect(result.current.error).toBeNull();
      fireError("network");
      expect(result.current.error).toMatch(/stopped responding/i);
    });
  });

  describe("unmount cleanup", () => {
    it("unmount while active calls abort()", async () => {
      const { unmount } = await setupGrantedAndEnabled();
      mockModule.abort.mockClear();
      unmount();
      expect(mockModule.abort).toHaveBeenCalledTimes(1);
    });
    it("unmount cancels any pending restart timer", async () => {
      jest.useFakeTimers({ now: 0 });
      const { unmount } = await setupGrantedAndEnabled();
      fireEnd();
      mockModule.start.mockClear();
      unmount();
      jest.advanceTimersByTime(300);
      expect(mockModule.start).not.toHaveBeenCalled();
    });
  });
});
