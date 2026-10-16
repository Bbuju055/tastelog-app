import React, { useEffect } from "react";
import { Text, Pressable } from "react-native";
import { screen, fireEvent, act } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { Toast, useToast } from "../../components/Toast";
import { useTheme } from "../../theme/ThemeProvider";
import { lightPalette, darkPalette } from "../../theme/palettes";

/**
 * Forces the ThemeProvider into a specific preference during test render.
 * Same pattern as Skeleton.test.tsx.
 */
function ThemeForcer({ mode }: { mode: "light" | "dark" }) {
  const { setPreference } = useTheme();
  useEffect(() => {
    setPreference(mode);
  }, [mode, setPreference]);
  return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.flat(Infinity).filter(Boolean));
}

/** Harness that exposes the hook through buttons, mirroring screen usage. */
function ToastHarness({ onAction }: { onAction?: () => void }) {
  const { toast, showToast, dismissToast, toastOpacity } = useToast();
  return (
    <>
      <Pressable onPress={() => showToast({ message: "Saved to list" })}>
        <Text>show</Text>
      </Pressable>
      <Pressable onPress={() => showToast({ message: "Second message" })}>
        <Text>show-second</Text>
      </Pressable>
      <Toast
        toast={toast}
        opacity={toastOpacity}
        action={
          onAction
            ? {
                label: "View List",
                onPress: () => {
                  dismissToast();
                  onAction();
                },
              }
            : undefined
        }
      />
    </>
  );
}

describe("Toast (15.0.4)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test("renders nothing until shown, then shows the message", () => {
    renderWithTheme(<ToastHarness />);
    expect(screen.queryByText("Saved to list")).toBeNull();
    fireEvent.press(screen.getByText("show"));
    expect(screen.getByText("Saved to list")).toBeTruthy();
  });

  test("action press fires the callback", () => {
    const onAction = jest.fn();
    renderWithTheme(<ToastHarness onAction={onAction} />);
    fireEvent.press(screen.getByText("show"));
    fireEvent.press(screen.getByText("View List"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("auto-dismisses after 4s + fade", () => {
    renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    expect(screen.getByText("Saved to list")).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(4000); // display window
    });
    act(() => {
      jest.advanceTimersByTime(200); // fade-out completes → unmount
    });
    expect(screen.queryByText("Saved to list")).toBeNull();
  });

  test("re-show replaces the message and resets the 4s timer", () => {
    renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.press(screen.getByText("show-second"));
    expect(screen.getByText("Second message")).toBeTruthy();
    // 3s into the NEW window: would have expired on the old timer
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Second message")).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Second message")).toBeNull();
  });

  test("unmount clears the pending timer without warnings", () => {
    const { unmount } = renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    unmount();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    // No assertion beyond "does not throw / no state update on unmounted"
  });

  test("renders no action affordance when action is absent", () => {
    renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    expect(screen.getByText("Saved to list")).toBeTruthy();
    expect(screen.queryByText("View List")).toBeNull();
  });

  // 15.1.5 — success-token adoption: message text uses toastSuccessText.
  test("uses light success tokens in light theme", () => {
    renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    const label = screen.getByText("Saved to list");
    const flat = flattenStyle(label.props.style);
    expect(flat.color).toBe(lightPalette.toastSuccessText);
  });

  test("uses dark success tokens in dark theme", () => {
    renderWithTheme(
      <>
        <ThemeForcer mode="dark" />
        <ToastHarness />
      </>,
    );
    fireEvent.press(screen.getByText("show"));
    const label = screen.getByText("Saved to list");
    const flat = flattenStyle(label.props.style);
    expect(flat.color).toBe(darkPalette.toastSuccessText);
  });

  // 15.1.5 — fade-out race regression: a re-show during the dismiss fade
  // must survive. Pre-fix, the interrupted fade's callback (finished:
  // false) nulled the just-shown toast immediately.
  test("re-show during the dismiss fade survives the interrupted fade", () => {
    renderWithTheme(<ToastHarness />);
    fireEvent.press(screen.getByText("show"));
    act(() => {
      jest.advanceTimersByTime(4000); // dwell expires → fade-out starts
    });
    act(() => {
      jest.advanceTimersByTime(100); // mid-fade (exit runs 120ms)
    });
    fireEvent.press(screen.getByText("show-second")); // interrupts the fade
    expect(screen.getByText("Second message")).toBeTruthy();
    act(() => {
      // Past the point where the interrupted fade would have completed and
      // nulled the toast pre-fix; entrance also settles in this window.
      jest.advanceTimersByTime(300);
    });
    expect(screen.getByText("Second message")).toBeTruthy();
    // The re-shown toast still lives a full, normal lifecycle.
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Second message")).toBeNull();
  });
});
