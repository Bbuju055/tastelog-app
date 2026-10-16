import { Animated } from "react-native";
import { act, renderHook } from "@testing-library/react-native";

// Controllable reduce-motion state (G-15.1). Default false preserves the
// pre-existing behavior for all tests above the reduce-motion describe.
const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import { useStaggeredEntrance } from "../../../lib/hooks/useStaggeredEntrance";

function readValue(value: Animated.Value | undefined): number {
  return (value as unknown as { __getValue: () => number }).__getValue();
}

describe("useStaggeredEntrance", () => {
  describe("getOpacity", () => {
    it("returns an Animated.Value for indices below cap", () => {
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 5 }));
      const value = result.current.getOpacity(0);
      expect(value).toBeInstanceOf(Animated.Value);
    });

    it("returns the same Animated.Value across re-reads (stable identity)", () => {
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 5 }));
      const first = result.current.getOpacity(2);
      const second = result.current.getOpacity(2);
      expect(first).toBe(second);
    });

    it("returns undefined for indices at or above cap", () => {
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 5 }));
      expect(result.current.getOpacity(5)).toBeUndefined();
      expect(result.current.getOpacity(99)).toBeUndefined();
    });

    it("returns undefined for negative indices", () => {
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 5 }));
      expect(result.current.getOpacity(-1)).toBeUndefined();
    });

    it("uses default cap of 12 when no options passed", () => {
      const { result } = renderHook(() => useStaggeredEntrance());
      expect(result.current.getOpacity(11)).toBeInstanceOf(Animated.Value);
      expect(result.current.getOpacity(12)).toBeUndefined();
    });
  });

  describe("start", () => {
    it("schedules a stagger animation on first call", () => {
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 5 }));
      act(() => {
        result.current.start();
      });
      expect(staggerSpy).toHaveBeenCalledTimes(1);
      // First arg is the stagger interval (ms), second is the array of animations.
      expect(staggerSpy.mock.calls[0][0]).toBe(40);
      expect(Array.isArray(staggerSpy.mock.calls[0][1])).toBe(true);
      expect((staggerSpy.mock.calls[0][1] as unknown[]).length).toBe(5);
      staggerSpy.mockRestore();
    });

    it("is idempotent — second call does not re-schedule", () => {
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 3 }));
      act(() => {
        result.current.start();
      });
      act(() => {
        result.current.start();
      });
      act(() => {
        result.current.start();
      });
      expect(staggerSpy).toHaveBeenCalledTimes(1);
      staggerSpy.mockRestore();
    });

    it("respects custom staggerMs option", () => {
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result } = renderHook(() =>
        useStaggeredEntrance({ cap: 3, staggerMs: 80 }),
      );
      act(() => {
        result.current.start();
      });
      expect(staggerSpy.mock.calls[0][0]).toBe(80);
      staggerSpy.mockRestore();
    });
  });

  describe("allocation discipline", () => {
    it("does not reallocate Animated.Values across re-renders", () => {
      const { result, rerender } = renderHook(() =>
        useStaggeredEntrance({ cap: 5 }),
      );
      const before = result.current.getOpacity(0);
      rerender({});
      rerender({});
      const after = result.current.getOpacity(0);
      expect(after).toBe(before);
    });

    // Build 4 (C1): consumers list the returned object in effect deps. A
    // fresh object per render re-runs their fade effect (and its cleanup)
    // on every re-render, which is the confirmed grocery/recipes blank-tab
    // mechanism. The object itself must be referentially stable.
    it("returns a referentially stable object across re-renders (Build 4 C1)", () => {
      const { result, rerender } = renderHook(() =>
        useStaggeredEntrance({ cap: 5 }),
      );
      const first = result.current;
      rerender({});
      rerender({});
      expect(result.current).toBe(first);
      expect(result.current.start).toBe(first.start);
      expect(result.current.getOpacity).toBe(first.getOpacity);
    });
  });

  describe("reduce motion (G-15.1)", () => {
    afterEach(() => {
      mockUseReducedMotion.mockImplementation(() => false);
    });

    it("snaps every pooled value to 1 with no stagger when already true", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result } = renderHook(() => useStaggeredEntrance({ cap: 4 }));
      act(() => {
        result.current.start();
      });
      expect(staggerSpy).not.toHaveBeenCalled();
      for (let i = 0; i < 4; i++) {
        expect(readValue(result.current.getOpacity(i))).toBe(1);
      }
      staggerSpy.mockRestore();
    });

    it("cancels an active stagger and snaps all values when the preference flips true", () => {
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result, rerender } = renderHook(() =>
        useStaggeredEntrance({ cap: 3 }),
      );
      act(() => {
        result.current.start();
      });
      expect(staggerSpy).toHaveBeenCalledTimes(1);
      const composite = staggerSpy.mock.results[0]
        .value as Animated.CompositeAnimation;
      const stopSpy = jest.spyOn(composite, "stop");

      mockUseReducedMotion.mockImplementation(() => true);
      rerender({});

      expect(stopSpy).toHaveBeenCalled();
      for (let i = 0; i < 3; i++) {
        expect(readValue(result.current.getOpacity(i))).toBe(1);
      }
      // No re-schedule happened; the stopped composite's callback cannot
      // restore an intermediate state (timings only ever drive toward 1).
      expect(staggerSpy).toHaveBeenCalledTimes(1);
      staggerSpy.mockRestore();
    });

    it("stops an in-flight composite on unmount", () => {
      const staggerSpy = jest.spyOn(Animated, "stagger");
      const { result, unmount } = renderHook(() =>
        useStaggeredEntrance({ cap: 2 }),
      );
      act(() => {
        result.current.start();
      });
      const composite = staggerSpy.mock.results[0]
        .value as Animated.CompositeAnimation;
      const stopSpy = jest.spyOn(composite, "stop");
      unmount();
      expect(stopSpy).toHaveBeenCalled();
      staggerSpy.mockRestore();
    });
  });
});
