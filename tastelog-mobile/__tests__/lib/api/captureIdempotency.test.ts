// Draft capture routes carry an Idempotency-Key minted once per attempt.
//
// The endpoint functions and the hooks take the key from the caller: the add
// screen mints it when the input is chosen and keeps it until the input
// changes, so "Try Again" replays the same attempt.

import React, { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../../lib/api/client", () => ({
  apiFetch: jest.fn(),
}));
jest.mock("../../../lib/haptics/haptics", () => ({
  hapticWarning: jest.fn(),
}));

import { apiFetch } from "../../../lib/api/client";
import { captureDraft, captureURL } from "../../../lib/api/endpoints";
import { useCaptureUpload } from "../../../lib/hooks/useCaptureUpload";
import { useCaptureURL } from "../../../lib/hooks/useCaptureURL";

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const draft = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: "00000000-0000-0000-0000-000000000001",
  image_storage_keys: [],
  source_url: null,
  title: "Stub",
  servings: null,
  prep_time: null,
  cook_time: null,
  confidence_score: 0.9,
  ingredients: [],
  steps: [],
  raw_model_json: null,
  model_version: "m",
  parser_version: "p",
  expires_at: "2026-07-18T12:00:00+00:00",
};

function headerOfCall(index: number): string | undefined {
  const opts = mockApiFetch.mock.calls[index][0] as { headers?: Record<string, string> };
  return opts.headers?.["Idempotency-Key"];
}

// gcTime 0: the default 5-minute GC timer would keep the Jest process alive
// after the run (the existing screen tests do the same).
function wrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  return ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(draft as never);
});

describe("endpoints", () => {
  it("captureDraft sends the caller's key on the multipart route", async () => {
    const form = new FormData();
    await captureDraft(form, "key-a");
    const opts = mockApiFetch.mock.calls[0][0] as {
      path: string;
      body: unknown;
      headers?: Record<string, string>;
    };
    expect(opts.path).toBe("/api/drafts/capture");
    expect(opts.body).toBe(form);
    expect(opts.headers).toEqual({ "Idempotency-Key": "key-a" });
  });

  it("captureURL sends the caller's key on the JSON route", async () => {
    await captureURL("https://example.com/r", "key-b");
    const opts = mockApiFetch.mock.calls[0][0] as {
      path: string;
      body: unknown;
      headers?: Record<string, string>;
    };
    expect(opts.path).toBe("/api/drafts/capture-url");
    expect(opts.body).toEqual({ url: "https://example.com/r" });
    expect(opts.headers).toEqual({ "Idempotency-Key": "key-b" });
  });
});

describe("hooks send the caller's key unchanged, so a retry can reuse it", () => {
  it("useCaptureUpload", async () => {
    const { result } = renderHook(() => useCaptureUpload(), { wrapper: wrapper() });
    const image = { uri: "file:///a.jpg", name: "a.jpg", type: "image/jpeg" };

    await act(async () => {
      await result.current.mutateAsync({ images: [image], idempotencyKey: "same-key" });
    });
    await act(async () => {
      await result.current.mutateAsync({ images: [image], idempotencyKey: "same-key" });
    });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect([headerOfCall(0), headerOfCall(1)]).toEqual(["same-key", "same-key"]);
  });

  it("useCaptureURL", async () => {
    const { result } = renderHook(() => useCaptureURL(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync({ url: "https://example.com/r", idempotencyKey: "k-1" });
    });
    await act(async () => {
      await result.current.mutateAsync({ url: "https://example.com/r", idempotencyKey: "k-2" });
    });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect([headerOfCall(0), headerOfCall(1)]).toEqual(["k-1", "k-2"]);
  });
});
