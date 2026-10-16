/**
 * Build 5 Class B native-Back diagnostic: trace core.
 * Authority: docs/build5-classb-native-back-diagnostic-plan.md (sections 7,
 * 8, 9, 10). INTERNAL TESTFLIGHT DIAGNOSTIC ONLY, NEVER PROMOTE TO CUSTOMER
 * RELEASE; removed by the section 16 gate before any customer build.
 *
 * Contents: the flag gate, the bounded JS ring with overflow accounting and
 * the 9.0a arm gate, the redaction boundary (7.4), the v10 timebase contract
 * (7.5: anchors, drift, record intervals, epochs, window sequence validity)
 * with the section 10 membership and ordering categories, root-owned
 * persistence with read-back verification (8.2 / 8.5), the process-wide
 * diagnostics store that the root owner, pill, screens and Settings share
 * (same external-store pattern as lib/onboarding/onboardingState.ts), and the
 * pure evaluators the root applies: launch calibration (6, C1 sub-codes),
 * swipe outcome (9.3) and the Phase 3 GO_BACK partition (10).
 *
 * Everything here is inert unless EXPO_PUBLIC_NAV_DIAGNOSTICS === "1":
 * `navDiagnostics.record` returns before allocating anything.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { env } from "../config";
import type {
  EnableResult,
  NativeRecord,
  ProbeSnapshot,
} from "../../modules/nav-probe";

export type {
  DrainResult,
  EnableResult,
  NativeRecord,
  NativeRecordKind,
  ProbeHookState,
  ProbeSnapshot,
} from "../../modules/nav-probe";

// ---------------------------------------------------------------------------
// Constants (sections 7.2, 8.2, 9)
// ---------------------------------------------------------------------------

export const NAV_CAPTURE_STORAGE_KEY = "tastelog_nav_capture_v1";
export const NAV_TRACE_STORAGE_KEY = "tastelog_nav_trace_v1";
export const JS_RING_CAPACITY = 4096;
export const NATIVE_RING_CAPACITY = 2048;
/** 9.0: native Back must follow "Back arm" within this window (operator). */
export const BACK_ARM_WINDOW_MS = 3000;
/** 9.1: a "Back dead" marker later than this after "Back arm" is UNANCHORED. */
export const BACK_DEAD_MAX_ANCHOR_MS = 10_000;
/** 9.2: passive persistence window snapshots (dead0, dead500, dead2000). */
export const DEAD_SNAPSHOT_OFFSETS_MS = [0, 500, 2000] as const;
/** 9.3: root-owned swipe observation window and its snapshots. */
export const SWIPE_WINDOW_MS = 3000;
export const SWIPE_SNAPSHOT_OFFSETS_MS = [300, 1500] as const;
/** 9.4: GO_BACK observation window; classification only at its end. */
export const JS_BACK_WINDOW_MS = 3000;
export const JS_BACK_SNAPSHOT_OFFSETS_MS = [300, 1500] as const;
/** 6 (P5): a native.headerUpdate must arrive within this window for C2. */
export const HEADER_CALIB_WINDOW_MS = 1000;
/** 6 P5 (v11): the controlled header-config title change; restore = headerTitle undefined. */
export const HEADER_CALIB_TITLE = "Recipe (calibrating)";
/** 6 / 19 (v11): accepted calibration attempts allowed per required C1 sample. */
export const CALIB_ATTEMPTS_PER_SAMPLE = 3;
/** 6 (P4): settle delay between the post-Back state event and C1 evaluation. */
export const CALIB_SETTLE_MS = 300;
/** 7.5.2: an anchor whose half round-trip exceeds this is rejected. */
export const U_MAX_MS = 100;
/** 7.5.5: a segment wider than this is a GAP (new epoch). */
export const W_MAX_MS = 600;
/** 9.0a: a visit is arm-eligible only this long after its open snapshot completed. */
export const OPEN_SETTLE_MS = 500;
/** 9.0a: wake-anchor retries after a rejected or failed wake snapshot. */
export const WAKE_ANCHOR_RETRIES = 5;
export const WAKE_ANCHOR_RETRY_MS = 200;
/** 7.5.1: a steady (process-relative) clock reads far below this; wall clocks read ~1.7e12. */
export const JS_CLOCK_STEADY_BOUND_MS = 1e11;
export const REDACTED = "[redacted]";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

