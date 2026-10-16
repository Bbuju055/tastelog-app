import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";

/**
 * Duplicate-activation guard for navigation pushes (Issue 2, C5).
 *
 * `guard(fn)` runs `fn` at most once per navigation window: while a push is
 * in flight, further calls are complete no-ops (no navigation, no haptic).
 * `locked` mirrors the in-flight state for Button `disabled` binding.
 *
 * Unlock ownership: focus regain (the screen re-focuses after the pushed
 * modal dismisses) or a synchronous throw from `fn`. The 1500ms timer below
 * is a LAST-RESORT DEADLOCK FAILSAFE only: it is cleared on blur, on focus
 * reset, and on unmount, so once a genuine navigation transition has begun
 * it can never fire; it is reachable only when the press produced no
 * transition at all (a silently dropped push). It must never reopen the
 * guard while an unresolved transition is underway (operator-ruled
 * invariant, 2026-08-27).
 *
 * Deep-import this hook (never via the lib/hooks barrel): the consuming
 * screen suites mock the barrel as object literals, and the guard must stay
 * real there to keep its tests meaningful. Same precedent as
 * useReducedMotion in Button.tsx.
 */

const FAILSAFE_UNLOCK_MS = 1500;

export function useNavigationGuard(): {
  locked: boolean;
  guard: (fn: () => void) => void;
} {
  // Ref for synchronous correctness (two presses in one frame), state for
  // the Button `disabled` binding.
  const inFlightRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const failsafeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Normal reset owner: focus regain. The callback MUST stay stable (empty
  // deps): an unstable callback would be cleaned up and re-run on ordinary
  // focused re-renders, silently unlocking the guard mid-flight. The
  // cleanup (blur / unmount) clears the failsafe timer so it can never fire
  // once a genuine transition has begun.
  useFocusEffect(
    useCallback(() => {
      if (failsafeTimerRef.current !== null) {
        clearTimeout(failsafeTimerRef.current);
        failsafeTimerRef.current = null;
      }
      inFlightRef.current = false;
      setLocked(false);
      return () => {
        if (failsafeTimerRef.current !== null) {
          clearTimeout(failsafeTimerRef.current);
          failsafeTimerRef.current = null;
        }
      };
    }, []),
  );

  const guard = useCallback((fn: () => void) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLocked(true);
    failsafeTimerRef.current = setTimeout(() => {
      failsafeTimerRef.current = null;
      inFlightRef.current = false;
      setLocked(false);
    }, FAILSAFE_UNLOCK_MS);
    try {
      fn();
    } catch (err) {
      if (failsafeTimerRef.current !== null) {
        clearTimeout(failsafeTimerRef.current);
        failsafeTimerRef.current = null;
      }
      inFlightRef.current = false;
      setLocked(false);
      throw err;
    }
  }, []);

  return { locked, guard };
}
