import { act, renderHook } from "@testing-library/react-native";

// ---------------------------------------------------------------------------
// Per-file @react-navigation/native override (replaces the jest.setup.js
// stub for THIS file only): captures the guard's focus callback + cleanup so
// tests can simulate blur/refocus without unmounting, and records every
// distinct callback identity so callback stability is directly assertable.
// ---------------------------------------------------------------------------

type FocusCb = () => void | (() => void);
const mockFocusControl: {
  cb: FocusCb | null;
  cleanup: (() => void) | null;
  seenCbs: Set<FocusCb>;
} = { cb: null, cleanup: null, seenCbs: new Set() };

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: FocusCb) => {
    const { useEffect } = require("react");
    mockFocusControl.cb = cb;
    mockFocusControl.seenCbs.add(cb);
    useEffect(() => {
      const cleanup = cb();
      if (typeof cleanup === "function") {
        mockFocusControl.cleanup = cleanup;
        return cleanup;
      }
      return undefined;
    }, [cb]);
  },
}));

import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";

function simulateBlur(): void {
  act(() => {
    mockFocusControl.cleanup?.();
  });
}

function simulateRefocus(): void {
  act(() => {
    const c = mockFocusControl.cb?.();
    if (typeof c === "function") mockFocusControl.cleanup = c;
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFocusControl.cb = null;
  mockFocusControl.cleanup = null;
  mockFocusControl.seenCbs.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useNavigationGuard", () => {
  it("runs the guarded fn and locks; further calls are no-ops, same frame and after re-render", () => {
    const { result } = renderHook(() => useNavigationGuard());
    const first = jest.fn();
    const second = jest.fn();
    const third = jest.fn();

    expect(result.current.locked).toBe(false);
    // Same-frame double activation: no render between the two calls, so
    // only the synchronous ref check can suppress the second.
    act(() => {
      result.current.guard(first);
      result.current.guard(second);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(result.current.locked).toBe(true);

    // Still a no-op after the locked state has rendered.
    act(() => {
      result.current.guard(third);
    });
    expect(third).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(result.current.locked).toBe(true);
  });

  it("resets on refocus so a subsequent activation runs again", () => {
    const { result } = renderHook(() => useNavigationGuard());
    const fn = jest.fn();

    act(() => {
      result.current.guard(fn);
    });
    expect(result.current.locked).toBe(true);

    simulateBlur();
    simulateRefocus();

    expect(result.current.locked).toBe(false);
    act(() => {
      result.current.guard(fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("resets and rethrows on a synchronous throw from the guarded fn", () => {
    const { result } = renderHook(() => useNavigationGuard());
    const boom = new Error("push failed");

    let caught: unknown = null;
    act(() => {
      try {
        result.current.guard(() => {
          throw boom;
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBe(boom);
    expect(result.current.locked).toBe(false);
    // Timer was cleared by the throw reset.
    expect(jest.getTimerCount()).toBe(0);

    const retry = jest.fn();
    act(() => {
      result.current.guard(retry);
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("failsafe auto-unlock fires only at 1500ms (last-resort deadlock escape)", () => {
    const { result } = renderHook(() => useNavigationGuard());

    act(() => {
      result.current.guard(jest.fn());
    });
    expect(result.current.locked).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1499);
    });
    expect(result.current.locked).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.locked).toBe(false);

    const after = jest.fn();
    act(() => {
      result.current.guard(after);
    });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("the lock survives a re-render while focused (stable focus callback)", () => {
    const { result, rerender } = renderHook(() => useNavigationGuard());
    const fn = jest.fn();

    act(() => {
      result.current.guard(fn);
    });
    expect(result.current.locked).toBe(true);

    rerender({});

    expect(result.current.locked).toBe(true);
    // The focus callback identity never changed across renders; an
    // unstable callback would have re-run and silently unlocked the guard.
    expect(mockFocusControl.seenCbs.size).toBe(1);

    act(() => {
      result.current.guard(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clears the failsafe timer on blur so it can never fire mid-transition", () => {
    const { result } = renderHook(() => useNavigationGuard());

    act(() => {
      result.current.guard(jest.fn());
    });
    expect(jest.getTimerCount()).toBe(1);

    // The pushed modal takes over: this screen blurs. The timer must die
    // with the blur, because a genuine transition is underway.
    simulateBlur();
    expect(jest.getTimerCount()).toBe(0);
    // The lock itself survives the blur: only refocus may reopen the
    // guard, no matter how much time passes mid-transition.
    expect(result.current.locked).toBe(true);

    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(result.current.locked).toBe(true);
    // Refocus (modal dismissed) is the unlock owner.
    simulateRefocus();
    expect(result.current.locked).toBe(false);
  });

  it("clears the failsafe timer on unmount", () => {
    const { result, unmount } = renderHook(() => useNavigationGuard());

    act(() => {
      result.current.guard(jest.fn());
    });
    expect(jest.getTimerCount()).toBe(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
