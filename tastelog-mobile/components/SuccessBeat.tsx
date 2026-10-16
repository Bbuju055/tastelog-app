import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing as ReEasing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { fonts, fontSize, lineHeight, motion, spacing } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
import { hapticSuccess } from "../lib/haptics/haptics";
// Deep import (15.1.2 precedent): keeps the lib/hooks barrel out of this
// component's test module graph.
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

/**
 * SuccessBeat (Phase 15.2.2) — the shared designed acknowledgment between
 * a successful mutation and its navigation. Consumers: photo capture,
 * URL capture (full variant) and draft confirmation (compact variant).
 *
 * Lifecycle contract (identical for every variant):
 * - Renders as an opaque full-screen Modal: it covers the tab bar and any
 *   native header, blocks all underlying touch, and scopes assistive-
 *   technology focus to the single beat action. No native entrance
 *   animation and no swipe dismissal.
 * - The dwell deadline is established SYNCHRONOUSLY at the conservative
 *   screen-reader value; the async isScreenReaderEnabled() read can only
 *   shorten it to the ordinary `motion.duration.beat` when it resolves
 *   false. The beat is never without a live completion timer. Runtime
 *   screen-reader changes during the ≤2s beat are deliberately out of
 *   scope.
 * - Tap (anywhere), dwell expiry, AppState resume past the deadline, and
 *   Android back (onRequestClose) all funnel through ONE exactly-once
 *   guard; unmount clears the timer and listener and never completes
 *   late.
 * - Reduce Motion: completed static checkmark, same dwell; an in-flight
 *   draw is cancelled and snapped complete; flipping back off never
 *   replays a completed draw.
 * - VoiceOver reads the single focused modal action (the title) once via
 *   modal focus semantics — no explicit announcement call, which would
 *   double-speak the same copy.
 * - Haptic fires once at mount, best-effort, and never sequences with or
 *   blocks completion.
 */

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Checkmark path in a 100×100 viewBox and its geometric length. */
const CHECK_PATH = "M22 52 L42 72 L78 30";
const CHECK_PATH_LENGTH = 84;

/**
 * Conservative initial dwell used while (or if) a screen reader is
 * active. Non-motion dwell constant — same category as
 * TOAST_DURATION_MS; recorded in the theme/motion.ts header.
 */
export const SUCCESS_BEAT_SCREEN_READER_DWELL_MS = 2000;

type SuccessBeatVariant = "full" | "compact";

/** Mark color role. `success` (default) = green capture/save acknowledgment;
 *  `reward` = gold cooking-completion beat. Lifecycle is identical. */
type SuccessBeatTone = "success" | "reward";

type SuccessBeatProps = {
  /** Visible and accessible copy — also what VoiceOver reads once. */
  title: string;
  /** Where activating (skipping) the beat continues to. */
  accessibilityHint: string;
  /** compact = smaller mark + title; lifecycle guarantees identical. */
  variant?: SuccessBeatVariant;
  /** Mark color role. Default `success` keeps the shipped capture/save look. */
  tone?: SuccessBeatTone;
  /** Beat creation timestamp — deadlines derive from it, so a suspended
   *  timer can never stretch the dwell. */
  startedAt: number;
  /**
   * Native-dismissal ordering (15.2.3-CF). Default `false` keeps today's
   * behavior: `onComplete` fires the instant the beat completes and the parent
   * dismisses the beat by unmounting it. When `true`, iOS instead hides the
   * Modal first and fires `onComplete` only from the native Modal `onDismiss`,
   * after UIKit confirms the beat's view controller is gone — so a follow-on
   * native presentation (e.g. a modal route push) cannot race the dismissal.
   * Android has no such constraint, so it completes directly with no timer.
   * `onComplete` stays the single completion callback in every mode.
   */
  waitForDismiss?: boolean;
  /** Called exactly once: tap, dwell expiry, resume past deadline, or
   *  Android back — whichever happens first. Never called after unmount.
   *  Under `waitForDismiss` on iOS it is deferred until native dismissal
   *  completes; the exactly-once guarantee is unchanged. */
  onComplete: () => void;
};

