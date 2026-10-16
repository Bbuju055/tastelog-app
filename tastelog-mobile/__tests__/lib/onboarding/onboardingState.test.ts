/**
 * 15.3.1 — device-local onboarding completion state.
 *
 * The module holds intentional module-level state (snapshot + one-shot
 * hydration), so each test loads a FRESH copy via jest.isolateModules and
 * pulls AsyncStorage from the SAME isolated registry (repo gotcha: the
 * official mock's in-memory store is per-module-instance).
 */

type StateModule = typeof import("../../../lib/onboarding/onboardingState");
type StorageLike = {
  getItem: jest.Mock | ((key: string) => Promise<string | null>);
  setItem: (key: string, value: string) => Promise<void>;
};

const KEY = "tastelog_has_onboarded_v1";

function loadIsolated(): { state: StateModule; storage: StorageLike } {
  let state!: StateModule;
  let storage!: StorageLike;
  jest.isolateModules(() => {
    // CJS interop: the jest.setup factory returns the official mock module
    // directly, so `.default` may or may not exist depending on interop.
    const storageModule = require("@react-native-async-storage/async-storage");
    storage = storageModule.default ?? storageModule;
    state = require("../../../lib/onboarding/onboardingState");
  });
  return { state, storage };
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("hydrateHasOnboarded", () => {
  test("fresh device hydrates to false", async () => {
    const { state } = loadIsolated();
    expect(state.getHasOnboardedSnapshot()).toBeNull();

    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(false);
  });

  test("persisted completion hydrates to true", async () => {
    const { state, storage } = loadIsolated();
    await storage.setItem(KEY, "true");

    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(true);
  });

  test("malformed persisted value hydrates to false", async () => {
    const { state, storage } = loadIsolated();
    await storage.setItem(KEY, "yes");

    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(false);
  });

  test("rejected read fails open to true", async () => {
    const { state, storage } = loadIsolated();
    jest
      .spyOn(storage as { getItem: (key: string) => Promise<string | null> }, "getItem")
      .mockRejectedValue(new Error("storage down"));

    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(true);
  });

  test("read that never settles fails open at the deadline", async () => {
    jest.useFakeTimers();
    const { state, storage } = loadIsolated();
    jest
      .spyOn(storage as { getItem: (key: string) => Promise<string | null> }, "getItem")
      .mockReturnValue(new Promise<string | null>(() => {}));

    state.hydrateHasOnboarded();
    await flushMicrotasks();
    expect(state.getHasOnboardedSnapshot()).toBeNull();

    jest.advanceTimersByTime(state.HAS_ONBOARDED_READ_DEADLINE_MS);
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(true);
  });

  test("hydration runs the storage read exactly once", async () => {
    const { state, storage } = loadIsolated();
    const readSpy = jest.spyOn(
      storage as { getItem: (key: string) => Promise<string | null> },
      "getItem",
    );

    state.hydrateHasOnboarded();
    state.hydrateHasOnboarded();
    await flushMicrotasks();
    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  test("subscribers are notified when hydration settles", async () => {
    const { state } = loadIsolated();
    const listener = jest.fn();
    state.subscribeHasOnboarded(listener);

    state.hydrateHasOnboarded();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalled();
  });
});

describe("markHasOnboarded", () => {
  test("flips the snapshot synchronously and persists", async () => {
    const { state, storage } = loadIsolated();

    state.markHasOnboarded();
    expect(state.getHasOnboardedSnapshot()).toBe(true);

    await flushMicrotasks();
    await expect(
      (storage as { getItem: (key: string) => Promise<string | null> }).getItem(KEY),
    ).resolves.toBe("true");
  });

  test("a rejected persist write stays silent and in-memory true", async () => {
    const { state, storage } = loadIsolated();
    jest
      .spyOn(storage as unknown as { setItem: (k: string, v: string) => Promise<void> }, "setItem")
      .mockRejectedValue(new Error("disk full"));

    state.markHasOnboarded();
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(true);
  });

  test("completion recorded during in-flight hydration wins over the read", async () => {
    const { state, storage } = loadIsolated();
    let resolveRead!: (value: string | null) => void;
    jest
      .spyOn(storage as { getItem: (key: string) => Promise<string | null> }, "getItem")
      .mockReturnValue(
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
      );

    state.hydrateHasOnboarded();
    state.markHasOnboarded();
    expect(state.getHasOnboardedSnapshot()).toBe(true);

    resolveRead(null); // stored value says "not onboarded"
    await flushMicrotasks();

    expect(state.getHasOnboardedSnapshot()).toBe(true);
  });
});
