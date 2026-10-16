import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  acknowledgePostAuthDestination,
  POST_AUTH_DESTINATION_CLEAR_DEADLINE_MS,
  POST_AUTH_DESTINATION_READ_DEADLINE_MS,
  POST_AUTH_DESTINATION_TTL_MS,
  readPostAuthDestinationOnce,
  resetPostAuthDestinationMemoForTests,
  writePostAuthDestination,
} from "../../../lib/onboarding/postAuthDestination";
import { POST_AUTH_DESTINATION_KEY } from "../../../constants/keys";

/**
 * 15.3.1 — durable post-auth destination, two-phase lifecycle.
 *
 * The read is non-destructive and memoised; the clear happens only after the
 * consumer has routed. Every failure path resolves null (falls back safely to
 * Recipes) and none of them may strand routing.
 */

const ADD_HREF = "/(app)/(tabs)/add";

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  jest.restoreAllMocks();
  resetPostAuthDestinationMemoForTests();
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

// NOTE: AsyncStorage's official jest mock exposes methods that are ALREADY
// jest.fn instances, so jest.spyOn returns them un-registered for restore —
// non-Once overrides would leak into later tests. Always use ...Once here.

describe("read is non-destructive and memoised", () => {
  test("two concurrent reads share one storage read and get the same href", async () => {
    await writePostAuthDestination(ADD_HREF);
    const getItem = jest.spyOn(AsyncStorage, "getItem");

    const [a, b] = await Promise.all([
      readPostAuthDestinationOnce(),
      readPostAuthDestinationOnce(),
    ]);

    expect(a).toBe(ADD_HREF);
    expect(b).toBe(ADD_HREF);
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  test("reading does NOT clear storage — a later read still sees it", async () => {
    await writePostAuthDestination(ADD_HREF);

    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
    await expect(
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
    ).resolves.not.toBeNull();
  });

  /**
   * The regression that motivated the two-phase split: an AuthGate effect run
   * is cancelled after the read resolves (a fresh `session` identity re-runs
   * the effect). The cancelled run must not consume the destination, and the
   * surviving run must still receive and route with it.
   */
  test("a cancelled reader does not rob its successor of the destination", async () => {
    await writePostAuthDestination(ADD_HREF);

    // Run #1 reads, then is abandoned without acknowledging.
    const abandoned = await readPostAuthDestinationOnce();
    expect(abandoned).toBe(ADD_HREF);

    // Run #2 (the surviving effect) still gets the href and routes.
    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
  });

  test("write resets the memo so a destination written after a read is visible", async () => {
    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();

    await writePostAuthDestination(ADD_HREF);

    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
  });

  test("acknowledge resets the memo and clears storage", async () => {
    await writePostAuthDestination(ADD_HREF);
    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);

    await acknowledgePostAuthDestination();

    await expect(
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
    ).resolves.toBeNull();
    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });
});

describe("relaunch + persistence", () => {
  test("the record survives a simulated relaunch (email-confirmation path)", async () => {
    await writePostAuthDestination(ADD_HREF);

    // Relaunch = nothing memoised in memory; only the persisted record matters.
    resetPostAuthDestinationMemoForTests();

    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
  });

  test("read with nothing stored resolves null", async () => {
    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });
});

describe("invalid payloads are rejected and cleaned up", () => {
  test("malformed JSON resolves null and is cleared", async () => {
    await AsyncStorage.setItem(POST_AUTH_DESTINATION_KEY, "{not json");

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
    await flushMicrotasks();
    await expect(
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
    ).resolves.toBeNull();
  });

  test("stale version resolves null and is cleared", async () => {
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({ v: 2, href: ADD_HREF, ts: Date.now() }),
    );

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
    await flushMicrotasks();
    await expect(
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
    ).resolves.toBeNull();
  });

  test("non-path href resolves null (no external navigation)", async () => {
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({ v: 1, href: "https://evil.example", ts: Date.now() }),
    );

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });

  test("a record without a usable timestamp is treated as malformed", async () => {
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({ v: 1, href: ADD_HREF }),
    );

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });
});

describe("expiry backstop (a failed clear can never loop forever)", () => {
  test("a record past the TTL resolves null and is cleared", async () => {
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({
        v: 1,
        href: ADD_HREF,
        ts: Date.now() - POST_AUTH_DESTINATION_TTL_MS - 1_000,
      }),
    );

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
    await flushMicrotasks();
    await expect(
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
    ).resolves.toBeNull();
  });

  test("a record inside the TTL is still honoured", async () => {
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({
        v: 1,
        href: ADD_HREF,
        ts: Date.now() - (POST_AUTH_DESTINATION_TTL_MS - 60_000),
      }),
    );

    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
  });

  test("an unclearable record still stops looping once it ages out", async () => {
    // Cleanup never lands...
    jest
      .spyOn(AsyncStorage, "removeItem")
      .mockRejectedValueOnce(new Error("nope"));
    await writePostAuthDestination(ADD_HREF);
    await expect(readPostAuthDestinationOnce()).resolves.toBe(ADD_HREF);
    await acknowledgePostAuthDestination();

    // ...so the record is still there on the next launch.
    resetPostAuthDestinationMemoForTests();
    const raw = await AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY);
    expect(raw).not.toBeNull();

    // Age it past the TTL: the next read refuses it, so no permanent loop.
    const stale = JSON.parse(raw as string) as { ts: number };
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify({
        ...stale,
        ts: stale.ts - POST_AUTH_DESTINATION_TTL_MS - 1_000,
      }),
    );
    resetPostAuthDestinationMemoForTests();

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });
});

describe("storage failures never strand routing", () => {
  test("rejected write resolves false, never rejects", async () => {
    jest
      .spyOn(AsyncStorage, "setItem")
      .mockRejectedValueOnce(new Error("disk full"));

    await expect(writePostAuthDestination(ADD_HREF)).resolves.toBe(false);
  });

  test("rejected read resolves null, never rejects", async () => {
    jest
      .spyOn(AsyncStorage, "getItem")
      .mockRejectedValueOnce(new Error("storage down"));

    await expect(readPostAuthDestinationOnce()).resolves.toBeNull();
  });

  test("hung read resolves null at the deadline", async () => {
    jest.useFakeTimers();
    jest
      .spyOn(AsyncStorage, "getItem")
      .mockImplementationOnce(() => new Promise<string | null>(() => {}));

    const read = readPostAuthDestinationOnce();
    await flushMicrotasks();
    jest.advanceTimersByTime(POST_AUTH_DESTINATION_READ_DEADLINE_MS);

    await expect(read).resolves.toBeNull();
  });

  test("rejected cleanup resolves (routing already happened, TTL is the backstop)", async () => {
    await writePostAuthDestination(ADD_HREF);
    jest
      .spyOn(AsyncStorage, "removeItem")
      .mockRejectedValueOnce(new Error("nope"));

    await expect(acknowledgePostAuthDestination()).resolves.toBeUndefined();
  });

  /**
   * The strand this design exists to prevent: a `removeItem` that never
   * settles must not leave the acknowledgement pending forever.
   */
  test("a never-settling cleanup resolves at the deadline", async () => {
    jest.useFakeTimers();
    jest
      .spyOn(AsyncStorage, "removeItem")
      .mockImplementationOnce(() => new Promise<void>(() => {}));

    const ack = acknowledgePostAuthDestination();
    await flushMicrotasks();
    jest.advanceTimersByTime(POST_AUTH_DESTINATION_CLEAR_DEADLINE_MS);

    await expect(ack).resolves.toBeUndefined();
  });
});
