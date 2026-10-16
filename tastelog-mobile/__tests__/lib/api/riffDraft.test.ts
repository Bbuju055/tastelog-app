/**
 * Phase 13.9 Slice G — draft-anchored Riff API helper wire-shape tests.
 *
 * Confirms that postDraftRiffTurn / postDraftRiffSave / streamDraftRiffTurn
 * compose the correct URLs and request bodies. The recipe-anchored helpers
 * (postRiffTurn / postRiffSave / streamRiffTurn) are NOT tested here —
 * they're exercised through useRiffSession.test.tsx and remain at zero
 * regression risk for this slice.
 *
 * Body shape parity assertions:
 *   - postDraftRiffTurn matches postRiffTurn: conditional spread on
 *     session_id and entry_point (key omitted when absent).
 *   - streamDraftRiffTurn matches streamRiffTurn: session_id ALWAYS
 *     present (`?? null`), entry_point conditional-spread.
 *   - postDraftRiffSave matches postRiffSave: session_id + message_id +
 *     riff_label always present.
 */

// Mock the SSE transport BEFORE importing the module under test so the
// helper picks up the spy. Capture the constructor args in a module-scope
// mock so each test can read the URL + body the helper composed.
const mockEventSourceCtor = jest.fn();

jest.mock("react-native-sse", () => {
  return {
    __esModule: true,
    default: class MockEventSource {
      constructor(url: string, options: Record<string, unknown>) {
        mockEventSourceCtor(url, options);
      }
      addEventListener() {}
      close() {}
    },
  };
});

// apiFetch is the boundary the sync helpers go through. Capturing its
// args is the wire-shape assertion for postDraftRiffTurn / postDraftRiffSave.
jest.mock("../../../lib/api/client", () => ({
  apiFetch: jest.fn(),
}));

jest.mock("../../../lib/auth/supabase", () => ({
  getAccessToken: jest.fn(),
}));

import { apiFetch } from "../../../lib/api/client";
import { getAccessToken } from "../../../lib/auth/supabase";
import {
  postDraftRiffSave,
  postDraftRiffTurn,
  streamDraftRiffTurn,
} from "../../../lib/api/riff";

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;
const mockGetAccessToken = getAccessToken as jest.MockedFunction<
  typeof getAccessToken
>;

describe("postDraftRiffTurn", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({
      session_id: "sess-1",
      assistant_message: "ok",
    });
  });

  it("targets /api/drafts/{draftId}/riff with conditional-spread body", async () => {
    await postDraftRiffTurn({ draftId: "draft-abc", message: "hello" });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.path).toBe("/api/drafts/draft-abc/riff");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ message: "hello" });
    // Regression guard: no session_id / entry_point keys when omitted.
    expect(call.body).not.toHaveProperty("session_id");
    expect(call.body).not.toHaveProperty("entry_point");
  });

  it("includes session_id when provided", async () => {
    await postDraftRiffTurn({
      draftId: "d1",
      message: "again",
      sessionId: "sess-xyz",
    });

    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.body).toEqual({
      message: "again",
      session_id: "sess-xyz",
    });
  });

  it("includes entry_point when provided", async () => {
    await postDraftRiffTurn({
      draftId: "d1",
      message: "hi",
      entryPoint: "draft_review",
    });

    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.body).toEqual({
      message: "hi",
      entry_point: "draft_review",
    });
  });

  it("URL-encodes the draftId", async () => {
    await postDraftRiffTurn({
      draftId: "weird/id with spaces",
      message: "hi",
    });

    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.path).toBe(
      `/api/drafts/${encodeURIComponent("weird/id with spaces")}/riff`,
    );
  });
});

