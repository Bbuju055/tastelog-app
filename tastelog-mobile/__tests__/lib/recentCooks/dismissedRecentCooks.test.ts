/**
 * 15.2.4-CF-RC1 expansion — dismissal-marker storage module.
 *
 * Uses a local controllable AsyncStorage mock (overrides the global setup
 * mock) so write ordering is proven with deferred promises, not call counts.
 */

const mockStore = new Map<string, string>();
// One-shot gate: blocks only the FIRST setItem that encounters it, so a
// naive (non-serialized) implementation would let a second write finish
// while the first is still blocked — which the ordering tests detect.
let mockSetItemGate: Promise<void> | null = null;
let mockSetItemFailures = 0;
let mockGetItemFailures = 0;

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => {
      if (mockGetItemFailures > 0) {
        mockGetItemFailures -= 1;
        throw new Error("storage read failed");
      }
      return mockStore.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      if (mockSetItemGate) {
        const gate = mockSetItemGate;
        mockSetItemGate = null;
        await gate;
      }
      if (mockSetItemFailures > 0) {
        mockSetItemFailures -= 1;
        throw new Error("storage write failed");
      }
      mockStore.set(key, value);
    }),
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  isDismissedThrough,
  loadDismissedRecentCooks,
  removeDismissedRecentCook,
  updateDismissedRecentCooks,
} from "../../../lib/recentCooks/dismissedRecentCooks";

const KEY = "tastelog_dismissed_recent_cooks_v1";

function persisted(): Record<string, string> {
  const raw = mockStore.get(KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockStore.clear();
  mockSetItemGate = null;
  mockSetItemFailures = 0;
  mockGetItemFailures = 0;
  (AsyncStorage.getItem as jest.Mock).mockClear();
  (AsyncStorage.setItem as jest.Mock).mockClear();
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isDismissedThrough", () => {
  const MARKER = "2026-07-14T10:00:00Z";

  test("equal newest timestamp is hidden", () => {
    expect(isDismissedThrough("2026-07-14T10:00:00Z", MARKER)).toBe(true);
  });

  test("equal timestamps compare numerically across suffix formats", () => {
    expect(isDismissedThrough("2026-07-14T10:00:00+00:00", MARKER)).toBe(true);
  });

  test("older newest timestamp stays hidden", () => {
    expect(isDismissedThrough("2026-07-13T10:00:00Z", MARKER)).toBe(true);
  });

  test("newer newest timestamp is visible", () => {
    expect(isDismissedThrough("2026-07-14T10:00:01Z", MARKER)).toBe(false);
  });

  test("no marker is visible", () => {
    expect(isDismissedThrough(MARKER, undefined)).toBe(false);
  });

  test("malformed newest timestamp fails open to visible", () => {
    expect(isDismissedThrough("not-a-date", MARKER)).toBe(false);
  });

  test("malformed marker fails open to visible", () => {
    expect(isDismissedThrough(MARKER, "not-a-date")).toBe(false);
  });
});

describe("loadDismissedRecentCooks", () => {
  test("missing value loads as empty map", async () => {
    await expect(loadDismissedRecentCooks()).resolves.toEqual({});
  });

  test("valid map round-trips", async () => {
    mockStore.set(KEY, JSON.stringify({ "recipe-1": "2026-07-14T10:00:00Z" }));
    await expect(loadDismissedRecentCooks()).resolves.toEqual({
      "recipe-1": "2026-07-14T10:00:00Z",
    });
  });

  test("malformed JSON fails open to empty map", async () => {
    mockStore.set(KEY, "{nope");
    await expect(loadDismissedRecentCooks()).resolves.toEqual({});
  });

  test("non-object payloads fail open to empty map", async () => {
    mockStore.set(KEY, JSON.stringify(["recipe-1"]));
    await expect(loadDismissedRecentCooks()).resolves.toEqual({});
    mockStore.set(KEY, JSON.stringify(42));
    await expect(loadDismissedRecentCooks()).resolves.toEqual({});
  });

  test("non-string marker values are dropped", async () => {
    mockStore.set(
      KEY,
      JSON.stringify({ good: "2026-07-14T10:00:00Z", bad: 7, worse: null }),
    );
    await expect(loadDismissedRecentCooks()).resolves.toEqual({
      good: "2026-07-14T10:00:00Z",
    });
  });
});

