import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Reduced-motion preference (Phase 15.1.1).
 *
 * Subscription-based wrapper around AccessibilityInfo: reads the initial
 * value async and stays subscribed to `reduceMotionChanged`.
 *
 * Documented tradeoff: returns `false` until the initial async read
 * resolves, so a reduce-motion user can see at most one animated frame
 * on a cold mount. This matches standard practice; blocking render on
 * the async read would be worse.
 *
 * Every animated surface from 15.1.2 onward must branch on this hook
 * (crossfade or instant per the phase charter §3.4).
 */
export function useReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        // Normalize: the native call can resolve undefined under jest-expo
        // and some platforms; only a literal true enables the reduced path.
        if (!cancelled) setReduceMotion(enabled === true);
      })
      .catch(() => {
        // Unavailable (e.g. some test environments): keep the false default.
      });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => {
        setReduceMotion(enabled);
      },
    );

    return () => {
      cancelled = true;
      // Defensive: EventSubscription on RN ≥0.65; tolerate absent remove in mocks.
      subscription?.remove?.();
    };
  }, []);

  return reduceMotion;
}