describe("postDraftRiffSave", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ recipe_id: "rec-new" });
  });

  it("targets /api/drafts/{draftId}/riff/save with all three save fields", async () => {
    await postDraftRiffSave({
      draftId: "d1",
      sessionId: "s1",
      messageId: "m1",
      riffLabel: "Dairy-free",
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.path).toBe("/api/drafts/d1/riff/save");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      session_id: "s1",
      message_id: "m1",
      riff_label: "Dairy-free",
    });
  });

  it("passes null riff_label through unchanged", async () => {
    await postDraftRiffSave({
      draftId: "d1",
      sessionId: "s1",
      messageId: "m1",
      riffLabel: null,
    });

    const call = mockApiFetch.mock.calls[0]![0];
    expect(call.body).toEqual({
      session_id: "s1",
      message_id: "m1",
      riff_label: null,
    });
  });
});

describe("streamDraftRiffTurn", () => {
  beforeEach(() => {
    mockEventSourceCtor.mockReset();
    mockGetAccessToken.mockReset();
    mockGetAccessToken.mockResolvedValue("test-token");
  });

  // The "callbacks" object is required by the helper signature but the
  // body-shape tests don't drive any events through it.
  const noopCallbacks = {
    onSessionResolved: jest.fn(),
    onUserMessageCommitted: jest.fn(),
    onAssistantDelta: jest.fn(),
    onAssistantComplete: jest.fn(),
    onGeneratedRecipeReady: jest.fn(),
    onError: jest.fn(),
    onDone: jest.fn(),
  };

  it("opens EventSource at /api/drafts/{draftId}/riff/stream", async () => {
    await streamDraftRiffTurn({
      draftId: "draft-abc",
      message: "hello",
      callbacks: noopCallbacks,
    });

    expect(mockEventSourceCtor).toHaveBeenCalledTimes(1);
    const [url, opts] = mockEventSourceCtor.mock.calls[0]!;
    expect(url).toBe(
      "http://test.local/api/drafts/draft-abc/riff/stream",
    );
    expect((opts as { method?: string }).method).toBe("POST");
  });

  it("body uses session_id: null when no sessionId provided (parity with streamRiffTurn)", async () => {
    await streamDraftRiffTurn({
      draftId: "d1",
      message: "hello",
      callbacks: noopCallbacks,
    });

    const [, opts] = mockEventSourceCtor.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({
      message: "hello",
      session_id: null,
    });
  });

  it("body uses session_id: <id> when sessionId provided", async () => {
    await streamDraftRiffTurn({
      draftId: "d1",
      message: "hi",
      sessionId: "sess-1",
      callbacks: noopCallbacks,
    });

    const [, opts] = mockEventSourceCtor.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({
      message: "hi",
      session_id: "sess-1",
    });
  });

  it("body uses conditional-spread entry_point (parity with streamRiffTurn)", async () => {
    await streamDraftRiffTurn({
      draftId: "d1",
      message: "hi",
      entryPoint: "draft_review",
      callbacks: noopCallbacks,
    });

    const [, opts] = mockEventSourceCtor.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({
      message: "hi",
      session_id: null,
      entry_point: "draft_review",
    });
  });

  it("omits entry_point key when not provided", async () => {
    await streamDraftRiffTurn({
      draftId: "d1",
      message: "hi",
      callbacks: noopCallbacks,
    });

    const [, opts] = mockEventSourceCtor.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).not.toHaveProperty("entry_point");
  });

  it("sets Authorization + content-type headers", async () => {
    await streamDraftRiffTurn({
      draftId: "d1",
      message: "hi",
      callbacks: noopCallbacks,
    });

    const [, opts] = mockEventSourceCtor.mock.calls[0]!;
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("throws apiErrorFromValidation when no access token is available", async () => {
    mockGetAccessToken.mockResolvedValueOnce(null);

    await expect(
      streamDraftRiffTurn({
        draftId: "d1",
        message: "hi",
        callbacks: noopCallbacks,
      }),
    ).rejects.toMatchObject({
      kind: "validation",
    });
    expect(mockEventSourceCtor).not.toHaveBeenCalled();
  });
});
