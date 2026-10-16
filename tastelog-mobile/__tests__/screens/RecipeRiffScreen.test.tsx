import React from "react";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen is imported.
// Pattern matches RecipeDetailStartCooking.test.tsx in the same directory.
// ---------------------------------------------------------------------------

const mockRouterBack = jest.fn();
const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "recipe-1" })),
  useRouter: jest.fn(() => ({ back: mockRouterBack, push: mockRouterPush })),
}));

const mockUseRecipeFn = jest.fn();
jest.mock("../../lib/hooks", () => ({
  useRecipe: (...args: unknown[]) => mockUseRecipeFn(...args),
}));

// Phase 13.9 Slice H — the route now owns the useRiffSession call (was
// internal to RiffChat). Mock the hook at the route-test layer so the
// existing "forwards to RiffChat" tests can assert the controller arg
// flows from useRiffSession's return → RiffChat's `session` prop.
const mockUseRiffSession = jest.fn();
jest.mock("../../lib/hooks/useRiffSession", () => ({
  useRiffSession: (...args: unknown[]) => mockUseRiffSession(...args),
}));

// useSafeAreaInsets in react-native-safe-area-context v5 throws when rendered
// outside a SafeAreaProvider. The Riff screen calls it for its custom-header
// top inset (fullScreenModal). Override with deterministic zero insets here;
// keep everything else (SafeAreaView etc.) intact via requireActual.
jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context"),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// Recording stub. Captures props per render so Phase 13.8 forwarding tests
// can assert what RecipeRiffScreen passes down. Preserves the existing
// testID/text so the "mounts" test stays green. Per
// feedback_barrel_exports_auth_graph.md the factory uses requireActual to
// avoid jest hoisting pitfalls AND avoids importing the real component
// (which would drag the auth/network graph). The "mock" prefix is required
// for the identifier to be referenced inside the jest.mock() factory.
const mockRiffChatProps = jest.fn();
jest.mock("../../components/RiffChat", () => {
  const ReactActual = jest.requireActual("react");
  const { Text } = jest.requireActual("react-native");
  return {
    RiffChat: (props: unknown) => {
      mockRiffChatProps(props);
      return ReactActual.createElement(
        Text,
        { testID: "riff-chat-stub" },
        "RIFF_CHAT_MOUNTED",
      );
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import RecipeRiffScreen from "../../app/(app)/recipe/riff/[id]";
import { useLocalSearchParams } from "expo-router";
import type { RecipeDetailResponse } from "../../lib/api/schemas";

function makeRecipe(
  overrides: Partial<RecipeDetailResponse> = {},
): RecipeDetailResponse {
  return {
    id: "recipe-1",
    user_id: "user-1",
    title: "Test Recipe",
    image_storage_key: null,
    image_path: null,
    source_url: null,
    servings: null,
    prep_time: null,
    cook_time: null,
    confidence_score: null,
    favorite: false,
    tags: [],
    ingredients: [],
    steps: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Default useRiffSession return — a minimal controller shape that lets the
// recipe screen mount without exercising any state transitions. Each test
// that cares about the controller identity can return a distinct sentinel
// via mockReturnValueOnce.
const defaultControllerStub = {
  messages: [],
  sessionId: null,
  sendMessage: jest.fn(),
  isLoading: false,
  isStreaming: false,
  cancel: jest.fn(),
  currentPartialAssistantMessage: null,
  streamError: null,
  error: null,
  savedMessageIds: new Set<string>(),
  saveRecipe: jest.fn(),
  isSaving: false,
  saveError: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseRiffSession.mockReturnValue(defaultControllerStub);
});

describe("RecipeRiffScreen", () => {
  it("renders the recipe title in the header when the recipe loads", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe({ title: "Spicy Pasta" }),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    expect(screen.getByText("Spicy Pasta")).toBeTruthy();
  });

  it("renders the loading state while the recipe is loading", () => {
    mockUseRecipeFn.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    expect(screen.getByText("Loading recipe…")).toBeTruthy();
  });

  it("renders the error state when useRecipe errors", () => {
    mockUseRecipeFn.mockReturnValue({
      data: undefined,
      error: { message: "boom" },
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("calls router.back when the close button is pressed", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    fireEvent.press(screen.getByLabelText("Close riff"));
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("protects close during the critical save window (Issue 1)", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseRiffSession.mockReturnValue({
      ...defaultControllerStub,
      isSaving: true,
    });
    renderWithTheme(<RecipeRiffScreen />);
    const close = screen.getByLabelText("Close riff");
    expect(close.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(close);
    expect(mockRouterBack).not.toHaveBeenCalled();
  });

  // Build 4 reliability correction (C4): the close control must LOOK
  // disabled while it is disabled. Same header-control convention as the
  // recipe-detail Edit entry (opacity 0.4 on the text).
  it("the close glyph is visibly dimmed while saving and announced disabled (Build 4 C4)", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseRiffSession.mockReturnValue({
      ...defaultControllerStub,
      isSaving: true,
    });
    renderWithTheme(<RecipeRiffScreen />);
    const close = screen.getByLabelText("Close riff");
    expect(close.props.accessibilityState).toMatchObject({ disabled: true });
    const glyph = screen.getByText("\u2715");
    const flat = Object.assign(
      {},
      ...([] as unknown[]).concat(glyph.props.style).flat(Infinity).filter(Boolean),
    );
    expect(flat.opacity).toBe(0.4);
  });

  it("the close glyph is at full opacity and enabled when not saving (Build 4 C4)", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    const close = screen.getByLabelText("Close riff");
    expect(close.props.accessibilityState).toMatchObject({ disabled: false });
    const glyph = screen.getByText("\u2715");
    const flat = Object.assign(
      {},
      ...([] as unknown[]).concat(glyph.props.style).flat(Infinity).filter(Boolean),
    );
    expect(flat.opacity).toBeUndefined();
    fireEvent.press(close);
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("mounts <RiffChat /> on the canvas when the recipe loads", () => {
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);
    expect(screen.getByTestId("riff-chat-stub")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Phase 13.9 Slice H — useRiffSession ownership + controller forwarding
  // -------------------------------------------------------------------------

  it("calls useRiffSession with the recipe id and forwards the returned controller to RiffChat", () => {
    const sentinelController = {
      ...defaultControllerStub,
      sessionId: "sess-sentinel",
    };
    mockUseRiffSession.mockReturnValue(sentinelController);
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);

    // Hook was called with the recipeId. Conditional-spread options arg
    // is undefined when no entryPoint param is present (regression guard
    // matching the useRiffSession.test.tsx "omits entryPoint" assertion).
    expect(mockUseRiffSession).toHaveBeenCalledWith("recipe-1", undefined);

    // RiffChat received the exact controller object returned by the mock.
    const lastCall = mockRiffChatProps.mock.calls[
      mockRiffChatProps.mock.calls.length - 1
    ]![0] as { session?: unknown };
    expect(lastCall.session).toBe(sentinelController);
  });

  it("forwards entryPoint to useRiffSession and initialDraft/showSaveCta=false to RiffChat when grocery_substitute params are present", () => {
    (useLocalSearchParams as jest.Mock).mockReturnValueOnce({
      id: "recipe-1",
      entryPoint: "grocery_substitute",
      initialDraft: "What can I substitute for Flour in this recipe?",
    });
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);

    // entryPoint flows into useRiffSession's options arg (was previously
    // a RiffChat prop; Slice H moves anchor-specific args up to the route).
    expect(mockUseRiffSession).toHaveBeenCalledWith(
      "recipe-1",
      { entryPoint: "grocery_substitute" },
    );

    // initialDraft + showSaveCta=false remain anchor-agnostic RiffChat props.
    expect(mockRiffChatProps).toHaveBeenCalled();
    const lastCall = mockRiffChatProps.mock.calls[
      mockRiffChatProps.mock.calls.length - 1
    ]![0];
    expect(lastCall).toEqual(
      expect.objectContaining({
        initialDraft: "What can I substitute for Flour in this recipe?",
        showSaveCta: false,
      }),
    );
    // Regression: recipeId / entryPoint are no longer RiffChat props.
    expect(lastCall).not.toHaveProperty("recipeId");
    expect(lastCall).not.toHaveProperty("entryPoint");
  });

  it("preserves recipe-detail behavior with showSaveCta=true when entryPoint and initialDraft params are absent", () => {
    // useLocalSearchParams default mock returns { id: "recipe-1" } only —
    // no override needed. Both new params are absent → screen normalizes
    // them to undefined and derives showSaveCta=true.
    mockUseRecipeFn.mockReturnValue({
      data: makeRecipe(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<RecipeRiffScreen />);

    // Hook called with undefined options (no entryPoint).
    expect(mockUseRiffSession).toHaveBeenCalledWith("recipe-1", undefined);

    expect(mockRiffChatProps).toHaveBeenCalled();
    const lastCall = mockRiffChatProps.mock.calls[
      mockRiffChatProps.mock.calls.length - 1
    ]![0] as {
      session?: unknown;
      initialDraft?: string;
      showSaveCta?: boolean;
    };
    expect(lastCall.initialDraft).toBeUndefined();
    expect(lastCall.showSaveCta).toBe(true);
    expect(lastCall.session).toBeDefined();
  });
});