export function isNavDiagnosticsEnabled(): boolean {
  return env.EXPO_PUBLIC_NAV_DIAGNOSTICS === "1";
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const processStartMs = Date.now();

function hasPerformanceNow(): boolean {
  return typeof performance !== "undefined" && typeof performance.now === "function";
}

/** Milliseconds on the JS trace timebase (performance.now when available). */
export function nowMs(): number {
  if (hasPerformanceNow()) {
    return performance.now();
  }
  return Date.now() - processStartMs;
}

export type JsClockProvider = "steady" | "wall";

/**
 * 7.5.1 provider guard: "steady" only when performance.now is in use AND
 * reads of process-relative magnitude; any wall-clock derived value fails
 * closed (the plan's non-decrease property does not hold for it).
 */
export function jsClockProvider(): JsClockProvider {
  return hasPerformanceNow() && performance.now() < JS_CLOCK_STEADY_BOUND_MS ? "steady" : "wall";
}

// ---------------------------------------------------------------------------
// Trace schema (7.1)
// ---------------------------------------------------------------------------

export type TraceValue =
  | string
  | number
  | boolean
  | null
  | TraceValue[]
  | { [key: string]: TraceValue };

export type TraceDetail = { [key: string]: TraceValue };

export type TraceEntryKind =
  | "nav.state"
  | "nav.action"
  | "scr.transitionStart"
  | "scr.transitionEnd"
  | "scr.focus"
  | "scr.blur"
  | "scr.gestureCancel"
  | "ui.rowPress"
  | "ui.detailMount"
  | "grocery.press"
  | "grocery.picker"
  | "grocery.pickerResult"
  | "grocery.mutation"
  | "toast.show"
  | "toast.dismiss"
  | "guard"
  | "hdr.optionsBuilt"
  | "diag.snapshot"
  | "diag.backAttempt"
  | "diag.mark"
  | "diag.capture"
  | "diag.swipe"
  | "diag.jsBack"
  | "diag.timebase"
  | "diag.ready"
  | "app.state"
  | "native.popDelegate"
  | "native.headerUpdate"
  | "diag.overflow";

/** 7.5 interval fields carried by snapshots and translated native records. */
export type EntryTimebase = {
  tLo: number;
  tHi: number;
  epoch: number;
  tb: "ok" | "indeterminate" | "postAnchor";
  /** GAP segments only: the time implied by the NEXT anchor (7.5.5). */
  tAlt?: number;
};

/**
 * 7.1: every entry declares [tLo, tHi] on the JS clock; a JS entry is the
 * exact point tLo = tHi = t; epoch/tb/tAlt exist only on cross-clock entries.
 */
export type TraceEntry = {
  s: number;
  t: number;
  k: TraceEntryKind;
  d: TraceDetail;
  tLo: number;
  tHi: number;
  epoch?: number;
  tb?: EntryTimebase["tb"];
  tAlt?: number;
};

export type TraceHeader = {
  sessionToken: string;
  launchNo: number;
  wallStart: string;
  appVersion: string | null;
  appBuild: string | null;
  iosVersion: string | null;
  deviceModel: string | null;
  flag: string;
  probeStatus: EnableResult | null;
  calibrationStatus: string;
  /** Session-once header calibration (6, P5 / C2) survives relaunches. */
  c2PassedSession: boolean;
  /** 6 C1 didPop telemetry of this launch's calibration (never a criterion). */
  c1DidPopObserved: number | null;
  /** 7.5.1 provider guard result at enable ("unknown" before enable). */
  jsClockProvider: JsClockProvider | "unknown";
  /** 7.5: accepted anchors, detected gaps and epochs so far. */
  timebaseAnchors: number;
  timebaseGaps: number;
  epochCount: number;
  /** 9.2 / 9.3 / 9.4: 7.5.7 results for the capture's windows (null = not evaluated). */
  attemptWindowSequenceValid: boolean | null;
  escapeWindowsSequenceValid: { swipe: boolean | null; jsBack: boolean | null };
  jsRingCapacity: number;
  nativeRingCapacity: number;
  jsOverflow: number;
  nativeOverflow: number;
  /** 6 P5 (v11): JS-options -> native latency of the set / restore hits (reference data). */
  c2SetLatencyMs: number | null;
  c2RestoreLatencyMs: number | null;
  /** 6 / 19 (v11): accepted calibration attempts per required C1 sample this launch. */
  calibAttempts1: number;
  calibAttempts2: number;
  /** null until P5 ran on this launch; then whether the post-P5 sample passed. */
  postP5SamplePassed: boolean | null;
};

export type TraceExport = { header: TraceHeader; entries: TraceEntry[] };

export type CaptureAppendixLabel = "swipe" | "jsBack";
export type CaptureAppendix = { label: CaptureAppendixLabel; entries: TraceEntry[] };

/** The IMMUTABLE last dead-Back capture (8.2). Appendices only ever grow. */
export type CaptureRecord = {
  header: TraceHeader;
  capturedAt: string;
  entries: TraceEntry[];
  appendices: CaptureAppendix[];
};

// ---------------------------------------------------------------------------
// Redaction (7.4): a per-key allowlist. A string survives only when its KEY
// names an allowed category AND its value matches that category's format:
// UUIDs for ids, hex pointer tokens, route names/keys, class names and the
// fixed enumeration vocabulary. Every other string (titles, ingredient or
// list names, toast text, typed text, user identifiers, single tokens under
// an unknown key) is replaced, so no record site can leak content by
// mistake.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POINTER_TOKEN_RE = /^0x[0-9a-f]{1,16}$/;
/** react-navigation route names and keys, e.g. "recipe/[id]", "(tabs)-1". */
const ROUTE_RE = /^[A-Za-z0-9_()/[\].:-]{1,96}$/;
const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,95}$/;

const ID_KEYS = new Set(["recipeId", "listId"]);
const TOKEN_KEYS = new Set(["navId", "wrapperToken", "itemToken", "vcToken"]);
const ROUTE_KEYS = new Set([
  "routeKey",
  "routeKeyPre",
  "key",
  "name",
  "navKey",
  "navName",
  "focusedNavKey",
  "focusedNavName",
  "source",
  "target",
]);
const CLASS_KEYS = new Set(["topVCClass", "wrapperClass", "presentedVCClass"]);
/** Fixed enumeration vocabulary per key (7.4): anything else is redacted. */
const ENUM_VOCABULARY: Record<string, ReadonlySet<string>> = {
  kind: new Set(["shouldPop", "didPop", "headerUpdate", "unknown"]),
  phase: new Set([
    "start",
    "success",
    "error",
    "write",
    "writeFailed",
    "saved",
    "end",
    "dispatchError",
    // 6 P5 (v11): header-calibration phases.
    "set",
    "restore",
  ]),
  reason: new Set([
    "calibOpen",
    "calibPreBack",
    "calibPostBack",
    "dead0",
    "dead500",
    "dead2000",
    "swipePre",
    "swipe300",
    "swipe1500",
    "jsBackPre",
    "jsBack300",
    "jsBack1500",
    "jsBack3000",
    "export",
    "visitOpen",
    "wake",
    "calibEval",
    "swipe3000",
    // 6 P5 (v11): the pre-drain anchor and the two window boundaries.
    "headerCalibPre",
    "headerCalibEval",
    // diag.ready reasons (9.0a): the first failing eligibility term.
    "eligible",
    "notInitialised",
    "background",
    "noEpoch",
    "visitClosed",
    "settling",
    // 9.0a (v11): arms refused during P5 and trial arms before CALIBRATED.
    "headerCalib",
    "notCalibrated",
    "calibLocked",
  ]),
  state: new Set(["active", "background", "inactive", "unknown", "extension"]),
  outcome: new Set(["popped", "cancelled", "noEvent", "Q5e", "INVALID", "A", "F1", "F2", "F3", "B", "G", "C", "D"]),
  path: new Set(["existing", "newCreated", "sheetCancel", "promptCancel", "createError"]),
  mode: new Set(["auto", "sheet"]),
  label: new Set(["backDead", "calibrated", "headerCalib", "calibEval", "headerCalibEval"]),
  visitKind: new Set(["calibration", "priming", "trial"]),
  arm: new Set(["A", "B", "C", "D"]),
  anchor: new Set(["A1", "A2", "A3", "A4"]),
  probe: new Set(["absent", "failed"]),
  invalidReason: new Set([
    "focusedStackMissing",
    "otherController",
    "noPinnedController",
    "snapshotUnavailable",
  ]),
};
/** react-navigation action types are upper-case identifiers, never content. */
const ACTION_TYPE_RE = /^[A-Z][A-Z_]{1,31}$/;

