import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { fonts, fontSize, motion, radius, spacing } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
// Deep import on purpose (NOT the lib/hooks barrel) — see Button.tsx.
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

/**
 * Shared transient-feedback toast (Phase 15.0.4, motion upgraded 15.1.5).
 *
 * Timing: 4000ms display dwell (product timing, not animation motion),
 * entrance fade+drop over motion.duration.base, exit fade over
 * motion.duration.fast. Re-show clears the pending timer; a dismiss
 * interrupted by a re-show must NOT clear the new toast — RN Animated
 * invokes interrupted callbacks with finished: false, hence the gate in
 * dismissToast (the 15.0.4 fade-out race fix).
 *
 * Styling is SUCCESS-ONLY until a variant API exists: every current
 * caller emits success confirmations (errors stay Alert dialogs per
 * 15.0.4), so the toastSuccess* tokens are the component default. A
 * future neutral/error toast needs a variant prop first.
 *
 * Navigation stays at the call site via the optional `action` callback;
 * this file must never import a router.
 */

const TOAST_DURATION_MS = 4000;

export type ToastState = {
  message: string;
} | null;

export type ToastAction = {
  label: string;
  onPress: () => void;
};

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();

  const dismissToast = useCallback(() => {
    if (reduceMotion) {
      // No animation callback exists on this branch — clear synchronously.
      toastOpacity.setValue(0);
      setToast(null);
      return;
    }
    Animated.timing(toastOpacity, {
      toValue: 0,
      duration: motion.duration.fast,
      easing: Easing.bezier(...motion.easing.out),
      useNativeDriver: true,
    }).start(({ finished }) => {
      // Interrupted fade-outs (re-show mid-dismiss) report finished: false;
      // clearing state then would null the toast that was just re-shown.
      if (finished) setToast(null);
    });
  }, [toastOpacity, reduceMotion]);

  const showToast = useCallback(
    (state: NonNullable<ToastState>) => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
      setToast(state);
      if (reduceMotion) {
        toastOpacity.setValue(1);
      } else {
        toastOpacity.setValue(0);
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: motion.duration.base,
          easing: Easing.bezier(...motion.easing.out),
          useNativeDriver: true,
        }).start();
      }
      toastTimeoutRef.current = setTimeout(dismissToast, TOAST_DURATION_MS);
    },
    [toastOpacity, dismissToast, reduceMotion],
  );

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  return { toast, showToast, dismissToast, toastOpacity };
}

type ToastProps = {
  toast: ToastState;
  opacity: Animated.Value;
  action?: ToastAction | undefined;
};

export function Toast({ toast, opacity, action }: ToastProps) {
  const { palette } = useTheme();
  const s = createStyles(palette);

  if (!toast) return null;

  // Small drop-in derived from the same value that drives the fade: one
  // animated value, so an interrupted dismiss can never desync the two.
  // Under reduced motion the value jumps 0/1 and the offset rides to 0.
  const translateY = opacity.interpolate({
    inputRange: [0, 1],
    outputRange: [-spacing.sm, 0],
  });

  return (
    <Animated.View
      style={[s.toast, { opacity, transform: [{ translateY }] }]}
      pointerEvents="box-none"
      // Metadata-only a11y (approved D2): role + Android live region.
      // True iOS VoiceOver announcement is a named deferred follow-on.
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={s.toastBox}>
        <View style={s.toastContent}>
          <Text style={s.toastText}>{toast.message}</Text>
          {action && (
            <Pressable onPress={action.onPress} hitSlop={8}>
              <Text style={s.toastAction}>{action.label}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    toast: {
      position: "absolute",
      top: spacing.sm,
      left: spacing.base,
      right: spacing.base,
    },
    // Solid base so the alpha success tint composites predictably in both
    // themes; overflow keeps the tinted row inside the radius.
    toastBox: {
      backgroundColor: palette.toastBg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.toastBorder,
      overflow: "hidden",
    },
    toastContent: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: palette.toastSuccessBg,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.base,
    },
    toastText: {
      fontSize: fontSize.base,
      fontFamily: fonts.bodyMedium,
      color: palette.toastSuccessText,
      flex: 1,
      marginRight: spacing.md,
    },
    toastAction: {
      fontSize: fontSize.base,
      fontFamily: fonts.bodySemiBold,
      color: palette.accent,
    },
  });
}
