import React from "react";
import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the screen is imported.
// Mirrors RecipeRiffScreen.test.tsx structure, swapping useRecipe for
// useDraft and useRiffSession for useDraftRiffSession, and adding the
// query-client / onSaveSuccess wiring specific to the draft flow.
// ---------------------------------------------------------------------------

const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "draft-1" })),
  useRouter: jest.fn(() => ({
    back: mockRouterBack,
    replace: mockRouterReplace,
  })),
}));

const mockUseDraftFn = jest.fn();
jest.mock("../../lib/hooks/useDraft", () => ({
  useDraft: (...args: unknown[]) => mockUseDraftFn(...args),
}));

const mockUseDraftRiffSession = jest.fn();
jest.mock("../../lib/hooks/useDraftRiffSession", () => ({
  useDraftRiffSession: (...args: unknown[]) =>
    mockUseDraftRiffSession(...args),
}));

const mockInvalidateQueries = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context"),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

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

import DraftRiffScreen from "../../app/(app)/draft/riff/[id]";
import type { DraftResponse } from "../../lib/api/schemas";
import { DRAFTS_QUERY_KEY, RECIPES_QUERY_KEY } from "../../lib/queryKeys";

function makeDraft(overrides: Partial<DraftResponse> = {}): DraftResponse {
  return {
    id: "draft-1",
    user_id: "user-1",
    title: "Test Draft",
    servings: null,
    prep_time: null,
    cook_time: null,
    confidence_score: 0.9,
    ingredients: [],
    steps: [],
    image_storage_keys: ["user/p1.jpg"],
    source_url: null,
    raw_model_json: null,
    model_version: "claude-sonnet-4-20250514",
    parser_version: "1.0",
    expires_at: "2026-06-01T00:00:00Z",
    created_at: "2026-05-12T00:00:00Z",
    updated_at: "2026-05-12T00:00:00Z",
    ...overrides,
  };
}

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
  mockUseDraftRiffSession.mockReturnValue(defaultControllerStub);
});

describe("DraftRiffScreen", () => {
  it("renders the draft title in the header when the draft loads", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft({ title: "Sourdough Boule" }),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
    expect(screen.getByText("Sourdough Boule")).toBeTruthy();
  });

  it("renders the loading state while the draft is loading", () => {
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
    expect(screen.getByText("Loading draft…")).toBeTruthy();
  });

  it("renders the error state when useDraft errors", () => {
    mockUseDraftFn.mockReturnValue({
      data: undefined,
      error: { message: "boom" },
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("calls router.back when the close button is pressed", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
    fireEvent.press(screen.getByLabelText("Close riff"));
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("protects close during the critical save window (Issue 1)", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseDraftRiffSession.mockReturnValue({
      ...defaultControllerStub,
      isSaving: true,
    });
    renderWithTheme(<DraftRiffScreen />);
    const close = screen.getByLabelText("Close riff");
    expect(close.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(close);
    expect(mockRouterBack).not.toHaveBeenCalled();
  });

  // Build 4 reliability correction (C4): the close control must LOOK
  // disabled while it is disabled. Same header-control convention as the
  // recipe-detail Edit entry (opacity 0.4 on the text).
  it("the close glyph is visibly dimmed while saving and announced disabled (Build 4 C4)", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseDraftRiffSession.mockReturnValue({
      ...defaultControllerStub,
      isSaving: true,
    });
    renderWithTheme(<DraftRiffScreen />);
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
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
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

  it("mounts <RiffChat /> on the canvas when the draft loads", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);
    expect(screen.getByTestId("riff-chat-stub")).toBeTruthy();
  });

  it("calls useDraftRiffSession with the draft id, entryPoint='draft_review', and an onSaveSuccess fn", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);

    expect(mockUseDraftRiffSession).toHaveBeenCalled();
    const [draftIdArg, optionsArg] = mockUseDraftRiffSession.mock.calls[0]!;
    expect(draftIdArg).toBe("draft-1");
    expect(optionsArg).toEqual(
      expect.objectContaining({
        entryPoint: "draft_review",
      }),
    );
    expect(typeof (optionsArg as { onSaveSuccess?: unknown }).onSaveSuccess)
      .toBe("function");
  });

  it("forwards the returned controller to RiffChat via the session prop", () => {
    const sentinelController = {
      ...defaultControllerStub,
      sessionId: "sess-sentinel",
    };
    mockUseDraftRiffSession.mockReturnValue(sentinelController);
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);

    expect(mockRiffChatProps).toHaveBeenCalled();
    const lastCall = mockRiffChatProps.mock.calls[
      mockRiffChatProps.mock.calls.length - 1
    ]![0] as { session?: unknown; showSaveCta?: boolean; initialDraft?: string };

    expect(lastCall.session).toBe(sentinelController);
    // Draft route never passes initialDraft (contract §5.3).
    expect(lastCall.initialDraft).toBeUndefined();
    // Draft route does NOT pass showSaveCta — RiffChat defaults to true.
    expect(lastCall.showSaveCta).toBeUndefined();
  });

  it("onSaveSuccess invalidates RECIPES_QUERY_KEY + DRAFTS_QUERY_KEY and router.replace's to the new recipe", () => {
    mockUseDraftFn.mockReturnValue({
      data: makeDraft(),
      error: undefined,
      isLoading: false,
      refetch: jest.fn(),
    });
    renderWithTheme(<DraftRiffScreen />);

    // Reach into the hook call's onSaveSuccess closure and fire it the
    // way useDraftRiffSession would on a successful save (2xx or 409
    // ALREADY_SAVED). Asserts on the route-owned side-effects:
    // cache invalidation + replace navigation.
    const optionsArg = mockUseDraftRiffSession.mock.calls[0]![1] as {
      onSaveSuccess: (recipeId: string) => void;
    };
    optionsArg.onSaveSuccess("rec-new");

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: RECIPES_QUERY_KEY,
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: DRAFTS_QUERY_KEY,
    });
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/(app)/recipe/[id]",
      params: { id: "rec-new" },
    });
  });
});