function stringAllowed(key: string, value: string): boolean {
  if (ID_KEYS.has(key)) return UUID_RE.test(value);
  if (TOKEN_KEYS.has(key)) return POINTER_TOKEN_RE.test(value);
  if (ROUTE_KEYS.has(key)) return ROUTE_RE.test(value);
  if (CLASS_KEYS.has(key)) return CLASS_NAME_RE.test(value);
  if (key === "type") return ACTION_TYPE_RE.test(value);
  const vocabulary = ENUM_VOCABULARY[key];
  if (vocabulary) return vocabulary.has(value);
  return false;
}

function redactValue(key: string, value: unknown): TraceValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return stringAllowed(key, value) ? value : REDACTED;
  if (Array.isArray(value)) {
    const out: TraceValue[] = [];
    for (const item of value) {
      const v = redactValue(key, item);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (typeof value === "object") {
    return redactDetail(value);
  }
  return undefined;
}

export function redactDetail(detail: unknown): TraceDetail {
  const out: TraceDetail = {};
  if (detail === null || typeof detail !== "object") return out;
  for (const [key, raw] of Object.entries(detail as Record<string, unknown>)) {
    const v = redactValue(key, raw);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JS ring (7.2 / 7.3): fixed capacity, oldest overwritten, overflow counted.
// ---------------------------------------------------------------------------

export class TraceRing {
  readonly capacity: number;
  overflow = 0;
  private seq = 0;
  private readonly slots: (TraceEntry | null)[];
  private head = 0;
  private count = 0;
  private armGate: (() => boolean) | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array<TraceEntry | null>(capacity).fill(null);
  }

  /**
   * 9.0a: the root registers the arm-eligibility check here. The pill's
   * "Back arm" press writes diag.backAttempt straight into this ring (9.0);
   * the gate runs synchronously inside that write, so a refused arm writes
   * nothing, advances no sequence number and returns null.
   */
  setArmGate(gate: (() => boolean) | null): void {
    this.armGate = gate;
  }

  push(
    k: TraceEntryKind,
    d: unknown,
    t: number = nowMs(),
    timebase?: EntryTimebase,
  ): TraceEntry | null {
    if (k === "diag.backAttempt" && this.armGate !== null && !this.armGate()) return null;
    this.seq += 1;
    const entry: TraceEntry = {
      s: this.seq,
      t,
      k,
      d: redactDetail(d),
      tLo: timebase ? timebase.tLo : t,
      tHi: timebase ? timebase.tHi : t,
    };
    if (timebase) {
      entry.epoch = timebase.epoch;
      entry.tb = timebase.tb;
      if (timebase.tAlt !== undefined) entry.tAlt = timebase.tAlt;
    }
    if (this.count < this.capacity) {
      this.slots[(this.head + this.count) % this.capacity] = entry;
      this.count += 1;
    } else {
      this.slots[this.head] = entry;
      this.head = (this.head + 1) % this.capacity;
      this.overflow += 1;
    }
    return entry;
  }

  size(): number {
    return this.count;
  }

  /** Sequence number of the most recent push (0 before any push). */
  lastSeq(): number {
    return this.seq;
  }

  /** Insertion order, oldest first. */
  entries(): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const e = this.slots[(this.head + i) % this.capacity];
      if (e) out.push(e);
    }
    return out;
  }

  /** Timebase order (t, then seq); native entries interleave by time. */
  sorted(): TraceEntry[] {
    return sortEntries(this.entries());
  }

  /** Arm boundary (7.2): entries and overflow cleared; seq keeps counting. */
  reset(): void {
    this.slots.fill(null);
    this.head = 0;
    this.count = 0;
    this.overflow = 0;
  }
}

export function sortEntries(entries: TraceEntry[]): TraceEntry[] {
  return [...entries].sort((a, b) => (a.t === b.t ? a.s - b.s : a.t - b.t));
}

// ---------------------------------------------------------------------------
// Timebase contract (7.5): anchors, drift, record intervals, epochs
// ---------------------------------------------------------------------------

/** 7.5.2: one bracketed native call. */
export type AnchorSample = { source: string; jsBefore: number; jsAfter: number; nativeS: number };

export type TimebaseAnchor = {
  source: string;
  jsBefore: number;
  jsAfter: number;
  jsMid: number;
  u: number;
  nativeS: number;
  epoch: number;
  /** Segment from the previous accepted anchor (null on the first anchor). */
  driftMs: number | null;
  widthSegMs: number | null;
  gap: boolean;
};

export type TimebaseState = { anchors: TimebaseAnchor[]; gaps: number; rejected: number };

export type AnchorOutcome = {
  accepted: boolean;
  anchor: TimebaseAnchor | null;
  /** The diag.timebase record detail (7.1). */
  detail: TraceDetail;
};

