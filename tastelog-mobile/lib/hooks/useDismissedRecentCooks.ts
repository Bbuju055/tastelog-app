import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadDismissedRecentCooks,
  updateDismissedRecentCooks,
  type DismissedRecentCooks,
} from "../recentCooks/dismissedRecentCooks";

/**
 * Recently Cooked dismissal state (15.2.4-CF-RC1 expansion).
 *
 * `markers` is null until hydration resolves — callers must not render
 * Recently Cooked cards before then, so a previously hidden card never
 * flashes. A synchronous ref mirror guards duplicate taps that land before
 * React re-renders: a repeat dismissal of an already-hidden card returns
 * false so the caller issues no duplicate haptic, toast, or storage write.
 *
 * Deliberately NOT exported through the lib/hooks barrel — the home-screen
 * test suites mock that barrel as object literals (see useRecentCooks
 * precedent on the same screen).
 */
export function useDismissedRecentCooks() {
  const [markers, setMarkers] = useState<DismissedRecentCooks | null>(null);
  const markersRef = useRef<DismissedRecentCooks | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadDismissedRecentCooks().then((loaded) => {
      // loadDismissedRecentCooks never rejects (fails open to {}), so a
      // .then is the complete hydration path.
      if (cancelled) return;
      markersRef.current = loaded;
      setMarkers(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissRecentCook = useCallback(
    (recipeId: string, throughCookedAt: string): boolean => {
      const current = markersRef.current;
      if (current == null) return false; // not hydrated yet
      if (current[recipeId] === throughCookedAt) return false; // duplicate tap
      const next = { ...current, [recipeId]: throughCookedAt };
      markersRef.current = next; // synchronous — blocks pre-rerender repeats
      setMarkers(next); // optimistic
      void updateDismissedRecentCooks((persisted) => ({
        ...persisted,
        [recipeId]: throughCookedAt,
      }));
      return true;
    },
    [],
  );

  const undoDismissRecentCook = useCallback((recipeId: string): void => {
    const current = markersRef.current;
    if (current == null || !(recipeId in current)) return;
    const next = { ...current };
    delete next[recipeId];
    markersRef.current = next;
    setMarkers(next); // optimistic
    void updateDismissedRecentCooks((persisted) => {
      if (!(recipeId in persisted)) return persisted;
      const cleaned = { ...persisted };
      delete cleaned[recipeId];
      return cleaned;
    });
  }, []);

  return { markers, dismissRecentCook, undoDismissRecentCook };
}
