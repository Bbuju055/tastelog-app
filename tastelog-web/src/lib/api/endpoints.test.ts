// src/lib/api/endpoints.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api/client";
import { captureDraft } from "@/lib/api/endpoints";

const mockApiFetch = vi.mocked(apiFetch);

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

describe("captureDraft", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(draft as never);
  });

  it("sends the caller's Idempotency-Key with the multipart capture", async () => {
    const form = new FormData();
    const key = "7b1d3e0a-4c2f-4b8e-9a6d-1f2e3d4c5b6a";

    await captureDraft(form, key);

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const opts = mockApiFetch.mock.calls[0][0];
    expect(opts.path).toBe("/api/drafts/capture");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe(form);
    expect(opts.headers).toEqual({ "Idempotency-Key": key });
  });

  it("uses a different key for a different attempt", async () => {
    await captureDraft(new FormData(), "key-one");
    await captureDraft(new FormData(), "key-two");

    const keys = mockApiFetch.mock.calls.map((c) => c[0].headers?.["Idempotency-Key"]);
    expect(keys).toEqual(["key-one", "key-two"]);
  });
});
