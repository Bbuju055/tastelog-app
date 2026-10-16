/**
 * Motion tokens (Phase 15.1.1) — pure data only.
 *
 * This file must never import Reanimated, worklets, or any animation
 * runtime: the theme barrel stays light for the Jest module graph, and
 * consumers (15.1.2+) construct library-specific easings/springs from
 * these values (e.g. Reanimated `Easing.bezier(...motion.easing.out)`).
 *
 * Charter (phase15-design-elevation §3): motion conveys state, 150–250ms
 * product band, ease-out family, designed beats capped ~800ms.
 *
 * Grandfathered exceptions (charter §3.1) — deliberately NOT tokenized.
 * This is the exact allowlist for the G-15.1 gate greps; any hit not
 * listed here is a gate failure.
 *
 * Inline literals (gate grep hits these lines directly):
 *   - Skeleton pulse (components/Skeleton.tsx): 500ms durations AND its
 *     two Easing.inOut(Easing.ease) lines
 *   - 10.G stagger easing (lib/hooks/useStaggeredEntrance.ts):
 *     Easing.out(Easing.ease) — device-tuned 10.G entrance contract;
 *     token migration would be a separately device-verified behavior
 *     change (local exception comment at the call site)
 *
 * Named motion constants (permitted with recorded justification):
 *   - FADE_DURATION_MS = 90 (cook crossfade + repeat re-flash): nearest
 *     token fast=120 would make the two-phase crossfade 240ms and breach
 *     the 9.A 150–200ms timing contract
 *   - DEFAULT_STAGGER_MS = 40 / DEFAULT_DURATION_MS = 220
 *     (useStaggeredEntrance): device-tuned 10.G cap-12/40ms contract
 *
 * Non-motion dwell/timeout constants (NOT motion exceptions — excluded
 * from the gate's scope by category, not grandfathered):
 *   - TOAST_DURATION_MS = 4000 (toast dwell before dismiss)
 *   - add tab staged-text delayMs ladder (copy dwell between stage lines)
 *   - SUCCESS_BEAT_SCREEN_READER_DWELL_MS = 2000 (screen-reader success-
 *     beat dwell, components/SuccessBeat.tsx — 15.2.2 slice of this gate)
 */

export const motion = {
  /** Durations in ms. */
  duration: {
    /** Micro feedback: state flips, small fades. */
    fast: 120,
    /** Default product transition. */
    base: 200,
    /** Larger reveals / layout moves. */
    slow: 300,
    /** Designed beats (capture success, cook completion). Cap ~800ms. */
    beat: 700,
  },
  /** Cubic-bezier control points (x1, y1, x2, y2) — ease-out family. */
  easing: {
    /** Ease-out expo-like: fast start, long settle. */
    out: [0.16, 1, 0.3, 1],
    /** Symmetric ease for cross-fades. */
    inOut: [0.65, 0, 0.35, 1],
  },
  /**
   * Spring parameter objects (Reanimated-compatible shape).
   * Provisional values — device-tuned when consumers land in 15.1.2;
   * changing them is a deliberate, contract-tested diff.
   */
  spring: {
    /** Touch feedback: press-in/out scale and opacity. */
    touch: { damping: 20, stiffness: 300, mass: 1 },
    /** Post-gesture settle: layout moves, list reflows. */
    settle: { damping: 26, stiffness: 180, mass: 1 },
  },
} as const;

export type MotionTokens = typeof motion;