export function createTimebase(): TimebaseState {
  return { anchors: [], gaps: 0, rejected: 0 };
}

/**
 * 7.5.2 / 7.5.3 / 7.5.5: accept or reject a sample; on acceptance classify
 * the segment from the previous anchor (usable or GAP => new epoch).
 */
export function acceptAnchor(state: TimebaseState, sample: AnchorSample): AnchorOutcome {
  const roundTripMs = sample.jsAfter - sample.jsBefore;
  const u = roundTripMs / 2;
  const jsMid = (sample.jsBefore + sample.jsAfter) / 2;
  const prev = state.anchors[state.anchors.length - 1] ?? null;
  if (u > U_MAX_MS) {
    state.rejected += 1;
    return {
      accepted: false,
      anchor: null,
      detail: {
        source: sample.source,
        epoch: prev?.epoch ?? 0,
        roundTripMs,
        u,
        driftMs: null,
        widthSegMs: null,
        gap: false,
        rejected: true,
      },
    };
  }
  let driftMs: number | null = null;
  let widthSegMs: number | null = null;
  let gap = false;
  let epoch = 0;
  if (prev) {
    driftMs = jsMid - prev.jsMid - 1000 * (sample.nativeS - prev.nativeS);
    widthSegMs = Math.max(0, driftMs) + 3 * prev.u + u;
    gap = widthSegMs > W_MAX_MS;
    epoch = prev.epoch + (gap ? 1 : 0);
    if (gap) state.gaps += 1;
  }
  const anchor: TimebaseAnchor = {
    source: sample.source,
    jsBefore: sample.jsBefore,
    jsAfter: sample.jsAfter,
    jsMid,
    u,
    nativeS: sample.nativeS,
    epoch,
    driftMs,
    widthSegMs,
    gap,
  };
  state.anchors.push(anchor);
  return {
    accepted: true,
    anchor,
    detail: { source: sample.source, epoch, roundTripMs, u, driftMs, widthSegMs, gap, rejected: false },
  };
}

/** Number of epochs seen so far (0 before the first accepted anchor). */
export function epochCount(state: TimebaseState): number {
  return state.anchors.length === 0 ? 0 : state.gaps + 1;
}

export type NativeTranslation = { t: number } & EntryTimebase;

/**
 * 7.5.4 / 7.5.5 / 7.5.6: translate one native timestamp into a JS-clock
 * display time plus its declared interval. Returns null with no anchor.
 * The invariant: the true JS time of the record lies inside [tLo, tHi].
 */
export function translateNative(
  state: TimebaseState,
  nativeS: number,
  jsDrainAfter: number,
): NativeTranslation | null {
  const anchors = state.anchors;
  if (anchors.length === 0) return null;
  let k = -1;
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    if (a && a.nativeS <= nativeS) k = i;
  }
  if (k < 0) {
    // Older than the first anchor: no lower bound exists; never usable.
    const a0 = anchors[0] as TimebaseAnchor;
    const t = a0.jsMid + 1000 * (nativeS - a0.nativeS);
    return { t, tLo: t - a0.u, tHi: a0.jsMid + a0.u, epoch: a0.epoch, tb: "indeterminate", tAlt: t };
  }
  const ak = anchors[k] as TimebaseAnchor;
  const t = ak.jsMid + 1000 * (nativeS - ak.nativeS);
  const next = anchors[k + 1];
  if (!next) {
    return { t, tLo: t - ak.u, tHi: Math.max(t - ak.u, jsDrainAfter), epoch: ak.epoch, tb: "postAnchor" };
  }
  // 7.5.4 holds whether or not a gap is declared: the declared interval is the
  // same; a GAP segment only makes the record INDETERMINATE and adds tAlt.
  const d = next.driftMs ?? 0;
  const tLo = t - ak.u;
  const tHi = t + Math.max(0, d) + 2 * ak.u + next.u;
  if (next.gap) {
    const tAlt = next.jsMid - 1000 * (next.nativeS - nativeS);
    return { t, tLo, tHi, epoch: ak.epoch, tb: "indeterminate", tAlt };
  }
  return { t, tLo, tHi, epoch: ak.epoch, tb: "ok" };
}

/**
 * 7.5.7: a JS-bounded window is SEQUENCE-VALID iff the accepted anchor at or
 * before startT and the accepted anchor at or after endT exist and share an
 * epoch. No bounding anchor on either side => never valid (no fallback).
 */
export function windowSequenceValid(state: TimebaseState, startT: number, endT: number): boolean {
  let before: TimebaseAnchor | null = null;
  let after: TimebaseAnchor | null = null;
  for (const a of state.anchors) {
    if (a.jsMid <= startT) before = a;
    if (after === null && a.jsMid >= endT) after = a;
  }
  if (before === null || after === null) return false;
  return before.epoch === after.epoch;
}

// ---------------------------------------------------------------------------
// Membership and ordering categories (section 10 head)
// ---------------------------------------------------------------------------

export type Membership = "in" | "out" | "indeterminate";

/** IN iff the whole interval lies inside, OUT iff wholly outside, else INDETERMINATE. */
export function windowMembership(e: TraceEntry, startT: number, endT: number): Membership {
  if (e.tb === "indeterminate") return "indeterminate";
  if (e.tLo >= startT && e.tHi <= endT) return "in";
  if (e.tHi < startT || e.tLo > endT) return "out";
  return "indeterminate";
}

/**
 * (T) TIMESTAMP-PROVED order: true when a is wholly before b, false when b is
 * wholly before a, null (I, INDETERMINATE) when the intervals overlap or touch
 * or either record is in a GAP segment.
 */
export function orderedBefore(a: TraceEntry, b: TraceEntry): boolean | null {
  if (a.tb === "indeterminate" || b.tb === "indeterminate") return null;
  if (a.tHi < b.tLo) return true;
  if (b.tHi < a.tLo) return false;
  return null;
}

