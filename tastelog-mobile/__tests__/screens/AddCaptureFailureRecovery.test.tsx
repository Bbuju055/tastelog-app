import React from "react";
import { act, fireEvent } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";
import { ApiError } from "../../lib/errors";

/**
 * 15.3.3 — Add-screen failure paths, first deterministic coverage:
 * - URL-capture 401 signs out (parity with the photo path);
 * - offline photo capture renders honest copy + draft recovery;
 * - photo-library permission denial renders the Open Settings block.
 *
 * Mock topology mirrors AddCaptureSuccessBeat.test.tsx (the established
 * Add-screen harness).
 */

const mockRouterPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
  useFocusEffect: jest.fn(),
}));
jest.mock("expo-clipboard", () => ({}));

const mockRequestPermissions = jest.fn(async () => ({ granted: true }));
const mockLaunchLibrary = jest.fn(async () => ({
  canceled: false,
  assets: [{ uri: "file:///p1.jpg", assetId: "a1", fileName: "p1.jpg" }],
}));
jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) =>
    mockRequestPermissions(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchLibrary(...args),
  MediaTypeOptions: { Images: "Images" },
}));
jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: jest.fn(() => ({
      renderAsync: jest.fn(async () => ({
        saveAsync: jest.fn(async () => ({ uri: "file:///p1-conv.jpg" })),
      })),
    })),
  },
  SaveFormat: { JPEG: "jpeg" },
}));

const mockOpenSettings = jest.fn();
jest.mock("expo-linking", () => ({
  openSettings: (...args: unknown[]) => mockOpenSettings(...args),
}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
}));

const mockUploadMutation = {
  mutate: jest.fn(),
  reset: jest.fn(),
  isPending: false,
  isSuccess: false,
  error: null as unknown,
};
const mockUrlMutation = {
  mutate: jest.fn(),
  reset: jest.fn(),
  isPending: false,
  isSuccess: false,
  error: null as unknown,
};
jest.mock("../../lib/hooks", () => ({
  useCaptureUpload: jest.fn(() => mockUploadMutation),
  useCaptureURL: jest.fn(() => mockUrlMutation),
}));

const mockListDrafts = jest.fn(async (): Promise<unknown[]> => []);
jest.mock("../../lib/api/endpoints", () => ({
  listDrafts: (...args: unknown[]) => mockListDrafts(...args),
}));

const mockSignOut = jest.fn();
jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({ signOut: mockSignOut })),
}));
jest.mock("../../lib/haptics/haptics", () => ({
  hapticTap: jest.fn(),
  hapticSuccess: jest.fn(),
}));

const mockUseReducedMotion = jest.fn((): boolean => false);
jest.mock("../../lib/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import AddScreen from "../../app/(app)/(tabs)/add";

async function settle() {
  await act(async () => {});
}

function expiredSessionError() {
  return new ApiError({ message: "Unauthorized", kind: "http", status: 401 });
}

function networkError() {
  return new ApiError({ message: "Network request failed", kind: "network" });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUploadMutation.error = null;
  mockUploadMutation.isPending = false;
  mockUploadMutation.isSuccess = false;
  mockUrlMutation.error = null;
  mockUrlMutation.isPending = false;
  mockUrlMutation.isSuccess = false;
  mockRequestPermissions.mockImplementation(async () => ({ granted: true }));
  mockListDrafts.mockImplementation(async () => []);
});

describe("expired-session sign-out parity (15.3.3)", () => {
  test("URL-capture 401 signs out", async () => {
    mockUrlMutation.error = expiredSessionError();

    renderWithTheme(<AddScreen />);
    await settle();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("photo-capture 401 still signs out (regression)", async () => {
    mockUploadMutation.error = expiredSessionError();

    renderWithTheme(<AddScreen />);
    await settle();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  test("non-401 errors do not sign out", async () => {
    mockUrlMutation.error = networkError();

    renderWithTheme(<AddScreen />);
    await settle();

    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe("offline photo capture (screen-level)", () => {
  async function selectPhotoAndUpload(view: ReturnType<typeof renderWithTheme>) {
    fireEvent.press(view.getByText("Pick Photos from Gallery"));
    await settle();
    fireEvent.press(view.getByText("Upload & Capture"));
    await settle();
    const call =
      mockUploadMutation.mutate.mock.calls[
        mockUploadMutation.mutate.mock.calls.length - 1
      ];
    return call[1] as { onError: (err: unknown) => void };
  }

  test("network failure renders honest copy with Try Again when no draft was recovered", async () => {
    const view = renderWithTheme(<AddScreen />);
    await settle();

    const options = await selectPhotoAndUpload(view);
    const err = networkError();
    mockUploadMutation.error = err;
    await act(async () => {
      options.onError(err);
    });
    // Mutating the mock's error doesn't re-render on its own; the real
    // mutation would. Re-render so the screen reads the errored state.
    view.rerender(<AddScreen />);
    await settle();

    expect(mockListDrafts).toHaveBeenCalled();
    expect(view.getByText("No connection")).toBeTruthy();
    expect(
      // Typographic apostrophe — matches the mapper copy exactly.
      view.getByText("Couldn’t reach the server. Check your internet and try again."),
    ).toBeTruthy();
    expect(view.getByText("Try Again")).toBeTruthy();
  });

  test("network failure with a server-side draft recovers it (View Draft navigates)", async () => {
    mockListDrafts.mockImplementation(async () => [
      {
        id: "draft-recovered",
        created_at: new Date(Date.now() + 5_000).toISOString(),
      },
    ]);

    const view = renderWithTheme(<AddScreen />);
    await settle();

    const options = await selectPhotoAndUpload(view);
    const err = networkError();
    mockUploadMutation.error = err;
    await act(async () => {
      options.onError(err);
    });
    view.rerender(<AddScreen />);
    await settle();

    expect(view.getByText("Recipe saved")).toBeTruthy();
    fireEvent.press(view.getByText("View Draft"));
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-recovered" },
    });
  });

  test("a rapid double tap on View Draft navigates exactly once (Build 4 C3)", async () => {
    // The handler nulls recoveredDraftId synchronously, but a same-frame
    // second tap still sees the pre-null closure: only the guard excludes it.
    mockListDrafts.mockImplementation(async () => [
      {
        id: "draft-recovered",
        created_at: new Date(Date.now() + 5_000).toISOString(),
      },
    ]);

    const view = renderWithTheme(<AddScreen />);
    await settle();

    const options = await selectPhotoAndUpload(view);
    const err = networkError();
    mockUploadMutation.error = err;
    await act(async () => {
      options.onError(err);
    });
    view.rerender(<AddScreen />);
    await settle();

    // Same frame: two activations with no render flush between them, the
    // way a physical double tap lands before React commits the null-out.
    const viewDraft = view.UNSAFE_getByProps({ title: "View Draft" });
    act(() => {
      viewDraft.props.onPress();
      viewDraft.props.onPress();
    });
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/(app)/draft/[id]",
      params: { id: "draft-recovered" },
    });
  });
});

describe("photo-library permission denial", () => {
  test("denied permission renders the block with a working Open Settings action", async () => {
    mockRequestPermissions.mockImplementation(async () => ({ granted: false }));

    const view = renderWithTheme(<AddScreen />);
    await settle();

    fireEvent.press(view.getByText("Pick Photos from Gallery"));
    await settle();

    expect(view.getByText("Photo access required")).toBeTruthy();
    expect(mockLaunchLibrary).not.toHaveBeenCalled();

    fireEvent.press(view.getByText("Open Settings"));
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });
});
