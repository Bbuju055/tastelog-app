import React from "react";
import { AccessibilityInfo, AppState, Modal, Platform } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { motion } from "../../theme";
import { lightPalette, darkPalette } from "../../theme/palettes";
import { useTheme } from "../../theme/ThemeProvider";
import { Path } from "react-native-svg";

/** Forces the ThemeProvider into a specific preference (same as Button.test). */
function ThemeForcer({ mode }: { mode: "light" | "dark" }) {
  const { setPreference } = useTheme();
  React.useEffect(() => {
    setPreference(mode);
  }, [mode, setPreference]);
  return null;
}

// ---------------------------------------------------------------------------
// 15.2.2 — SuccessBeat lifecycle: dwell selection, exactly-once completion,
// tap skip, AppState resume, Reduce Motion, accessibility, Modal contract.
// ---------------------------------------------------------------------------

const mockHapticSuccess = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: (...args: unknown[]) => mockHapticSuccess(...args),
}));

const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

// Reanimated's compiled exports are non-configurable, so jest.spyOn cannot
// wrap withTiming. Partial module mock: identical module with a
// pass-through withTiming that records its calls.
const mockWithTiming = jest.fn();
jest.mock("react-native-reanimated", () => {
  const actual = jest.requireActual("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    default: actual.default,
    withTiming: (...args: unknown[]) => {
      mockWithTiming(...args);
      return (actual.withTiming as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import {
  SuccessBeat,
  SUCCESS_BEAT_SCREEN_READER_DWELL_MS,
} from "../../components/SuccessBeat";

// Module-scope spies, never restored: restoring a spy over jest-expo's
// preset mocks wipes the preset implementation for the rest of the file
// (see AddCaptureStageReducedMotion.test.tsx).
const appStateSpy = jest.spyOn(AppState, "addEventListener");
let srResolve: ((v: boolean) => void) | null = null;
let srReject: ((e: Error) => void) | null = null;
jest
  .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
  .mockImplementation(
    () =>
      new Promise<boolean>((resolve, reject) => {
        srResolve = resolve;
        srReject = reject;
      }),
  );

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

async function settle() {
  await act(async () => {});
}

function emitAppStateActive() {
  act(() => {
    for (const call of appStateSpy.mock.calls) {
      (call[1] as (state: string) => void)("active");
    }
  });
}

function renderBeat(
  overrides: Partial<React.ComponentProps<typeof SuccessBeat>> = {},
) {
  const onComplete = jest.fn();
  const view = renderWithTheme(
    <SuccessBeat
      title="Recipe captured"
      accessibilityHint="Opens the draft for review."
      variant="full"
      startedAt={Date.now()}
      onComplete={onComplete}
      {...overrides}
    />,
  );
  return { onComplete, view };
}

describe("SuccessBeat (15.2.2)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHapticSuccess.mockReset();
    mockWithTiming.mockClear();
    appStateSpy.mockClear();
    srResolve = null;
    srReject = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    mockUseReducedMotion.mockImplementation(() => false);
  });

  it("keeps the conservative 2000ms deadline while the screen-reader query is unresolved", async () => {
    const { onComplete } = renderBeat();
    await settle();

    advance(motion.duration.beat);
    expect(onComplete).not.toHaveBeenCalled();

    advance(SUCCESS_BEAT_SCREEN_READER_DWELL_MS - motion.duration.beat);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shortens the dwell to 700ms when the query resolves false", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    advance(motion.duration.beat - 1);
    expect(onComplete).not.toHaveBeenCalled();
    advance(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    advance(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("completes immediately when the query resolves false after 700ms already passed", async () => {
    const { onComplete } = renderBeat();
    await settle();
    advance(800);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      srResolve?.(false);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("retains the 2000ms dwell when the query resolves true", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(true);
    });

    advance(motion.duration.beat);
    expect(onComplete).not.toHaveBeenCalled();
    advance(SUCCESS_BEAT_SCREEN_READER_DWELL_MS - motion.duration.beat);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("retains the 2000ms dwell when the query rejects", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srReject?.(new Error("unavailable"));
    });

    advance(motion.duration.beat);
    expect(onComplete).not.toHaveBeenCalled();
    advance(SUCCESS_BEAT_SCREEN_READER_DWELL_MS - motion.duration.beat);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("tap skips the remaining dwell — repeated taps complete exactly once", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    fireEvent.press(screen.getByLabelText("Recipe captured"));
    expect(onComplete).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByLabelText("Recipe captured"));
    advance(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("timer completion followed by a tap still completes exactly once", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    advance(motion.duration.beat);
    expect(onComplete).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByLabelText("Recipe captured"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("AppState resume past the deadline completes exactly once", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    // Suspended timer: the clock passes the deadline without firing.
    act(() => {
      jest.setSystemTime(Date.now() + 800);
    });
    emitAppStateActive();
    expect(onComplete).toHaveBeenCalledTimes(1);

    advance(10_000);
    emitAppStateActive();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("AppState resume before the deadline re-arms the remaining dwell", async () => {
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    act(() => {
      jest.setSystemTime(Date.now() + 300);
    });
    emitAppStateActive();
    expect(onComplete).not.toHaveBeenCalled();

    advance(motion.duration.beat - 300);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("unmount clears the dwell timer — no late completion", async () => {
    const { onComplete, view } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    view.unmount();
    advance(10_000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("fires the success haptic once; a throwing haptic never blocks completion", async () => {
    mockHapticSuccess.mockImplementationOnce(() => {
      throw new Error("haptics unavailable");
    });
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    expect(mockHapticSuccess).toHaveBeenCalledTimes(1);
    advance(motion.duration.beat);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("draws the checkmark over motion.duration.beat", async () => {
    renderBeat();
    await settle();

    expect(mockWithTiming).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: motion.duration.beat }),
    );
  });

  it("reduce motion renders the completed checkmark with no draw timing and the same dwell", async () => {
    mockUseReducedMotion.mockImplementation(() => true);
    const { onComplete } = renderBeat();
    await act(async () => {
      srResolve?.(false);
    });

    expect(mockWithTiming).not.toHaveBeenCalled();
    advance(motion.duration.beat - 1);
    expect(onComplete).not.toHaveBeenCalled();
    advance(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Modal contract: opaque, full-screen, no native animation; Android back skips once", async () => {
    const { onComplete } = renderBeat();
    await settle();

    const modal = screen.UNSAFE_getByType(
      Modal as unknown as React.ComponentType,
    );
    expect(modal.props.transparent).toBe(false);
    expect(modal.props.animationType).toBe("none");
    expect(modal.props.presentationStyle).toBe("fullScreen");
    expect(typeof modal.props.onRequestClose).toBe("function");

    act(() => {
      modal.props.onRequestClose();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    act(() => {
      modal.props.onRequestClose();
    });
    advance(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("exposes one accessible action with label, hint, and modal semantics", async () => {
    renderBeat();
    await settle();

    const beat = screen.getByTestId("success-beat");
    expect(beat.props.accessibilityRole).toBe("button");
    expect(beat.props.accessibilityLabel).toBe("Recipe captured");
    expect(beat.props.accessibilityHint).toBe("Opens the draft for review.");
    expect(beat.props.accessibilityViewIsModal).toBe(true);
  });

  it("default tone strokes the mark with palette.success (shipped capture look)", async () => {
    const { view } = renderBeat();
    await settle();
    expect(view.UNSAFE_getByType(Path).props.stroke).toBe(lightPalette.success);
  });

  it("reward tone strokes the mark with palette.reward (cooking completion)", async () => {
    const { view } = renderBeat({ tone: "reward" });
    await settle();
    expect(view.UNSAFE_getByType(Path).props.stroke).toBe(lightPalette.reward);
  });

  it("reward tone uses the dark reward token under dark theme", async () => {
    const onComplete = jest.fn();
    const view = renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <SuccessBeat
          title="Nicely done"
          accessibilityHint="Continue to log your cook."
          tone="reward"
          startedAt={Date.now()}
          onComplete={onComplete}
        />
      </>,
    );
    await settle();
    expect(view.UNSAFE_getByType(Path).props.stroke).toBe(darkPalette.reward);
  });

  it("compact variant renders its own visible and accessible copy", async () => {
    renderBeat({
      variant: "compact",
      title: "Saved to your cookbook",
      accessibilityHint: "Opens your saved recipe.",
    });
    await settle();

    expect(screen.getByLabelText("Saved to your cookbook")).toBeTruthy();
    expect(screen.getByText("Saved to your cookbook")).toBeTruthy();
    expect(
      screen.getByTestId("success-beat").props.accessibilityHint,
    ).toBe("Opens your saved recipe.");
  });

  // -------------------------------------------------------------------------
  // waitForDismiss (15.2.3-CF) — native-dismissal completion ordering.
  // -------------------------------------------------------------------------
  describe("waitForDismiss ordering", () => {
    function getModal() {
      return screen.UNSAFE_getByType(Modal as unknown as React.ComponentType);
    }

    it("default (omitted): tap completes immediately, Modal stays visible, no dismissal wait", async () => {
      const { onComplete } = renderBeat();
      await act(async () => {
        srResolve?.(false);
      });

      fireEvent.press(screen.getByLabelText("Recipe captured"));
      // onComplete fires now — no onDismiss needed. Modal is dismissed by the
      // parent unmounting the beat, so visible remains true here.
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(getModal().props.visible).toBe(true);
    });

    it("iOS opt-in: completing hides the Modal but defers onComplete until onDismiss", async () => {
      const { onComplete } = renderBeat({ waitForDismiss: true });
      await act(async () => {
        srResolve?.(false);
      });

      // Complete the beat (tap). onComplete must NOT fire yet.
      fireEvent.press(screen.getByLabelText("Recipe captured"));
      expect(onComplete).not.toHaveBeenCalled();

      // The controlled Modal is now hidden — its native dismissal is what will
      // eventually emit onDismiss.
      expect(getModal().props.visible).toBe(false);

      // Native dismissal completes → onComplete fires exactly once.
      act(() => {
        getModal().props.onDismiss();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("iOS opt-in: dwell expiry also defers onComplete to onDismiss", async () => {
      const { onComplete } = renderBeat({ waitForDismiss: true });
      await act(async () => {
        srResolve?.(false);
      });

      advance(motion.duration.beat);
      // Dwell elapsed: Modal hidden, but onComplete waits for native dismissal.
      expect(onComplete).not.toHaveBeenCalled();
      expect(getModal().props.visible).toBe(false);

      act(() => {
        getModal().props.onDismiss();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("iOS opt-in: repeated completion triggers and repeated onDismiss cannot duplicate onComplete", async () => {
      const { onComplete } = renderBeat({ waitForDismiss: true });
      await act(async () => {
        srResolve?.(false);
      });

      // Multiple completion attempts before dismissal. The first (tap) hides
      // the Modal — which unmounts its pressable child under the jest preset —
      // so subsequent triggers go through the still-reachable onRequestClose;
      // completedRef makes every attempt after the first inert.
      fireEvent.press(screen.getByLabelText("Recipe captured"));
      act(() => {
        getModal().props.onRequestClose();
      });
      act(() => {
        getModal().props.onRequestClose();
      });
      expect(onComplete).not.toHaveBeenCalled();

      // Multiple native dismissal callbacks.
      act(() => {
        getModal().props.onDismiss();
      });
      act(() => {
        getModal().props.onDismiss();
      });
      advance(10_000);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("Android opt-in: completes directly and exactly once without an iOS dismissal event", async () => {
      const original = Platform.OS;
      // @ts-expect-error test-only platform override
      Platform.OS = "android";
      try {
        const { onComplete } = renderBeat({ waitForDismiss: true });
        await act(async () => {
          srResolve?.(false);
        });

        fireEvent.press(screen.getByLabelText("Recipe captured"));
        // No onDismiss driven — Android completes directly.
        expect(onComplete).toHaveBeenCalledTimes(1);

        // Repeated taps do not duplicate.
        fireEvent.press(screen.getByLabelText("Recipe captured"));
        advance(10_000);
        expect(onComplete).toHaveBeenCalledTimes(1);
      } finally {
        // @ts-expect-error restore
        Platform.OS = original;
      }
    });
  });
});
