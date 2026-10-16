import AsyncStorage from "@react-native-async-storage/async-storage";
import { HAS_ONBOARDED_KEY } from "../../constants/keys";

/**
 * Device-local onboarding completion state (Phase 15.3.1).
 *
 * The flag gates a PRE-AUTH surface (the first-run panels), so it is
 * deliberately device-scoped, not per-user: no user identity exists when it
 * is read, and Phase 15's no-backend invariant forbids a server-side flag.
 *
 * Contract (15.3.S binding plan):
 * - Hydration is BOUNDED and FAIL-OPEN: a hung or rejected read resolves
 *   `true` (treat as onboarded) so routing can never strand on storage. The
 *   worst failure cost is a new user missing the panels once.
 * - Completion is SYNCHRONOUS in memory (`markHasOnboarded` flips the
 *   snapshot before persisting) so routing decisions made in the same
 *   navigation tick observe it; persistence is fail-open (a lost write only
 *   means the skippable panels may appear once more after restart).
 * - Restored authenticated sessions structurally bypass onboarding. The
 *   bounded hydration below may still run during root initialisation (it is
 *   started unconditionally at mount, before the session is known), but its
 *   result cannot route an authenticated user into onboarding: the AuthGate
 *   decision ignores this state entirely whenever a session exists.
 */

/**
 * Deadline for the hydration read. Non-motion timeout constant — same
 * category as TOAST_DURATION_MS (recorded in the theme/motion.ts header
 * taxonomy), not a motion token.
 */
export const HAS_ONBOARDED_READ_DEADLINE_MS = 3_000;

let inMemoryHasOnboarded: boolean | null = null;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscribe function. */
export function subscribeHasOnboarded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `useSyncExternalStore` snapshot: `null` until hydration settles, then the
 * effective completion state.
 */
export function getHasOnboardedSnapshot(): boolean | null {
  return inMemoryHasOnboarded;
}

/**
 * Starts the bounded hydration read exactly once. Safe to call from render
 * effects on every mount; subsequent calls are no-ops. Always settles the
 * snapshot within the deadline (fail-open `true` on timeout or rejection).
 */
export function hydrateHasOnboarded(): void {
  if (hydrationStarted) return;
  hydrationStarted = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), HAS_ONBOARDED_READ_DEADLINE_MS);
  });
  const read = AsyncStorage.getItem(HAS_ONBOARDED_KEY).then(
    (value) => value === "true",
  );

  void Promise.race([read, deadline])
    .then((result) => (result === "timeout" ? true : result))
    .catch(() => true)
    .then((resolved) => {
      if (timer !== undefined) clearTimeout(timer);
      // A completion recorded while hydration was in flight must win: the
      // user just finished/skipped the panels on this device.
      if (inMemoryHasOnboarded !== true) {
        inMemoryHasOnboarded = resolved;
        notifyListeners();
      }
    });
}

/**
 * Records onboarding completion (finish or skip). Synchronous for routing;
 * persistence is fire-and-forget fail-open and never rejects.
 */
export function markHasOnboarded(): void {
  inMemoryHasOnboarded = true;
  notifyListeners();
  void AsyncStorage.setItem(HAS_ONBOARDED_KEY, "true").catch(() => {
    // Fail-open: a lost write only re-shows the skippable panels after a
    // restart. Never surfaces, never blocks.
  });
}

/**
 * Test-only reset of the module-level snapshot and one-shot hydration latch.
 *
 * Unit tests re-load this module via `jest.isolateModules`, but tests that
 * MOUNT the root layout cannot: a second module registry would supply a second
 * copy of React and every hook call would be invalid. Those tests reset the
 * module state instead. This changes no production behaviour and exposes no
 * routing internals.
 */
export function resetOnboardingStateForTests(): void {
  inMemoryHasOnboarded = null;
  hydrationStarted = false;
  listeners.clear();
}
