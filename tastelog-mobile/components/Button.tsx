import { useCallback } from "react";
import {
  Pressable,
  Text,
  ActivityIndicator,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { fonts, fontSize, motion, radius, spacing } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
import { hapticTap } from "../lib/haptics/haptics";
// Deep import on purpose (NOT the lib/hooks barrel): pulling the barrel
// into a components-barrel member would drag the hooks/auth/API graph
// into every component consumer and its tests. Same precedent as
// lib/haptics/haptics.
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

type ButtonVariant = "primary" | "outline" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  /** sm = compact inline control; md = default; lg = 56pt-minimum prominent control. */
  size?: ButtonSize;
  /** Stretches the button across the parent's cross axis (column layouts). */
  fullWidth?: boolean;
  /**
   * Whether pressing fires the built-in tap haptic. Default true.
   * Set false when the caller's onPress already owns the haptic for that
   * action across multiple input sources (e.g. cooking-mode nav, where the
   * same handler is driven by button, swipe, and voice) — prevents a
   * double buzz.
   */
  haptic?: boolean;
  accessibilityLabel?: string;
};

const sizeStyles: Record<ButtonSize, { container: ViewStyle; text: TextStyle }> = {
  sm: {
    container: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.base,
      justifyContent: "center",
    },
    text: { fontSize: fontSize.base },
  },
  md: {
    container: { padding: spacing.base },
    text: { fontSize: fontSize.base },
  },
  lg: {
    container: {
      padding: spacing.base,
      paddingHorizontal: spacing.lg,
      minHeight: 56,
      justifyContent: "center",
    },
    text: { fontSize: fontSize.base },
  },
};

function getVariantStyles(
  palette: ThemePalette,
): Record<
  ButtonVariant,
  { container: ViewStyle; text: TextStyle; disabledBg: string; loaderColor: string }
> {
  return {
    primary: {
      container: { backgroundColor: palette.primary },
      text: { color: palette.onPrimary },
      disabledBg: palette.disabledBg,
      loaderColor: palette.disabledText,
    },
    outline: {
      container: {
        backgroundColor: "transparent",
        borderWidth: 1,
        borderColor: palette.accent,
      },
      text: { color: palette.accent },
      disabledBg: palette.disabledBg,
      loaderColor: palette.disabledText,
    },
    destructive: {
      container: { backgroundColor: palette.error },
      text: { color: palette.onPrimary },
      disabledBg: palette.disabledBg,
      loaderColor: palette.disabledText,
    },
  };
}

export function Button({
  title,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
  size = "md",
  fullWidth = false,
  haptic = true,
  accessibilityLabel,
}: ButtonProps) {
  const { palette } = useTheme();
  const isDisabled = disabled || loading;
  const variantStyle = getVariantStyles(palette)[variant];
  const sizeStyle = sizeStyles[size];
  const reduceMotion = useReducedMotion();
  const pressOpacity = useSharedValue(1);

  const handlePressIn = useCallback(() => {
    pressOpacity.value = reduceMotion
      ? 0.85
      : withSpring(0.85, motion.spring.touch);
  }, [pressOpacity, reduceMotion]);

  const handlePressOut = useCallback(() => {
    pressOpacity.value = reduceMotion
      ? 1
      : withSpring(1, motion.spring.touch);
  }, [pressOpacity, reduceMotion]);

  const pressStyle = useAnimatedStyle(() => ({
    opacity: pressOpacity.value,
  }));

  const handlePress = useCallback(() => {
    if (isDisabled) return;
    if (haptic) hapticTap();
    onPress();
  }, [isDisabled, onPress, haptic]);

  return (
    <Animated.View style={[pressStyle, fullWidth && { alignSelf: "stretch" }]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        style={[
          {
            borderRadius: radius.md,
            alignItems: "center",
          },
          sizeStyle.container,
          variantStyle.container,
          isDisabled && {
            backgroundColor: variantStyle.disabledBg,
            borderColor: variantStyle.disabledBg,
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variantStyle.loaderColor} />
        ) : (
          <Text
            style={[
              { fontFamily: fonts.bodySemiBold },
              sizeStyle.text,
              variantStyle.text,
              isDisabled && { color: palette.disabledText },
            ]}
          >
            {title}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}
