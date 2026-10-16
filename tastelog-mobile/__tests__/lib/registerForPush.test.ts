jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const { registerForPush } = require("../../lib/notifications/registerForPush");

describe("registerForPush", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = "ios";
  });

  test("returns granted + token when permission is granted", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "granted",
    });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
      data: "ExponentPushToken[abc123]",
    });

    const result = await registerForPush();

    expect(result).toEqual({
      token: "ExponentPushToken[abc123]",
      granted: true,
    });
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test("requests permission when not already granted", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "undetermined",
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "granted",
    });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
      data: "ExponentPushToken[xyz789]",
    });

    const result = await registerForPush();

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      token: "ExponentPushToken[xyz789]",
      granted: true,
    });
  });

  test("returns not granted when permission is denied", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "undetermined",
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "denied",
    });

    const result = await registerForPush();

    expect(result).toEqual({ token: null, granted: false });
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  test("returns not granted when an error is thrown", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockRejectedValue(
      new Error("device error"),
    );

    const result = await registerForPush();

    expect(result).toEqual({ token: null, granted: false });
  });

  test("sets up notification channel on Android", async () => {
    (Platform as { OS: string }).OS = "android";
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "granted",
    });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
      data: "ExponentPushToken[android1]",
    });

    await registerForPush();

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      "default",
      { name: "Default", importance: Notifications.AndroidImportance.DEFAULT },
    );
  });

  test("does not set up notification channel on iOS", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: "granted",
    });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
      data: "ExponentPushToken[ios1]",
    });

    await registerForPush();

    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
