import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Build 4 reliability correction, C3 guard coverage for the two screens with
// no prior navigation suite: Settings "How Tastelog works" and the capture
// Review "View Recipe" push. Both are double-fireable direct pushes; each
// must yield exactly one navigation per activation window.
//
// Settings harness mirrors SettingsDebugGating.test.tsx; the Review screen
// needs only route params + a QueryClient. The guard is deep-imported by
// both screens and stays REAL (jest.setup.js runs useFocusEffect on mount).
// ---------------------------------------------------------------------------

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
  useLocalSearchParams: jest.fn(() => ({
    id: "capture-1",
    recipe_id: "recipe-9",
    status: "complete",
  })),
}));

jest.mock("../../lib/api/endpoints", () => ({
  listCaptureTokens: jest.fn(async () => []),
  revokeCaptureToken: jest.fn(async () => undefined),
}));

jest.mock("../../lib/auth/storage", () => ({
  removeCaptureToken: jest.fn(async () => undefined),
  getCaptureTokenId: jest.fn(async () => null),
}));

jest.mock("../../lib/auth/tokenOrchestrator", () => ({
  provisionAndStoreCaptureToken: jest.fn(async () => ({ ok: true })),
}));

jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ signOut: jest.fn(async () => undefined) })),
}));

jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
}));

import SettingsScreen from "../../app/(app)/(tabs)/settings";
import ReviewScreen from "../../app/(app)/review/[id]";
import { hapticTap } from "../../lib/haptics/haptics";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderWithTheme(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Settings: How Tastelog works guard (Build 4 C3)", () => {
  it("a rapid double tap pushes the how-it-works route exactly once with one haptic", () => {
    renderWithQueryClient(<SettingsScreen />);
    const row = screen.getByLabelText("How Tastelog works");
    fireEvent.press(row);
    fireEvent.press(row);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith("/(app)/how-it-works");
    expect(hapticTap).toHaveBeenCalledTimes(1);
  });
});

describe("Review: View Recipe guard (Build 4 C3)", () => {
  it("a rapid double tap pushes the recipe detail route exactly once", () => {
    renderWithQueryClient(<ReviewScreen />);
    const button = screen.getByText("View Recipe");
    fireEvent.press(button);
    fireEvent.press(button);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/recipe/[id]",
      params: { id: "recipe-9" },
    });
  });
});
