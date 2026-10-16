/**
 * Platform-specific shadow definitions.
 * No CSS box-shadow strings — RN only.
 */
import { Platform, ViewStyle } from "react-native";

type ShadowStyle = Pick<
  ViewStyle,
  "shadowColor" | "shadowOffset" | "shadowOpacity" | "shadowRadius" | "elevation"
>;

export const shadows: Record<"sm" | "md" | "card", ShadowStyle> = {
  sm: Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 3,
    },
    android: {
      elevation: 2,
    },
  }) as ShadowStyle,
  md: Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 14,
    },
    android: {
      elevation: 6,
    },
  }) as ShadowStyle,
  /** Light-mode card depth — subtle, soft, elevated. Only applied on light surfaces. */
  card: Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.06,
      shadowRadius: 12,
    },
    android: {
      elevation: 2,
    },
    default: {},
  }) as ShadowStyle,
};
