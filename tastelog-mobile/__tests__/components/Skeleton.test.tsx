import React, { useEffect } from "react";
import { Animated } from "react-native";
import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { useTheme } from "../../theme/ThemeProvider";
import { lightPalette, darkPalette } from "../../theme/palettes";
import { shadows } from "../../theme";

// Controllable reduce-motion state (G-15.1). Default false preserves the
// pre-existing pulse behavior for all tests above the reduce-motion block.
const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import {
  SkeletonLine,
  SkeletonRecipeCard,
  SkeletonGroceryRow,
  SkeletonRecipeDetail,
  SkeletonCaptureScene,
} from "../../components/Skeleton";
import { motion } from "../../theme";

/**
 * Forces the ThemeProvider into a specific preference during test render.
 * Calls setPreference in useEffect so React Testing Library's act wrapper
 * flushes the state update before render returns.
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

describe("Skeleton", () => {
  describe("smoke", () => {
    test("SkeletonLine mounts and unmounts cleanly", () => {
      const { toJSON, unmount } = renderWithTheme(
        <SkeletonLine width={100} height={20} />,
      );
      expect(toJSON()).toBeTruthy();
      unmount();
    });

    test("SkeletonLine accepts percentage width", () => {
      const { toJSON } = renderWithTheme(
        <SkeletonLine width="75%" height={14} />,
      );
      expect(toJSON()).toBeTruthy();
    });

    test("SkeletonRecipeCard renders card shape", () => {
      const { toJSON } = renderWithTheme(<SkeletonRecipeCard />);
      expect(toJSON()).toBeTruthy();
    });

    test("SkeletonGroceryRow renders row shape", () => {
      const { toJSON } = renderWithTheme(<SkeletonGroceryRow />);
      expect(toJSON()).toBeTruthy();
    });

    test("SkeletonRecipeDetail renders full composition", () => {
      const { toJSON } = renderWithTheme(<SkeletonRecipeDetail />);
      expect(toJSON()).toBeTruthy();
    });

    test("multiple skeletons mount concurrently without crashing", () => {
      const { toJSON, unmount } = renderWithTheme(
        <>
          <SkeletonRecipeCard />
          <SkeletonRecipeCard />
          <SkeletonRecipeCard />
        </>,
      );
      expect(toJSON()).toBeTruthy();
      unmount();
    });
  });

  describe("theme coverage", () => {
    test("SkeletonLine uses light palette text4 in light theme", () => {
      const { toJSON } = renderWithTheme(
        <SkeletonLine width={100} height={20} />,
      );
      const root = toJSON() as any;
      const flat = flattenStyle(root.props.style);
      expect(flat.backgroundColor).toBe(lightPalette.text4);
    });

    test("SkeletonLine uses dark palette text4 in dark theme", () => {
      const { toJSON } = renderWithTheme(
        <>
          <ThemeForcer mode="dark" />
          <SkeletonLine width={100} height={20} />
        </>,
      );
      const tree = toJSON() as any;
      // Fragment with 2 children: ThemeForcer (null) + SkeletonLine
      // toJSON returns an array when root has multiple children
      const skel = Array.isArray(tree)
        ? tree.find((n) => n && n.props?.style)
        : tree;
      const flat = flattenStyle(skel.props.style);
      expect(flat.backgroundColor).toBe(darkPalette.text4);
    });

    test("SkeletonRecipeCard uses light palette card/border in light theme", () => {
      const { toJSON } = renderWithTheme(<SkeletonRecipeCard />);
      const root = toJSON() as any;
      const flat = flattenStyle(root.props.style);
      expect(flat.backgroundColor).toBe(lightPalette.card);
      expect(flat.borderColor).toBe(lightPalette.border);
    });

    test("SkeletonRecipeCard uses dark palette card/border in dark theme", () => {
      const { toJSON } = renderWithTheme(
        <>
          <ThemeForcer mode="dark" />
          <SkeletonRecipeCard />
        </>,
      );
      const tree = toJSON() as any;
      const card = Array.isArray(tree)
        ? tree.find((n) => n && n.props?.style)
        : tree;
      const flat = flattenStyle(card.props.style);
      expect(flat.backgroundColor).toBe(darkPalette.card);
      expect(flat.borderColor).toBe(darkPalette.border);
    });

    // Phase 15.0.1 — light-only card shadow (skeleton matches RecipeCard)
    test("SkeletonRecipeCard applies card shadow in light theme", () => {
      const { toJSON } = renderWithTheme(<SkeletonRecipeCard />);
      const root = toJSON() as any;
      const flat = flattenStyle(root.props.style);
      expect(flat.shadowOpacity).toBe(shadows.card.shadowOpacity);
      expect(flat.shadowRadius).toBe(shadows.card.shadowRadius);
    });

    test("SkeletonRecipeCard has no shadow in dark theme", () => {
      const { toJSON } = renderWithTheme(
        <>
          <ThemeForcer mode="dark" />
          <SkeletonRecipeCard />
        </>,
      );
      const tree = toJSON() as any;
      const card = Array.isArray(tree)
        ? tree.find((n) => n && n.props?.style)
        : tree;
      const flat = flattenStyle(card.props.style);
      expect(flat.shadowOpacity).toBeUndefined();
    });
  });

  describe("reduce motion (G-15.1)", () => {
    function lineOpacity(toJSON: () => unknown): number {
      const flat = flattenStyle((toJSON() as any).props.style);
      const op = flat.opacity as { __getValue?: () => number } | number;
      return typeof op === "number" ? op : (op.__getValue?.() as number);
    }

    afterEach(() => {
      mockUseReducedMotion.mockImplementation(() => false);
    });

    test("does not start the pulse loop and holds static opacity when true", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      const loopSpy = jest.spyOn(Animated, "loop");
      const { toJSON } = renderWithTheme(<SkeletonLine width={100} />);
      expect(loopSpy).not.toHaveBeenCalled();
      expect(lineOpacity(toJSON)).toBe(0.6);
      loopSpy.mockRestore();
    });

    test("stops an active loop and snaps when the preference flips true", () => {
      const loopSpy = jest.spyOn(Animated, "loop");
      const view = renderWithTheme(<SkeletonLine width={100} />);
      const loop = loopSpy.mock.results[loopSpy.mock.results.length - 1]
        .value as Animated.CompositeAnimation;
      const stopSpy = jest.spyOn(loop, "stop");
      // Once the loop has driven the value with useNativeDriver, jest's
      // __getValue() reads a stale JS-side value — assert the snap via the
      // setValue call instead (the runtime call dispatches natively).
      const setValueSpy = jest.spyOn(Animated.Value.prototype, "setValue");

      mockUseReducedMotion.mockImplementation(() => true);
      view.rerender(<SkeletonLine width={100} />);

      expect(stopSpy).toHaveBeenCalled();
      expect(setValueSpy).toHaveBeenCalledWith(0.6);
      loopSpy.mockRestore();
      setValueSpy.mockRestore();
    });

    test("resumes the normal loop when the preference flips back false", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      const loopSpy = jest.spyOn(Animated, "loop");
      const view = renderWithTheme(<SkeletonLine width={100} />);
      // Purity of the RM-true mount (zero loops) is asserted by the first
      // test in this block; here use a relative count so provider-driven
      // re-renders in full-suite order cannot flake the resume assertion.
      const callsBeforeResume = loopSpy.mock.calls.length;

      mockUseReducedMotion.mockImplementation(() => false);
      view.rerender(<SkeletonLine width={100} />);

      expect(loopSpy.mock.calls.length).toBe(callsBeforeResume + 1);
      loopSpy.mockRestore();
    });

    test("stops the loop on unmount (normal motion)", () => {
      const loopSpy = jest.spyOn(Animated, "loop");
      const { unmount } = renderWithTheme(<SkeletonLine width={100} />);
      const loop = loopSpy.mock.results[0]
        .value as Animated.CompositeAnimation;
      const stopSpy = jest.spyOn(loop, "stop");
      unmount();
      expect(stopSpy).toHaveBeenCalled();
      loopSpy.mockRestore();
    });
  });

  describe("SkeletonCaptureScene (15.2.1)", () => {
    /** Reveal-fade timing calls (duration = motion.duration.base),
     *  distinguished from the grandfathered 500ms pulse timings. */
    function revealTimingCalls(spy: jest.SpyInstance): number {
      return spy.mock.calls.filter(
        (call) => (call[1] as { duration?: number })?.duration === motion.duration.base,
      ).length;
    }

    // Scene groups are AT-hidden; opt in explicitly (see HIDDEN note below).
    const HIDDEN = { includeHiddenElements: true } as const;

    function groupOpacity(testId: string): number {
      const node = screen.getByTestId(testId, HIDDEN);
      const styles = ([] as any[]).concat(node.props.style ?? []).flat(Infinity);
      for (const st of styles) {
        const op = st?.opacity;
        if (op && typeof op.__getValue === "function") return op.__getValue();
        if (typeof op === "number") return op;
      }
      throw new Error(`no opacity on ${testId}`);
    }

    afterEach(() => {
      mockUseReducedMotion.mockImplementation(() => false);
    });

    test("stage 0 renders only the frame; container fully hidden from AT", () => {
      renderWithTheme(<SkeletonCaptureScene stage={0} />);
      // Default queries must NOT see the scene — the decorative subtree is
      // hidden from assistive technology.
      expect(screen.queryByTestId("capture-scene")).toBeNull();
      const container = screen.getByTestId("capture-scene", HIDDEN);
      expect(container.props.accessibilityElementsHidden).toBe(true);
      expect(container.props.importantForAccessibility).toBe(
        "no-hide-descendants",
      );
      expect(screen.getByTestId("capture-scene-frame", HIDDEN)).toBeTruthy();
      expect(screen.queryByTestId("capture-scene-structure", HIDDEN)).toBeNull();
      expect(screen.queryByTestId("capture-scene-ingredients", HIDDEN)).toBeNull();
      expect(screen.queryByTestId("capture-scene-method", HIDDEN)).toBeNull();
    });

    test("stage 3 renders all four groups", () => {
      renderWithTheme(<SkeletonCaptureScene stage={3} />);
      expect(screen.getByTestId("capture-scene-frame", HIDDEN)).toBeTruthy();
      expect(screen.getByTestId("capture-scene-structure", HIDDEN)).toBeTruthy();
      expect(screen.getByTestId("capture-scene-ingredients", HIDDEN)).toBeTruthy();
      expect(screen.getByTestId("capture-scene-method", HIDDEN)).toBeTruthy();
    });

    test("groups already due at mount render static — no reveal fade", () => {
      const timingSpy = jest.spyOn(Animated, "timing");
      renderWithTheme(<SkeletonCaptureScene stage={2} />);
      expect(revealTimingCalls(timingSpy)).toBe(0);
      expect(groupOpacity("capture-scene-structure")).toBe(1);
      expect(groupOpacity("capture-scene-ingredients")).toBe(1);
      timingSpy.mockRestore();
    });

    test("a stage increment observed while mounted reveals the new group with a token fade", () => {
      const timingSpy = jest.spyOn(Animated, "timing");
      const view = renderWithTheme(<SkeletonCaptureScene stage={1} />);
      const before = revealTimingCalls(timingSpy);

      view.rerender(<SkeletonCaptureScene stage={2} />);
      expect(revealTimingCalls(timingSpy)).toBe(before + 1);
      timingSpy.mockRestore();
    });

    test("reduce motion cancels an in-flight reveal and snaps the group visible", () => {
      const view = renderWithTheme(<SkeletonCaptureScene stage={0} />);
      const setValueSpy = jest.spyOn(Animated.Value.prototype, "setValue");
      const stopAnimationSpy = jest.spyOn(
        Animated.Value.prototype,
        "stopAnimation",
      );

      view.rerender(<SkeletonCaptureScene stage={1} />); // reveal starts
      mockUseReducedMotion.mockImplementation(() => true);
      view.rerender(<SkeletonCaptureScene stage={1} />);

      expect(stopAnimationSpy).toHaveBeenCalled();
      expect(setValueSpy).toHaveBeenCalledWith(1);
      setValueSpy.mockRestore();
      stopAnimationSpy.mockRestore();
    });

    test("a completed reveal never replays when reduce motion flips back off", () => {
      mockUseReducedMotion.mockImplementation(() => true);
      const timingSpy = jest.spyOn(Animated, "timing");
      const view = renderWithTheme(<SkeletonCaptureScene stage={1} />);
      expect(revealTimingCalls(timingSpy)).toBe(0);

      mockUseReducedMotion.mockImplementation(() => false);
      view.rerender(<SkeletonCaptureScene stage={1} />);

      expect(revealTimingCalls(timingSpy)).toBe(0);
      expect(groupOpacity("capture-scene-structure")).toBe(1);
      timingSpy.mockRestore();
    });
  });
});
