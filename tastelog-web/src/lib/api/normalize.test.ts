// src/lib/api/normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeImageKey } from "@/lib/api/normalize";

describe("normalizeImageKey", () => {
  it("uses image_storage_key when present", () => {
    const input = { id: "1", image_storage_key: "a", image_path: "b" };
    const out = normalizeImageKey(input);
    expect(out.image_key).toBe("a");
    expect(out.id).toBe("1");
  });

  it("falls back to image_path when image_storage_key missing", () => {
    const input = { id: "1", image_path: "b" as const };
    const out = normalizeImageKey(input);
    expect(out.image_key).toBe("b");
  });

  it("returns null when neither exists", () => {
    const input = { id: "1" };
    const out = normalizeImageKey(input);
    expect(out.image_key).toBeNull();
  });

  it("does not mutate input", () => {
    const input = { id: "1", image_storage_key: "a" } as const;
    const out = normalizeImageKey(input);
    expect(Object.prototype.hasOwnProperty.call(input, "image_key")).toBe(false);
    expect(out.image_key).toBe("a");
  });
});
