import * as Haptics from "expo-haptics";

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  ImpactFeedbackStyle: { Light: "light" },
}));

// Re-require after mock is in place
const { hapticSuccess, hapticWarning, hapticTap } = require("../../lib/haptics/haptics");

describe("haptics wrapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("hapticSuccess calls notificationAsync with Success", () => {
    hapticSuccess();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });

  test("hapticWarning calls notificationAsync with Warning", () => {
    hapticWarning();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Warning,
    );
  });

  test("hapticTap calls impactAsync with Light", () => {
    hapticTap();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(
      Haptics.ImpactFeedbackStyle.Light,
    );
  });

  test("does not throw when expo-haptics throws", () => {
    (Haptics.notificationAsync as jest.Mock).mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    expect(() => hapticSuccess()).not.toThrow();
  });
});