export type WindowAbsence = "absent" | "present" | "indeterminate";

/**
 * Section 10 head: an absence claim (for example S7/S8 "no shouldPop in the
 * attempt window") is provable only when every matching record is OUT; any
 * matching record with INDETERMINATE membership fails the claim closed.
 */
export function windowAbsence(
  entries: TraceEntry[],
  startT: number,
  endT: number,
  matches: (e: TraceEntry) => boolean,
): WindowAbsence {
  let result: WindowAbsence = "absent";
  for (const e of entries) {
    if (!matches(e)) continue;
    const m = windowMembership(e, startT, endT);
    if (m === "in") return "present";
    if (m === "indeterminate") result = "indeterminate";
  }
  return result;
}

const CLOSING_KINDS: ReadonlySet<TraceEntryKind> = new Set([
  "diag.snapshot",
  "diag.timebase",
  "diag.swipe",
  "diag.jsBack",
  "diag.overflow",
]);

/**
 * Observation window [startT, endT] closed at boundarySeq (9.3 / 9.4): JS
 * records count by their exact time and only when written before the
 * boundary; native records count by interval membership (IN or
 * INDETERMINATE, never by their point estimate) whenever they were drained;
 * the probe's own closing records written after the boundary are appended.
 */
export function selectWindowEntries(
  entries: TraceEntry[],
  startT: number,
  endT: number,
  boundarySeq: number,
): { windowEntries: TraceEntry[]; appendixEntries: TraceEntry[] } {
  const all = sortEntries(entries);
  const windowEntries = all.filter((e) =>
    e.k.startsWith("native.")
      ? windowMembership(e, startT, endT) !== "out"
      : e.s <= boundarySeq && e.t >= startT && e.t <= endT,
  );
  const closingEntries = all.filter((e) => e.s > boundarySeq && CLOSING_KINDS.has(e.k));
  return { windowEntries, appendixEntries: sortEntries([...windowEntries, ...closingEntries]) };
}

// ---------------------------------------------------------------------------
// Native record shape (5.4 / 5.5 / 7.1)
// ---------------------------------------------------------------------------

export function nativeRecordKind(record: NativeRecord): TraceEntryKind {
  return record.kind === "headerUpdate" ? "native.headerUpdate" : "native.popDelegate";
}

export function nativeRecordDetail(record: NativeRecord): TraceDetail {
  if (record.kind === "headerUpdate") {
    return redactDetail({
      kind: record.kind,
      navId: record.navId,
      vcToken: record.vcToken,
      animated: record.animated,
    });
  }
  const base = {
    kind: record.kind,
    navId: record.navId,
    itemToken: record.itemToken,
    wrapperToken: record.wrapperToken,
    wrapperFound: record.wrapperFound,
    wrapperEnabledBefore: record.wrapperEnabledBefore,
    wrapperEnabledAfter: record.wrapperEnabledAfter,
  };
  return redactDetail(
    record.kind === "shouldPop"
      ? { ...base, coordinatorPresent: record.coordinatorPresent, result: record.result }
      : base,
  );
}

// ---------------------------------------------------------------------------
// Navigation-state helpers (F14b / 9.4 step 2 / 7.1 nav.state)
// ---------------------------------------------------------------------------

type RouteLike = { key: string; name: string; state?: unknown };
type StateLike = {
  key?: string;
  type?: string;
  index?: number;
  routeNames?: string[];
  routes?: RouteLike[];
};

function asState(value: unknown): StateLike | null {
  if (value === null || typeof value !== "object") return null;
  const s = value as StateLike;
  return Array.isArray(s.routes) ? s : null;
}

export type FocusedStack = {
  navKey: string;
  navName: string | null;
  index: number;
  routeKey: string | null;
  routesLen: number;
  routes: { name: string; key: string }[];
};

/**
 * Walks root -> focused leaf and returns the (app) native stack that hosts
 * recipe/[id] (the installed StackRouter whose `state.index` is the GO_BACK
 * discriminator, F14e). Falls back to the deepest stack on the focused path.
 */
export function findFocusedStack(rootState: unknown): FocusedStack | null {
  let state = asState(rootState);
  let hostName: string | null = null;
  let deepestStack: FocusedStack | null = null;
  let appStack: FocusedStack | null = null;
  while (state) {
    const routes = state.routes ?? [];
    const index = typeof state.index === "number" ? state.index : routes.length - 1;
    const summary: FocusedStack = {
      navKey: state.key ?? "",
      navName: hostName,
      index,
      routeKey: routes[index]?.key ?? null,
      routesLen: routes.length,
      routes: routes.map((r) => ({ name: r.name, key: r.key })),
    };
    if (state.type === "stack") {
      deepestStack = summary;
      if ((state.routeNames ?? []).includes("recipe/[id]")) appStack = summary;
    }
    const focused = routes[index];
    if (!focused) break;
    hostName = focused.name;
    state = asState(focused.state);
  }
  return appStack ?? deepestStack;
}

/** nav.state payload (7.1) for the focused app stack. */
export function summarizeState(rootState: unknown): TraceDetail {
  const stack = findFocusedStack(rootState);
  if (!stack) return { navKey: "", routes: [], index: -1, depth: 0 };
  return {
    navKey: stack.navKey,
    routes: stack.routes,
    index: stack.index,
    depth: stack.routesLen,
  };
}

/** Structural signature (keys + indices) used for the "final change" test. */
export function stateSignature(rootState: unknown): string {
  const walk = (value: unknown): unknown => {
    const s = asState(value);
    if (!s) return null;
    return {
      k: s.key ?? "",
      i: s.index ?? -1,
      r: (s.routes ?? []).map((r) => ({ k: r.key, s: walk(r.state) })),
    };
  };
  return JSON.stringify(walk(rootState));
}

// ---------------------------------------------------------------------------
// Persistence (8.2 / 8.3 / 8.5)
// ---------------------------------------------------------------------------

