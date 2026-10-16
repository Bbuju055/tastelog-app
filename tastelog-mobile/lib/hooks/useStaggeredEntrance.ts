import { useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Easing } from "react-native";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Phase 10.G — Staggered list-item entrance.
 *
 * Owns a fixed-length pool of `Animated.Value`s (one per "first N" rows). The
 * parent screen calls `start()` exactly once when its data is first ready, and
 * passes `getOpacity(index)` into each list row's `renderItem`. Rows beyond
 * `cap` get `undefined` and render at full opacity instantly — that is the
 * intentional performance guard from the roadmap (don't animate below the
 * fold).
 *
 * Why a hook (not inline state):
 *  - Both the recipe list and the grocery list need exactly the same shape.
 *  - The lazy `useRef` sentinel pattern keeps Animated.Value allocation to
 *    once per hook instance, not once per render.
 *  - `start()` is idempotent so refetches / focus changes / filter changes do
 *    not re-trigger the animation. Caller-side guard (`hasAnimatedRef`) is
 *    still expected, but this is a defensive second layer.
 */
export type StaggeredEntranceOptions = {
  cap?: number;
  staggerMs?: number;
  durationMs?: number;
};

export type StaggeredEntrance = {
  start: () => void;
  getOpacity: (index: number) => Animated.Value | undefined;
};

const DEFAULT_CAP = 12;
const DEFAULT_STAGGER_MS = 40;
const DEFAULT_DURATION_MS = 220;

export function useStaggeredEntrance(
  options?: StaggeredEntranceOptions,
): StaggeredEntrance {
  const cap = options?.cap ?? DEFAULT_CAP;
  const staggerMs = options?.staggerMs ?? DEFAULT_STAGGER_MS;
  const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;

  // Lazy-init: allocate Animated.Values exactly once.
  const valuesRef = useRef<Animated.Value[] | null>(null);
  if (valuesRef.current === null) {
    valuesRef.current = Array.from(
      { length: cap },
      () => new Animated.Value(0),
    );
  }

  const startedRef = useRef(false);
  const compositeRef = useRef<Animated.CompositeAnimation | null>(null);
  const reduceMotion = useReducedMotion();

  // Cancel-and-snap (G-15.1 Reduce Motion): stop whatever is in flight and
  // land every pooled value on its final opacity. The timings only ever
  // drive toward 1, so no stopped callback can restore an intermediate
  // state afterwards.
  const snapToFinal = useCallback(() => {
    compositeRef.current?.stop();
    compositeRef.current = null;
    valuesRef.current?.forEach((value) => {
      value.stopAnimation();
      value.setValue(1);
    });
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (reduceMotion) {
      snapToFinal();
      return;
    }
    const values = valuesRef.current;
    if (!values) return;
    const composite = Animated.stagger(
      staggerMs,
      values.map((value) =>
        Animated.timing(value, {
          toValue: 1,
          duration: durationMs,
          // Named exception (G-15.1, registered in theme/motion.ts): the
          // 10.G stagger easing is part of the device-tuned cap-12/40ms
          // entrance contract; migrating it to motion.easing.out is a
          // separately device-verified behavior change, not a mechanical
          // token swap.
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ),
    );
    compositeRef.current = composite;
    composite.start(() => {
      compositeRef.current = null;
    });
  }, [staggerMs, durationMs, reduceMotion, snapToFinal]);

  // If the preference resolves (or is toggled) true after a stagger already
  // began under the hook's initial false value, cancel it and snap so no
  // row can stay dimmed mid-entrance.
  useEffect(() => {
    if (reduceMotion && startedRef.current) {
      snapToFinal();
    }
  }, [reduceMotion, snapToFinal]);

  // Unmount: stop an in-flight composite so no callback fires afterwards.
  useEffect(() => {
    return () => {
      compositeRef.current?.stop();
      compositeRef.current = null;
    };
  }, []);

  const getOpacity = useCallback(
    (index: number): Animated.Value | undefined => {
      if (index < 0 || index >= cap) return undefined;
      return valuesRef.current?.[index];
    },
    [cap],
  );

  // Build 4 (C1): consumers list this object in their content-fade effect
  // deps. A fresh object per render re-ran that effect (and its fade.stop
  // cleanup) on every re-render, freezing the one-shot fade mid-flight.
  // Memoized so the identity only changes when start/getOpacity do.
  return useMemo(() => ({ start, getOpacity }), [start, getOpacity]);
}