describe("serialized persistence queue", () => {
  test("dismiss persists and remove deletes", async () => {
    await expect(
      updateDismissedRecentCooks((m) => ({ ...m, "recipe-1": "t1" })),
    ).resolves.toBe(true);
    expect(persisted()).toEqual({ "recipe-1": "t1" });

    await expect(removeDismissedRecentCook("recipe-1")).resolves.toBe(true);
    expect(persisted()).toEqual({});
  });

  test("removing an absent marker is a resolved no-op", async () => {
    await expect(removeDismissedRecentCook("ghost")).resolves.toBe(true);
    expect(persisted()).toEqual({});
  });

  test("two different dismissals preserve both markers", async () => {
    const first = updateDismissedRecentCooks((m) => ({ ...m, a: "t1" }));
    const second = updateDismissedRecentCooks((m) => ({ ...m, b: "t2" }));
    await Promise.all([first, second]);
    expect(persisted()).toEqual({ a: "t1", b: "t2" });
  });

  test("a delayed dismiss write cannot overwrite a later Undo (true FIFO, not call-count)", async () => {
    const gate = deferred();
    mockSetItemGate = gate.promise; // one-shot: blocks only the first write

    const dismiss = updateDismissedRecentCooks((m) => ({ ...m, a: "t1" }));
    const undo = updateDismissedRecentCooks((m) => {
      const next = { ...m };
      delete next.a;
      return next;
    });

    // While the first write is blocked, the second operation must not have
    // started its write — a naive parallel implementation would have
    // already completed it (the gate only blocks the first setItem).
    await flushMicrotasks();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.all([dismiss, undo]);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2);
    expect(persisted()).toEqual({});
  });

  test("recipe cleanup racing an earlier pending write cannot restore the marker", async () => {
    const gate = deferred();
    mockSetItemGate = gate.promise;

    const dismiss = updateDismissedRecentCooks((m) => ({ ...m, a: "t1" }));
    const cleanup = removeDismissedRecentCook("a");

    await flushMicrotasks();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1); // cleanup queued, not raced

    gate.resolve();
    await Promise.all([dismiss, cleanup]);
    expect(persisted()).toEqual({});
  });

  test("a failed write resolves false and does not poison the next operation", async () => {
    mockSetItemFailures = 1;
    await expect(
      updateDismissedRecentCooks((m) => ({ ...m, a: "t1" })),
    ).resolves.toBe(false);

    await expect(
      updateDismissedRecentCooks((m) => ({ ...m, b: "t2" })),
    ).resolves.toBe(true);
    expect(persisted()).toEqual({ b: "t2" });
  });

  test("a failed queued READ resolves false without clobbering other markers", async () => {
    mockStore.set(KEY, JSON.stringify({ a: "t1" }));
    mockGetItemFailures = 1;

    await expect(
      updateDismissedRecentCooks((m) => ({ ...m, b: "t2" })),
    ).resolves.toBe(false);
    // Nothing was written: marker "a" survives the transient read failure.
    expect(persisted()).toEqual({ a: "t1" });

    await expect(
      updateDismissedRecentCooks((m) => ({ ...m, b: "t2" })),
    ).resolves.toBe(true);
    expect(persisted()).toEqual({ a: "t1", b: "t2" });
  });

  test("dismiss → undo → dismiss ends with the marker persisted", async () => {
    const first = updateDismissedRecentCooks((m) => ({ ...m, a: "t1" }));
    const second = removeDismissedRecentCook("a");
    const third = updateDismissedRecentCooks((m) => ({ ...m, a: "t1" }));
    await Promise.all([first, second, third]);
    expect(persisted()).toEqual({ a: "t1" });
  });
});