/** Writes JSON and verifies by read-back equality; never throws. */
export async function writeVerified(key: string, value: object): Promise<boolean> {
  const json = JSON.stringify(value);
  try {
    await AsyncStorage.setItem(key, json);
    const back = await AsyncStorage.getItem(key);
    return back === json;
  } catch {
    return false;
  }
}

export async function readStoredJson<T>(key: string): Promise<{ raw: string; value: T } | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    return { raw, value: JSON.parse(raw) as T };
  } catch {
    return null;
  }
}

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<CaptureRecord>;
  return (
    typeof v.header === "object" &&
    v.header !== null &&
    Array.isArray(v.entries) &&
    Array.isArray(v.appendices)
  );
}

/** Immutable capture key only (written by "Back dead" and its appendices). */
export async function persistCapture(record: CaptureRecord): Promise<boolean> {
  const ok = await writeVerified(NAV_CAPTURE_STORAGE_KEY, record);
  if (ok) store.setLastCapture(JSON.stringify(record), record);
  return ok;
}

/** Rolling trace key only (generic export, arm boundary, launch header). */
export async function persistTrace(record: TraceExport): Promise<boolean> {
  return writeVerified(NAV_TRACE_STORAGE_KEY, record);
}

/** 8.3: read the immutable capture into memory (raw string kept verbatim). */
export async function hydrateCapture(): Promise<CaptureRecord | null> {
  const stored = await readStoredJson<unknown>(NAV_CAPTURE_STORAGE_KEY);
  if (!stored || !isCaptureRecord(stored.value)) {
    store.setLastCapture(null, null);
    return null;
  }
  store.setLastCapture(stored.raw, stored.value);
  return stored.value;
}

export async function readTrace(): Promise<TraceExport | null> {
  const stored = await readStoredJson<TraceExport>(NAV_TRACE_STORAGE_KEY);
  return stored?.value ?? null;
}

/** Settings "Delete diagnostic data" (8.4): both keys. */
export async function deleteDiagnosticData(): Promise<{ captureRemoved: boolean; traceRemoved: boolean }> {
  const results = await Promise.allSettled([
    AsyncStorage.removeItem(NAV_CAPTURE_STORAGE_KEY),
    AsyncStorage.removeItem(NAV_TRACE_STORAGE_KEY),
  ]);
  const captureRemoved = results[0].status === "fulfilled";
  // In-memory state stays truthful: a capture still on disk stays exportable.
  if (captureRemoved) store.setLastCapture(null, null);
  return { captureRemoved, traceRemoved: results[1].status === "fulfilled" };
}

// ---------------------------------------------------------------------------
// Process-wide diagnostics store (8.1): the root owner registers its
// controller here; the pill, screens and Settings read status and call it.
// ---------------------------------------------------------------------------

export type VisitKind = "calibration" | "priming" | "trial";
export type Arm = "A" | "B" | "C" | "D";
export type Anchor = "A1" | "A2" | "A3" | "A4";
export type VisitMode = { kind: VisitKind; arm: Arm; cycle: number; anchor: Anchor };

export type DiagnosticsPhase =
  | "idle"
  | "capturing"
  | "captured"
  | "swipeWindow"
  | "swipeSaved"
  | "jsBackWindow"
  | "jsBackSaved"
  | "exporting";

export type DiagnosticsStatus = {
  /** Root initialisation (hydration + enable) finished for this launch. */
  initialised: boolean;
  probeLine: string;
  calibration: string;
  phase: DiagnosticsPhase;
  message: string;
  launchNo: number;
  visitNo: number;
  navId: string | null;
  visitMode: VisitMode;
  hasLastCapture: boolean;
  /** Text offered to Share after a save or export (8.4). */
  shareText: string | null;
};

export type DiagnosticsController = {
  backDead(): void;
  swipeNow(): void;
  jsBack(): void;
  calib(): void;
  headerCalib(): void;
  exportTrace(): void;
  armEnd(): void;
  exportLastFailure(): void;
  deleteData(): void;
  share(): void;
  setVisitMode(patch: Partial<VisitMode>): void;
};

const DEFAULT_VISIT_MODE: VisitMode = { kind: "calibration", arm: "A", cycle: 0, anchor: "A1" };

function defaultStatus(): DiagnosticsStatus {
  return {
    initialised: false,
    probeLine: "Probe: not enabled",
    calibration: "PENDING",
    phase: "idle",
    message: "",
    launchNo: 0,
    visitNo: 0,
    navId: null,
    visitMode: { ...DEFAULT_VISIT_MODE },
    hasLastCapture: false,
    shareText: null,
  };
}

type StoreState = {
  ring: TraceRing | null;
  status: DiagnosticsStatus;
  controller: DiagnosticsController | null;
  lastCaptureJson: string | null;
  lastCapture: CaptureRecord | null;
  optionsBuilt: number;
  visitCounter: number;
  headerCalib: ((active: boolean) => void) | null;
  listeners: Set<() => void>;
  recordListeners: Set<(entry: TraceEntry) => void>;
};

function freshState(): StoreState {
  return {
    ring: null,
    status: defaultStatus(),
    controller: null,
    lastCaptureJson: null,
    lastCapture: null,
    optionsBuilt: 0,
    visitCounter: 0,
    headerCalib: null,
    listeners: new Set(),
    recordListeners: new Set(),
  };
}

let state: StoreState = freshState();

function notify(): void {
  for (const listener of state.listeners) listener();
}

