import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type PushRegistrationResult = {
  token: string | null;
  granted: boolean;
};

/**
 * Request push notification permission and retrieve Expo push token.
 * - Non-blocking: callers should not await this to gate rendering.
 * - Fail-safe: never throws, returns { granted: false, token: null } on failure.
 * - Does NOT send token to backend (Session 7 groundwork only).
 */
export async function registerForPush(): Promise<PushRegistrationResult> {
  try {
    // Android requires a notification channel
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();

    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      return { token: null, granted: false };
    }

    const pushToken = await Notifications.getExpoPushTokenAsync();

    return { token: pushToken.data, granted: true };
  } catch {
    return { token: null, granted: false };
  }
}