export function SuccessBeat({
  title,
  accessibilityHint,
  variant = "full",
  tone = "success",
  startedAt,
  waitForDismiss = false,
  onComplete,
}: SuccessBeatProps) {
  const { palette } = useTheme();
  const s = createStyles(palette);
  const reduceMotion = useReducedMotion();
  const markColor = tone === "reward" ? palette.reward : palette.success;

  const completedRef = useRef(false);
  // Separate from completedRef: guards the onComplete call itself so repeated
  // native dismissal callbacks (or a path race) cannot fire it more than once.
  const dismissedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = useRef(startedAt + SUCCESS_BEAT_SCREEN_READER_DWELL_MS);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // waitForDismiss is fixed for a given beat; a ref keeps `complete` stable so
  // the dwell effect's [complete, startedAt] deps never churn.
  const waitForDismissRef = useRef(waitForDismiss);
  waitForDismissRef.current = waitForDismiss;

  // Controlled Modal visibility. Only ever driven false on the waitForDismiss
  // iOS path (so the native dismissal emits onDismiss); the default path never
  // touches it — stays true, and the parent unmounts to dismiss as before.
  const [visible, setVisible] = useState(true);

  // The single semantic completion. Guarded so it can fire at most once.
  const fireComplete = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onCompleteRef.current();
  }, []);

  // Completion trigger: tap, dwell expiry, AppState resume, or Android back.
  // Exactly-once via completedRef. On the waitForDismiss iOS path this hides the
  // Modal and defers onComplete to onDismiss (native dismissal complete);
  // otherwise (default, or Android) it completes directly — unchanged timing.
  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (waitForDismissRef.current && Platform.OS === "ios") {
      setVisible(false);
      return;
    }
    fireComplete();
  }, [fireComplete]);

  // Native Modal dismissal finished (iOS, waitForDismiss path only). Fires the
  // single completion; no-op afterward via fireComplete's guard.
  const handleModalDismiss = useCallback(() => {
    fireComplete();
  }, [fireComplete]);

  // Dwell management. The conservative deadline is armed synchronously —
  // the beat is never timerless while the screen-reader query resolves.
  useEffect(() => {
    const schedule = () => {
      if (completedRef.current) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const remaining = deadlineRef.current - Date.now();
      if (remaining <= 0) {
        timerRef.current = null;
        complete();
        return;
      }
      timerRef.current = setTimeout(complete, remaining);
    };

    schedule();

    let cancelled = false;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (cancelled || completedRef.current) return;
        if (enabled !== true) {
          // Ordinary dwell — completes immediately if it already passed.
          deadlineRef.current = startedAt + motion.duration.beat;
          schedule();
        }
        // true → keep the conservative deadline.
      })
      .catch(() => {
        // Unknown — keep the conservative deadline.
      });

    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      // Timers may have been suspended past the deadline while
      // backgrounded: complete once on resume, or re-arm the remainder.
      schedule();
    });

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sub.remove();
    };
  }, [complete, startedAt]);

  // Success haptic: once, at beat start, fire-and-forget. The wrapper
  // never throws by contract, but even a broken environment must not
  // block completion.
  useEffect(() => {
    try {
      hapticSuccess();
    } catch {
      // Best-effort only.
    }
  }, []);

  // Checkmark draw: 0 → full stroke across the ordinary dwell.
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      // Cancel-and-snap (G-15.1 pattern): flip mid-draw completes the
      // mark instantly. The dwell timer is unaffected.
      cancelAnimation(progress);
      progress.value = 1;
      return;
    }
    // A completed draw never replays (e.g. Reduce Motion flipping back
    // off after the snap above).
    if (progress.value >= 1) return;
    progress.value = withTiming(1, {
      duration: motion.duration.beat,
      easing: ReEasing.bezier(...motion.easing.out),
    });
  }, [progress, reduceMotion]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_PATH_LENGTH * (1 - progress.value),
  }));

  const markSize = variant === "compact" ? 64 : 96;

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={complete}
      onDismiss={handleModalDismiss}
      testID="success-beat-modal"
    >
      <Pressable
        style={s.container}
        onPress={complete}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={accessibilityHint}
        accessibilityViewIsModal
        testID="success-beat"
      >
        <Svg width={markSize} height={markSize} viewBox="0 0 100 100">
          <AnimatedPath
            d={CHECK_PATH}
            stroke={markColor}
            strokeWidth={8}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={CHECK_PATH_LENGTH}
            animatedProps={animatedProps}
          />
        </Svg>
        <Text style={[s.title, variant === "compact" && s.titleCompact]}>
          {title}
        </Text>
      </Pressable>
    </Modal>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.lg,
      backgroundColor: palette.bg,
    },
    title: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.title,
      lineHeight: fontSize.title * lineHeight.tight,
      color: palette.text1,
      textAlign: "center",
      paddingHorizontal: spacing.screen,
    },
    titleCompact: {
      fontSize: fontSize.lg,
      lineHeight: fontSize.lg * lineHeight.tight,
    },
  });
}