const store = {
  isEnabled: isNavDiagnosticsEnabled,

  hasRing(): boolean {
    return state.ring !== null;
  },

  /** The root-owned ring (allocated on first use while the flag is on). */
  getRing(): TraceRing {
    if (!state.ring) state.ring = new TraceRing(JS_RING_CAPACITY);
    return state.ring;
  },

  /** Flag-guarded record; no-op (no allocation) when diagnostics are off. */
  record(k: TraceEntryKind, d: TraceDetail): void {
    if (!isNavDiagnosticsEnabled()) return;
    const entry = store.getRing().push(k, d);
    if (entry === null) return;
    for (const listener of state.recordListeners) listener(entry);
  },

  /** F9 options-built counter, sampled only inside snapshots (7.1). */
  noteOptionsBuilt(): void {
    if (!isNavDiagnosticsEnabled()) return;
    state.optionsBuilt += 1;
  },

  getOptionsBuilt(): number {
    return state.optionsBuilt;
  },

  /** Flag-off: no listener is installed (the status is a static default). */
  subscribe(listener: () => void): () => void {
    if (!isNavDiagnosticsEnabled()) return () => undefined;
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  },

  /** Synchronous observer of every record (root calibration triggers). */
  subscribeRecords(listener: (entry: TraceEntry) => void): () => void {
    state.recordListeners.add(listener);
    return () => {
      state.recordListeners.delete(listener);
    };
  },

  getStatus(): DiagnosticsStatus {
    return state.status;
  },

  setStatus(patch: Partial<DiagnosticsStatus>): void {
    state.status = { ...state.status, ...patch };
    notify();
  },

  getController(): DiagnosticsController | null {
    return state.controller;
  },

  setController(controller: DiagnosticsController | null): void {
    state.controller = controller;
  },

  /**
   * Visit accounting (section 6): visit numbers are global per launch; a
   * trial visit also advances the arm's cycle counter.
   */
  beginVisit(): { launchNo: number; visitNo: number; visitMode: VisitMode } {
    state.visitCounter += 1;
    const visitNo = state.visitCounter;
    const mode = state.status.visitMode;
    const visitMode = mode.kind === "trial" ? { ...mode, cycle: mode.cycle + 1 } : mode;
    store.setStatus({ visitNo, visitMode });
    return { launchNo: state.status.launchNo, visitNo, visitMode };
  },

  /** 6 P5 (v11): the screen's header-calibration title setter (set = true, restore = false). */
  registerHeaderCalib(fn: ((active: boolean) => void) | null): void {
    state.headerCalib = fn;
  },

  getHeaderCalib(): ((active: boolean) => void) | null {
    return state.headerCalib;
  },

  setLastCapture(json: string | null, record: CaptureRecord | null): void {
    state.lastCaptureJson = json;
    state.lastCapture = record;
    store.setStatus({ hasLastCapture: json !== null });
  },

  getLastCaptureJson(): string | null {
    return state.lastCaptureJson;
  },

  getLastCapture(): CaptureRecord | null {
    return state.lastCapture;
  },

  resetForTests(): void {
    state = freshState();
  },
};

export const navDiagnostics = store;

// ---------------------------------------------------------------------------
// Pure evaluators
// ---------------------------------------------------------------------------

export type CalibrationInput = {
  entries: TraceEntry[];
  sOpen: ProbeSnapshot;
  sPre: ProbeSnapshot;
  sPost: ProbeSnapshot;
  navId: string;
  /** The calibration visit's routeKey (C1.trans); null fails closed. */
  routeKey: string | null;
  /** JS time of the evaluation drain (diag.mark "calibEval"). */
  evalT: number;
  /** 7.5.7 result for [diag.backAttempt.t, evalT] (C1.time). */
  sequenceValid: boolean;
  /** Sequence number of the S-post snapshot entry (O6); null fails closed. */
  sPostSeq: number | null;
};

export type CalibrationResult = {
  ok: boolean;
  /** First failing C1 sub-code (if any), then C3 and C4 (if failing). */
  failing: string[];
  /** Every failing C1 sub-code, in contract order. */
  c1Failing: string[];
  armToDelegateMs: number | null;
  /** didPop records on navId IN the window: telemetry, never a criterion. */
  didPopObserved: number;
};

const C1_SUBCODES = ["gate", "late", "trans", "pop", "depth", "count", "order", "time"] as const;

/**
 * Section 6, P4 (v10): C1 is a POSITIVE proof of a completed native pop over
 * the calibration window [diag.backAttempt.t, evalT], evaluated with the
 * section 10 head categories: (T) on intervals for cross-clock records, (X)
 * by sequence number for JS entries, (S) on the snapshots. C3 wrapper lookup
 * and C4 identity are unchanged. Only records after the most recent
 * diag.backAttempt are read; any missing element fails closed.
 */
