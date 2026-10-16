import AsyncStorage from "@react-native-async-storage/async-storage";
import { POST_AUTH_DESTINATION_KEY } from "../../constants/keys";

/**
 * Durable post-auth destination (Phase 15.3.1, two-phase lifecycle).
 *
 * Written when the non-skip onboarding path completes so the "land on Add"
 * intent survives email confirmation, backgrounding, process death, and
 * relaunch.
 *
 * The lifecycle is deliberately split in two, because the consumer is a React
 * effect that may be cancelled and restarted at any await point (a fresh
 * `session` object identity from `INITIAL_SESSION` / `SIGNED_IN` /
 * `TOKEN_REFRESHED` re-runs it):
 *
 * 1. `readPostAuthDestinationOnce()` — NON-DESTRUCTIVE, memoised. Overlapping
 *    effect runs share one in-flight read and all observe the same href, so a
 *    cancelled run can never consume the value on behalf of the run that
 *    actually navigates.
 * 2. `acknowledgePostAuthDestination()` — called only AFTER routing has been
 *    dispatched. Bounded and fire-and-forget: a hung or rejected clear must
 *    never block navigation.
 *
 * A destructive read-then-return helper is intentionally absent: it cannot be
 * made safe here, because "returned" and "acted upon" are not the same event.
 *
 * Safety net: records carry a timestamp and a finite TTL. If a clear is lost
 * (storage rejects, process dies between routing and acknowledgement) the
 * record expires on its own, so a failed clear can never strand a device in a
 * permanent "always relaunch into Add" loop.
 */

type PostAuthDestinationRecord = {
  v: 1;
  href: string;
  ts: number;
};

/** Deadline for the durable read. Non-motion timeout constant. */
export const POST_AUTH_DESTINATION_READ_DEADLINE_MS = 3_000;

/** Deadline for the acknowledgement clear. Non-motion timeout constant. */
export const POST_AUTH_DESTINATION_CLEAR_DEADLINE_MS = 3_000;

/**
 * Lifetime of the intent. Generous enough to survive an email-confirmation
 * round trip (check mail on another device, confirm, come back) but finite so
 * an unclearable record self-heals instead of looping forever.
 */
export const POST_AUTH_DESTINATION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Race sentinel; a Symbol can never collide with a stored string value. */
const TIMED_OUT = Symbol("post-auth-destination-timeout");

let readPromise: Promise<string | null> | null = null;

function parseRecord(raw: string | null): PostAuthDestinationRecord | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { href?: unknown }).href === "string" &&
      (parsed as { href: string }).href.startsWith("/") &&
      typeof (parsed as { ts?: unknown }).ts === "number" &&
      Number.isFinite((parsed as { ts: number }).ts)
    ) {
      return parsed as PostAuthDestinationRecord;
    }
    // Unknown version or malformed shape: stale value, discard.
    return null;
  } catch {
    return null;
  }
}

/**
 * Bounded, non-throwing removal. Resolves at the deadline even if the
 * underlying `removeItem` never settles, so no caller can strand on it.
 */
async function clearStoredDestination(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POST_AUTH_DESTINATION_CLEAR_DEADLINE_MS);
  });
  try {
    await Promise.race([
      AsyncStorage.removeItem(POST_AUTH_DESTINATION_KEY).catch(() => {
        // Non-fatal: the TTL is the backstop for a clear that never lands.
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Persists the destination. Resolves `false` on failure and never rejects — a
 * lost write only costs the Add landing (falls back to Recipes). Resets the
 * memoised read so a destination written after an earlier read is observable.
 */
export async function writePostAuthDestination(href: string): Promise<boolean> {
  readPromise = null;
  try {
    const record: PostAuthDestinationRecord = { v: 1, href, ts: Date.now() };
    await AsyncStorage.setItem(
      POST_AUTH_DESTINATION_KEY,
      JSON.stringify(record),
    );
    return true;
  } catch {
    return false;
  }
}

async function readStoredDestination(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(
      () => resolve(TIMED_OUT),
      POST_AUTH_DESTINATION_READ_DEADLINE_MS,
    );
  });

  try {
    const raw = await Promise.race([
      AsyncStorage.getItem(POST_AUTH_DESTINATION_KEY),
      deadline,
    ]);
    // A hung read must not strand routing; the record stays for next launch.
    if (raw === TIMED_OUT) return null;

    const record = parseRecord(raw);

    // Something was stored but is unusable (malformed, wrong version, or
    // expired): drop it through the same bounded cleanup path so it cannot
    // accumulate. Not awaited — cleanup never gates the routing decision.
    if (raw != null && record === null) {
      void clearStoredDestination();
      return null;
    }
    if (record === null) return null;
    if (Date.now() - record.ts > POST_AUTH_DESTINATION_TTL_MS) {
      void clearStoredDestination();
      return null;
    }

    return record.href;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Non-destructive, memoised read of the durable destination. Every concurrent
 * caller shares one in-flight read and receives the same href, so an effect
 * cancelled after the await cannot rob its successor of the value.
 *
 * Reading does NOT consume: call `acknowledgePostAuthDestination()` once the
 * destination has actually been routed to.
 */
export function readPostAuthDestinationOnce(): Promise<string | null> {
  readPromise ??= readStoredDestination();
  return readPromise;
}

/**
 * Marks the destination as acted upon: forgets the memoised read and clears
 * storage through the bounded path. Fire-and-forget by contract — the
 * returned promise always resolves (tests await it) and is never awaited on
 * the navigation path.
 */
export function acknowledgePostAuthDestination(): Promise<void> {
  readPromise = null;
  return clearStoredDestination();
}

/** Test-only reset of module-level memoisation. */
export function resetPostAuthDestinationMemoForTests(): void {
  readPromise = null;
}
