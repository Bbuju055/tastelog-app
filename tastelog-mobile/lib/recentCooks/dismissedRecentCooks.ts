import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Device-local Recently Cooked dismissal markers (15.2.4-CF-RC1 expansion).
 *
 * Shape: recipeId -> dismissedThroughCookedAt (the raw `cooked_at` of the
 * newest cook at dismissal time). A recipe is hidden while its newest cook
 * is not newer than the marker, so a genuinely newer cook reveals the card
 * again while deleting the dismissed cook (older cook becomes newest) keeps
 * it hidden.
 *
 * Persistence is intentionally local-only (residual RC1-R3) and non-fatal
 * on failure (residual RC1-R4): the UI stays optimistic; a lost write only
 * means the card can return after restart.
 */

const STORAGE_KEY = "tastelog_dismissed_recent_cooks_v1";

export type DismissedRecentCooks = Record<string, string>;

function validateDismissedRecentCooks(raw: unknown): DismissedRecentCooks {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const validated: DismissedRecentCooks = {};
  for (const [recipeId, marker] of Object.entries(raw)) {
    if (typeof marker === "string") {
      validated[recipeId] = marker;
    }
  }
  return validated;
}

function parsePersisted(raw: string | null): DismissedRecentCooks {
  if (raw == null) return {};
  try {
    return validateDismissedRecentCooks(JSON.parse(raw));
  } catch {
    // Malformed JSON is corrupt data — treat as empty (and let the next
    // write replace it). History is never touched.
    return {};
  }
}

export async function loadDismissedRecentCooks(): Promise<DismissedRecentCooks> {
  try {
    return parsePersisted(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    // Hydration read failure: fail open to an empty map so truthful server
    // data stays visible.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Serialized persistence queue.
//
// Every persisted mutation joins this module-level promise chain, reads and
// validates the LATEST persisted map inside its own turn, applies its
// transform, and writes the result. FIFO join order preserves invocation
// order across dismiss, Undo, and recipe-deletion cleanup, so a delayed
// dismiss write can never overwrite a later Undo and cleanup can never be
// clobbered by an earlier pending save. Each queued operation resolves
// `false` instead of rejecting on failure, so one failed write neither
// poisons later writes nor produces an unhandled promise rejection.
// ---------------------------------------------------------------------------

let writeQueue: Promise<unknown> = Promise.resolve();

export function updateDismissedRecentCooks(
  transform: (current: DismissedRecentCooks) => DismissedRecentCooks,
): Promise<boolean> {
  const queued = writeQueue
    .then(async () => {
      // STRICT read inside the queued turn: a getItem rejection must
      // propagate so this operation resolves false WITHOUT writing —
      // treating a transient read failure as an empty map would let a
      // single dismissal clobber every other persisted marker. (Malformed
      // JSON, by contrast, is corrupt data and is deliberately replaced.)
      const current = parsePersisted(await AsyncStorage.getItem(STORAGE_KEY));
      const next = transform(current);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return true;
    })
    .catch(() => false);
  writeQueue = queued;
  return queued;
}

export function removeDismissedRecentCook(recipeId: string): Promise<boolean> {
  return updateDismissedRecentCooks((current) => {
    if (!(recipeId in current)) return current;
    const next = { ...current };
    delete next[recipeId];
    return next;
  });
}

/**
 * Hidden while the newest cook is not newer than the marker. Comparison is
 * numeric (Date.parse) — PostgREST timestamp suffixes vary ("Z" vs
 * "+00:00"), so raw-string comparison is unsafe. Any malformed timestamp
 * fails open to visible.
 */
export function isDismissedThrough(
  newestCookedAt: string,
  marker: string | undefined,
): boolean {
  if (marker == null) return false;
  const newest = Date.parse(newestCookedAt);
  const through = Date.parse(marker);
  if (Number.isNaN(newest) || Number.isNaN(through)) return false;
  return newest <= through;
}