export function evaluateCalibration(input: CalibrationInput): CalibrationResult {
  const { sOpen, sPre, sPost, navId, routeKey, evalT, sequenceValid, sPostSeq } = input;
  const entries = [...input.entries].sort((a, b) => a.s - b.s);
  const failing: string[] = [];

  const c3Ok = sOpen.contentViewFound && sOpen.wrapperFound && sPre.contentViewFound && sPre.wrapperFound;

  let attempt: TraceEntry | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e && e.k === "diag.backAttempt") {
      attempt = e;
      break;
    }
  }
  const startT = attempt ? attempt.t : Number.POSITIVE_INFINITY;
  const attemptSeq = attempt ? attempt.s : Number.POSITIVE_INFINITY;

  const isNative = (e: TraceEntry) => e.k === "native.popDelegate" || e.k === "native.headerUpdate";
  const inWindowNative = (e: TraceEntry) => windowMembership(e, startT, evalT);
  const pops = entries.filter((e) => e.k === "native.popDelegate" && inWindowNative(e) !== "out");
  const shouldPops = pops.filter((e) => e.d.kind === "shouldPop" && e.d.navId === navId);
  const yesIn = shouldPops.filter((e) => e.d.result === true && inWindowNative(e) === "in");
  const yesIndeterminate = shouldPops.some((e) => e.d.result === true && inWindowNative(e) === "indeterminate");
  const noRecord = shouldPops.some((e) => e.d.result === false);
  const shouldPop = yesIn.length === 1 ? (yesIn[0] as TraceEntry) : null;
  const didPopObserved = pops.filter(
    (e) => e.d.kind === "didPop" && e.d.navId === navId && inWindowNative(e) === "in",
  ).length;

  // JS entries after the attempt (X: sequence order) and not later than evalT.
  const jsAfter = entries.filter((e) => !isNative(e) && e.s > attemptSeq && e.t <= evalT);
  const transStarts = jsAfter.filter(
    (e) => e.k === "scr.transitionStart" && e.d.closing === true && routeKey !== null && e.d.routeKey === routeKey,
  );
  const transStart = transStarts[0] ?? null;
  const transEnd =
    transStart === null
      ? null
      : (jsAfter.find(
          (e) =>
            e.k === "scr.transitionEnd" &&
            e.d.closing === true &&
            e.d.routeKey === routeKey &&
            e.s > transStart.s,
        ) ?? null);
  const pop = jsAfter.find((e) => e.k === "nav.action" && e.d.type === "POP" && e.d.noop === false) ?? null;

  let depthBefore: number | null = null;
  for (const e of entries) {
    if (e.s >= attemptSeq) break;
    if (e.k === "nav.state" && typeof e.d.depth === "number") depthBefore = e.d.depth;
  }
  const depthState =
    depthBefore === null
      ? null
      : (jsAfter.find(
          (e) => e.k === "nav.state" && typeof e.d.depth === "number" && e.d.depth < depthBefore,
        ) ?? null);

  const checks: Record<(typeof C1_SUBCODES)[number], boolean> = {
    gate:
      attempt !== null &&
      shouldPop !== null &&
      !noRecord &&
      !yesIndeterminate &&
      shouldPop.d.wrapperFound === true &&
      shouldPop.d.wrapperEnabledBefore === true &&
      shouldPop.d.wrapperEnabledAfter === false,
    late: shouldPop !== null && shouldPop.tHi <= startT + BACK_DEAD_MAX_ANCHOR_MS,
    trans: transStart !== null && transEnd !== null,
    pop: pop !== null,
    depth: depthState !== null,
    count:
      sPost.vcCount === sPre.vcCount - 1 &&
      !sPost.coordinatorPresent &&
      sOpen.navId === navId &&
      sPre.navId === navId &&
      sPost.navId === navId,
    order:
      // O1 (T): the shouldPop interval lies strictly after the arm instant.
      shouldPop !== null &&
      shouldPop.tLo > startT &&
      // O2 (K) pairing: exactly one closing transitionStart of the routeKey.
      transStarts.length === 1 &&
      transStart !== null &&
      // O3 (X) is transEnd.s > transStart.s by construction above.
      transEnd !== null &&
      // O4 (X): transitionStart before POP; O5 (X): POP before the depth decrease.
      pop !== null &&
      transStart.s < pop.s &&
      depthState !== null &&
      pop.s < depthState.s &&
      // O6 (X): the depth decrease at or before S-post.
      sPostSeq !== null &&
      depthState.s <= sPostSeq,
    time: sequenceValid,
  };
  const c1Failing = C1_SUBCODES.filter((code) => !checks[code]).map((code) => `C1.${code}`);
  const firstC1 = c1Failing[0];
  if (firstC1 !== undefined) failing.push(firstC1);
  if (!c3Ok) failing.push("C3");

  const ids = [sOpen.navId, sPre.navId, sPost.navId, ...pops.map((e) => e.d.navId)];
  if (ids.some((id) => id !== navId)) failing.push("C4");

  const armToDelegateMs = shouldPop !== null && attempt !== null ? shouldPop.t - attempt.t : null;

  return { ok: failing.length === 0, failing, c1Failing, armToDelegateMs, didPopObserved };
}

export type SwipeOutcome = "popped" | "cancelled" | "noEvent";

/** 9.3: outcome from controller-count change and transition records. */
export function computeSwipeOutcome(input: {
  windowEntries: TraceEntry[];
  pre: ProbeSnapshot | null;
  late: ProbeSnapshot | null;
}): SwipeOutcome {
  const { windowEntries, pre, late } = input;
  const popped =
    (pre !== null && late !== null && late.vcCount < pre.vcCount) ||
    windowEntries.some((e) => e.k === "scr.transitionEnd" && e.d.closing === true);
  if (popped) return "popped";
  const cancelled = windowEntries.some(
    (e) =>
      e.k === "scr.gestureCancel" ||
      (e.k === "scr.transitionStart" && e.d.closing === true),
  );
  return cancelled ? "cancelled" : "noEvent";
}

export type JsBackRow = "Q5e" | "INVALID" | "A" | "F1" | "F2" | "F3" | "B" | "G" | "C" | "D";

export type JsBackObservation = {
  dispatchError: boolean;
  actionEvent: { noop: boolean } | null;
  stateEventCount: number;
  finalChange: boolean;
  nativePopped: boolean;
  indexPre: number;
};

/**
 * Section 10, Phase 3 GO_BACK rows, precedence Q5e, A, F, B, G, C, D
 * (INVALID for an uninterpretable pre-dispatch index).
 * Evaluated only at jsBack3000 over the whole window; a qualifier, never a
 * relabel of the Phase 2 dead state.
 */
export function classifyJsBack(o: JsBackObservation): JsBackRow {
  if (o.dispatchError) return "Q5e";
  // The matrix defines indexPre only as 0 or > 0 (F14e). A missing focused
  // stack or a non-integer index is an observation the authority cannot
  // interpret and is labelled INVALID, never forced into C or D.
  if (!Number.isInteger(o.indexPre) || o.indexPre < 0) return "INVALID";
  if (o.actionEvent !== null) {
    if (!o.actionEvent.noop) {
      if (o.nativePopped) return "A";
      if (o.finalChange) return "F1";
      if (o.stateEventCount > 0) return "F2";
      return "F3";
    }
    return "B";
  }
  if (o.stateEventCount > 0 || o.finalChange || o.nativePopped) return "G";
  return o.indexPre === 0 ? "C" : "D";
}
