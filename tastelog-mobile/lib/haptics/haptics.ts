import * as Haptics from "expo-haptics";

/**
 * Thin wrapper over expo-haptics for testability and fail-safety.
 * Every function is fire-and-forget: never throws, never blocks.
 */

export function hapticSuccess(): void {
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // Unsupported platform or permission — swallow silently
  }
}

export function hapticWarning(): void {
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  } catch {
    // Unsupported platform or permission — swallow silently
  }
}

export function hapticTap(): void {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Unsupported platform or permission — swallow silently
  }
}
