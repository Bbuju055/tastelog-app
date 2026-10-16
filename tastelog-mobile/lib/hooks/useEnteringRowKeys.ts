import { useMemo, useRef } from "react";

/**
 * Phase 15.1.3 — entering-row detection for list `entering` animations.
 *
 * Returns the set of row keys that genuinely appeared in `keys` after the
 * list's initial data load. Reanimated `entering` animations must fire only
 * for those rows — never on first render (the 10.G staggered entrance owns
 * that moment), never on FlatList virtualization remounts during scroll
 * (a remounted row's key is already seen), and never when a previously-seen
 * row is restored (optimistic-delete rollback, cleared search filter).
 *
 * `ready` gates seeding: until the first render with `ready === true`,
 * nothing is seeded and no key is reported as entering. On that first ready
 * render the current keys become the baseline and do NOT enter.
 *
 * `scopeKey` scopes the baseline: when it changes (grocery passes
 * `activeListId`), the seen-set is re-seeded from the current keys and
 * nothing enters — switching lists is an instant swap, not a mass fade-in.
 * Callers with a single dataset (recipe list) omit it.
 *
 * Section boundary rows (grocery's "completed-separator") must NOT flow
 * through this hook — they get their own appearance rule at the call site,
 * because they should fade on every appear/disappear cycle, which the
 * seen-once semantics here would suppress after the first cycle.
 *
 * Like useStaggeredEntrance, this mutates refs during render via a
 * sentinel pattern: a seen key is never re-flagged. If the memo re-runs
 * after flagging but before the row's cell mounts (refetch race, discarded
 * render), the row appears without a fade — benign by design.
 */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

export function useEnteringRowKeys(
  keys: readonly string[],
  ready: boolean,
  scopeKey?: string | null,
): ReadonlySet<string> {
  const seenRef = useRef<Set<string> | null>(null);
  const scopeRef = useRef<string | null | undefined>(scopeKey);

  return useMemo(() => {
    if (!ready) return EMPTY_KEYS;

    if (seenRef.current === null || scopeRef.current !== scopeKey) {
      scopeRef.current = scopeKey;
      seenRef.current = new Set(keys);
      return EMPTY_KEYS;
    }

    const seen = seenRef.current;
    const entering = new Set<string>();
    for (const key of keys) {
      if (!seen.has(key)) {
        entering.add(key);
        seen.add(key);
      }
    }
    return entering.size > 0 ? entering : EMPTY_KEYS;
  }, [keys, ready, scopeKey]);
}
