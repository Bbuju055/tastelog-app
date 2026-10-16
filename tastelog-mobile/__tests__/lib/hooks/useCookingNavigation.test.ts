import { act, renderHook } from "@testing-library/react-native";
import { useCookingNavigation } from "../../../lib/hooks/useCookingNavigation";

describe("useCookingNavigation", () => {
  describe("initialization", () => {
    it("initializes at step 0", () => {
      const { result } = renderHook(() => useCookingNavigation(5));
      expect(result.current.step).toBe(0);
    });

    it("isFirstStep is true at start", () => {
      const { result } = renderHook(() => useCookingNavigation(5));
      expect(result.current.isFirstStep).toBe(true);
    });
  });

  describe("edge: stepCount = 0 (fully inert)", () => {
    // Explicit edge-state assertion per contract.
    it("exposes the locked inert flag set", () => {
      const { result } = renderHook(() => useCookingNavigation(0));
      expect(result.current.step).toBe(0);
      expect(result.current.isFirstStep).toBe(true);
      expect(result.current.isLastStep).toBe(true);
      expect(result.current.canGoNext).toBe(false);
      expect(result.current.canGoPrev).toBe(false);
    });

    it("goNext is a no-op", () => {
      const { result } = renderHook(() => useCookingNavigation(0));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(0);
    });

    it("goPrev is a no-op", () => {
      const { result } = renderHook(() => useCookingNavigation(0));
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(0);
    });
  });

  describe("edge: stepCount = 1 (single-step)", () => {
    it("has both isFirstStep and isLastStep true; nav flags false", () => {
      const { result } = renderHook(() => useCookingNavigation(1));
      expect(result.current.step).toBe(0);
      expect(result.current.isFirstStep).toBe(true);
      expect(result.current.isLastStep).toBe(true);
      expect(result.current.canGoNext).toBe(false);
      expect(result.current.canGoPrev).toBe(false);
    });

    it("goNext is a no-op", () => {
      const { result } = renderHook(() => useCookingNavigation(1));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(0);
    });

    it("goPrev is a no-op", () => {
      const { result } = renderHook(() => useCookingNavigation(1));
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(0);
    });
  });

  describe("multi-step bounds", () => {
    it("at first step: isFirstStep=true, isLastStep=false", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      expect(result.current.isFirstStep).toBe(true);
      expect(result.current.isLastStep).toBe(false);
    });

    it("at last step: isFirstStep=false, isLastStep=true", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(2);
      expect(result.current.isFirstStep).toBe(false);
      expect(result.current.isLastStep).toBe(true);
    });

    it("in a middle step: canGoNext and canGoPrev both true", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
      expect(result.current.canGoNext).toBe(true);
      expect(result.current.canGoPrev).toBe(true);
    });
  });

  describe("goNext", () => {
    it("advances by 1 when allowed", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
    });

    it("stops at last step (does not overflow)", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(2);
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(2);
    });

    it("is a no-op while transitioning", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.beginTransition();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(0);
    });
  });

  describe("goPrev", () => {
    it("moves back by 1 when allowed", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(0);
    });

    it("stops at 0 (does not underflow)", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(0);
    });

    it("is a no-op while transitioning", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
      act(() => {
        result.current.beginTransition();
      });
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(1);
    });
  });

  describe("transition lock", () => {
    it("beginTransition sets isTransitioning to true", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      expect(result.current.isTransitioning).toBe(false);
      act(() => {
        result.current.beginTransition();
      });
      expect(result.current.isTransitioning).toBe(true);
    });

    it("endTransition sets isTransitioning to false", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.beginTransition();
      });
      expect(result.current.isTransitioning).toBe(true);
      act(() => {
        result.current.endTransition();
      });
      expect(result.current.isTransitioning).toBe(false);
    });

    it("canGoNext is false while transitioning", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      expect(result.current.canGoNext).toBe(true);
      act(() => {
        result.current.beginTransition();
      });
      expect(result.current.canGoNext).toBe(false);
    });

    it("canGoPrev is false while transitioning", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.goNext();
      });
      expect(result.current.canGoPrev).toBe(true);
      act(() => {
        result.current.beginTransition();
      });
      expect(result.current.canGoPrev).toBe(false);
    });

    it("unlocking restores movement", () => {
      const { result } = renderHook(() => useCookingNavigation(3));
      act(() => {
        result.current.beginTransition();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(0); // blocked by lock
      act(() => {
        result.current.endTransition();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1); // advances after unlock
    });
  });

  // Issue 3 (plan section 9): stepCount may change while mounted (a
  // saved-recipe edit shrinks/grows the cached recipe's steps under a
  // mounted cook screen). The exposed step is ALWAYS clamped to the
  // current range in the same render that delivers the new count.
  describe("changing stepCount (clamp contract)", () => {
    it("clamps synchronously when steps shrink below the current step", () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 5 } },
      );
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(4);
      rerender({ count: 2 });
      expect(result.current.step).toBe(1); // max(0, stepCount - 1)
      expect(result.current.isLastStep).toBe(true);
      expect(result.current.canGoNext).toBe(false);
      expect(result.current.canGoPrev).toBe(true);
    });

    it("clamps to the inert zero state when steps shrink to zero", () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 3 } },
      );
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
      rerender({ count: 0 });
      expect(result.current.step).toBe(0);
      expect(result.current.canGoNext).toBe(false);
      expect(result.current.canGoPrev).toBe(false);
    });

    it("navigation after a shrink moves from the clamped position", () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 5 } },
      );
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(3);
      rerender({ count: 3 });
      expect(result.current.step).toBe(2);
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(1);
    });

    it("growth never moves the current step", () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 2 } },
      );
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(1);
      expect(result.current.isLastStep).toBe(true);
      rerender({ count: 5 });
      expect(result.current.step).toBe(1);
      expect(result.current.isLastStep).toBe(false);
      expect(result.current.canGoNext).toBe(true);
    });

    it("a shrink clamp PERSISTS: later growth does not resurrect the pre-shrink index", () => {
      // Second-rescue M1: the clamp must be durable state, not a
      // read-time projection that loosens again when the count grows.
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 5 } },
      );
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(4);
      rerender({ count: 2 });
      expect(result.current.step).toBe(1); // persisted clamp
      rerender({ count: 5 });
      expect(result.current.step).toBe(1); // no resurrection to 4
      expect(result.current.canGoNext).toBe(true);
      // Navigation from the clamped position still behaves normally.
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(2);
    });

    it("the transition lock still gates movement after a shrink clamp", () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) => useCookingNavigation(count),
        { initialProps: { count: 4 } },
      );
      act(() => {
        result.current.goNext();
      });
      act(() => {
        result.current.goNext();
      });
      expect(result.current.step).toBe(2);
      rerender({ count: 2 });
      expect(result.current.step).toBe(1);
      act(() => {
        result.current.beginTransition();
      });
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(1); // blocked by the lock
      act(() => {
        result.current.endTransition();
      });
      act(() => {
        result.current.goPrev();
      });
      expect(result.current.step).toBe(0);
    });
  });
});
