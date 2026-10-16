/**
 * Build 5 Class B diagnostic (docs/build5-classb-native-back-diagnostic-plan.md
 * section 4.D.16): trace core unit coverage. Ring, capacity, overflow flag,
 * redaction, native merge, immutable-capture vs rolling persistence, hydration
 * after a simulated root reconstruction (fresh module instance), the v10
 * timebase contract (section 7.5: anchors, drift, intervals, epochs, window
 * validity, membership and ordering), the 9.0a arm gate on the ring, the
 * jsClockProvider guard, and the pure evaluators the root owner relies on
 * (calibration C1 sub-codes / C3 / C4, swipe outcome, Phase 3 GO_BACK
 * partition).
 */

// Shared storage map that survives jest.isolateModules: a fresh module
// registry re-instantiates the async-storage mock, which would otherwise
// lose everything written by the previous "process".
const sharedStorage: Map<string, string> =
  ((globalThis as { __navTraceTestStorage?: Map<string, string> })
    .__navTraceTestStorage ??= new Map());

jest.mock("@react-native-async-storage/async-storage", () => {
  // Resolved lazily: the factory runs during hoisted imports, before the
  // sharedStorage binding above has been initialised.
  const store = () =>
    ((globalThis as { __navTraceTestStorage?: Map<string, string> })
      .__navTraceTestStorage ??= new Map());
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store().get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store().set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store().delete(key);
      }),
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  BACK_DEAD_MAX_ANCHOR_MS,
  JS_RING_CAPACITY,
  NATIVE_RING_CAPACITY,
  NAV_CAPTURE_STORAGE_KEY,
  NAV_TRACE_STORAGE_KEY,
  OPEN_SETTLE_MS,
  TraceRing,
  U_MAX_MS,
  W_MAX_MS,
  acceptAnchor,
  classifyJsBack,
  computeSwipeOutcome,
  createTimebase,
  deleteDiagnosticData,
  epochCount,
  evaluateCalibration,
  hydrateCapture,
  isNavDiagnosticsEnabled,
  jsClockProvider,
  navDiagnostics,
  orderedBefore,
  persistCapture,
  persistTrace,
  redactDetail,
  selectWindowEntries,
  translateNative,
  windowAbsence,
  windowMembership,
  windowSequenceValid,
  writeVerified,
  type CaptureRecord,
  type EntryTimebase,
  type JsBackObservation,
  type ProbeSnapshot,
  type TimebaseState,
  type TraceEntry,
  type TraceHeader,
} from "../../../lib/diagnostics/navTrace";

const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function header(overrides: Partial<TraceHeader> = {}): TraceHeader {
  return {
    sessionToken: "sess-1",
    launchNo: 1,
    wallStart: "2026-09-02T00:00:00.000Z",
    appVersion: "1.0.0",
    appBuild: "6",
    iosVersion: "26.6",
    deviceModel: "iPhone14,2",
    flag: "1",
    probeStatus: null,
    calibrationStatus: "PENDING",
    c2PassedSession: false,
    c1DidPopObserved: null,
    jsClockProvider: "steady",
    timebaseAnchors: 0,
    timebaseGaps: 0,
    epochCount: 0,
    attemptWindowSequenceValid: null,
    escapeWindowsSequenceValid: { swipe: null, jsBack: null },
    jsRingCapacity: JS_RING_CAPACITY,
    nativeRingCapacity: NATIVE_RING_CAPACITY,
    jsOverflow: 0,
    nativeOverflow: 0,
    c2SetLatencyMs: null,
    c2RestoreLatencyMs: null,
    calibAttempts1: 0,
    calibAttempts2: 0,
    postP5SamplePassed: null,
    ...overrides,
  };
}

function snap(overrides: Partial<ProbeSnapshot> = {}): ProbeSnapshot {
  return {
    navId: "0xa",
    vcCount: 2,
    topVCClass: "RNSScreen",
    topIsBeingDismissed: false,
    coordinatorPresent: false,
    coordinatorInteractive: false,
    coordinatorCancelled: false,
    navBarEnabled: true,
    windowEnabled: true,
    contentViewFound: true,
    wrapperFound: true,
    wrapperClass: "_UIButtonBarButton",
    wrapperToken: "0x1",
    wrapperEnabled: true,
    wrapperSuperEnabled: true,
    hidesBackButton: false,
    leftItemPresent: false,
    rightItemPresent: true,
    titleViewPresent: false,
    presentedVCClass: null,
    popGestureState: 0,
    contentPopGestureState: 0,
    nativeTimeS: 10,
    ...overrides,
  };
}

/** A JS-clock entry (7.1): tLo = tHi = t. */
function entry(
  s: number,
  t: number,
  k: TraceEntry["k"],
  d: TraceEntry["d"] = {},
): TraceEntry {
  return { s, t, k, d, tLo: t, tHi: t };
}

/** A translated native record or snapshot with its declared 7.5 interval. */
function nativeEntry(
  s: number,
  t: number,
  k: TraceEntry["k"],
  d: TraceEntry["d"],
  tb: Partial<EntryTimebase> = {},
): TraceEntry {
  return { s, t, k, d, tLo: t, tHi: t, epoch: 0, tb: "ok", ...tb };
}

/** Anchor sample with symmetric bracket [jsMid - u, jsMid + u]. */
function sample(source: string, jsMid: number, u: number, nativeS: number) {
  return { source, jsBefore: jsMid - u, jsAfter: jsMid + u, nativeS };
}

function timebaseWith(...samples: { source: string; jsBefore: number; jsAfter: number; nativeS: number }[]): TimebaseState {
  const tb = createTimebase();
  for (const sm of samples) acceptAnchor(tb, sm);
  return tb;
}

beforeEach(() => {
  sharedStorage.clear();
  jest.clearAllMocks();
  navDiagnostics.resetForTests();
});

describe("flag gating", () => {
  it("is disabled by default and record() never allocates a ring", () => {
    expect(isNavDiagnosticsEnabled()).toBe(false);
    navDiagnostics.record("ui.rowPress", { recipeId: UUID });
    expect(navDiagnostics.hasRing()).toBe(false);
  });

  it("subscribe() installs no listener while the flag is off", () => {
    const listener = jest.fn();
    const unsubscribe = navDiagnostics.subscribe(listener);
    navDiagnostics.setStatus({ message: "x" });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("TraceRing", () => {
  it("assigns monotonic seq and preserves insertion order", () => {
    const ring = new TraceRing(8);
    const a = ring.push("ui.rowPress", { recipeId: UUID }, 5);
    const b = ring.push("guard", { locked: true }, 6);
    expect(a.s).toBe(1);
    expect(b.s).toBe(2);
    expect(ring.entries().map((e) => e.k)).toEqual(["ui.rowPress", "guard"]);
    expect(ring.entries()[0]?.t).toBe(5);
  });

  it("overwrites the oldest entry on overflow and counts the overflow", () => {
    const ring = new TraceRing(3);
    for (let i = 1; i <= 5; i += 1) {
      ring.push("guard", { locked: i % 2 === 0 }, i);
    }
    expect(ring.size()).toBe(3);
    expect(ring.overflow).toBe(2);
    expect(ring.entries().map((e) => e.s)).toEqual([3, 4, 5]);
    ring.reset();
    expect(ring.size()).toBe(0);
    expect(ring.overflow).toBe(0);
  });

  it("exposes the contract capacities", () => {
    expect(JS_RING_CAPACITY).toBe(4096);
    expect(NATIVE_RING_CAPACITY).toBe(2048);
  });

  it("redacts free text pushed through the ring", () => {
    const ring = new TraceRing(4);
    const e = ring.push("toast.show", { message: "Added 5 items to Weekly" }, 1);
    expect(e?.d.message).toBe("[redacted]");
  });

  it("stamps JS entries with tLo = tHi = t and carries a supplied 7.5 interval verbatim", () => {
    const ring = new TraceRing(4);
    const js = ring.push("guard", { locked: true }, 42);
    expect(js).toMatchObject({ t: 42, tLo: 42, tHi: 42 });
    expect(js?.tb).toBeUndefined();
    const native = ring.push(
      "native.popDelegate",
      { kind: "shouldPop" },
      600,
      { tLo: 500, tHi: 900, epoch: 2, tb: "ok" },
    );
    expect(native).toMatchObject({ t: 600, tLo: 500, tHi: 900, epoch: 2, tb: "ok" });
    const gap = ring.push(
      "native.popDelegate",
      { kind: "shouldPop" },
      5000,
      { tLo: 4900, tHi: 693_600, epoch: 0, tb: "indeterminate", tAlt: 693_500 },
    );
    expect(gap).toMatchObject({ tb: "indeterminate", tAlt: 693_500 });
  });

  it("consults the arm gate ONLY for diag.backAttempt and writes nothing when refused (9.0a)", () => {
    const ring = new TraceRing(8);
    const gate = jest.fn(() => false);
    ring.setArmGate(gate);
    const refused = ring.push("diag.backAttempt", { launchNo: 1, visitNo: 1 }, 10);
    expect(refused).toBeNull();
    expect(ring.size()).toBe(0);
    expect(ring.lastSeq()).toBe(0);
    expect(gate).toHaveBeenCalledTimes(1);
    const other = ring.push("guard", { locked: false }, 11);
    expect(other?.s).toBe(1);
    expect(gate).toHaveBeenCalledTimes(1);
    gate.mockReturnValue(true);
    const accepted = ring.push("diag.backAttempt", { launchNo: 1, visitNo: 1 }, 12);
    expect(accepted?.s).toBe(2);
    expect(ring.entries().map((e) => e.k)).toEqual(["guard", "diag.backAttempt"]);
    ring.setArmGate(null);
    expect(ring.push("diag.backAttempt", { launchNo: 1, visitNo: 1 }, 13)?.s).toBe(3);
  });
});

describe("jsClockProvider guard (7.5.1)", () => {
  it("reports steady for a performance.now of process-relative magnitude", () => {
    // react-native's Jest preset stands performance.now in with Date.now;
    // the device clock (RN 0.81 NativePerformance, 7.5.1) is process-relative.
    const spy = jest.spyOn(performance, "now").mockReturnValue(12_345.678);
    try {
      expect(jsClockProvider()).toBe("steady");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports wall when the clock is of wall-clock magnitude (fails closed)", () => {
    const spy = jest.spyOn(performance, "now").mockReturnValue(1.7e12);
    try {
      expect(jsClockProvider()).toBe("wall");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("redactDetail", () => {
  it("keeps ids, route names, route keys, tokens, counts and booleans", () => {
    const out = redactDetail({
      recipeId: UUID,
      routeKey: "recipe/[id]-abc123",
      routes: [{ name: "recipe/[id]", key: "recipe/[id]-abc123" }],
      wrapperToken: "0x10ab3f2c0",
      count: 3,
      ok: true,
      nil: null,
    });
    expect(out).toEqual({
      recipeId: UUID,
      routeKey: "recipe/[id]-abc123",
      routes: [{ name: "recipe/[id]", key: "recipe/[id]-abc123" }],
      wrapperToken: "0x10ab3f2c0",
      count: 3,
      ok: true,
      nil: null,
    });
  });

  it("replaces strings containing whitespace, over-long strings and nested text", () => {
    const out = redactDetail({
      title: "Pasta Carbonara",
      long: "x".repeat(97),
      nested: { text: "hello world", mode: "auto" },
      paths: ["ok", "not ok"],
    });
    expect(out).toEqual({
      title: "[redacted]",
      long: "[redacted]",
      nested: { text: "[redacted]", mode: "auto" },
      paths: ["[redacted]", "[redacted]"],
    });
  });

  it("redacts single-token free text, non-UUID ids and user identifiers (per-key allowlist)", () => {
    const out = redactDetail({
      title: "Carbonara",
      ingredient: "spaghetti",
      listName: "Weekly",
      user: "user-123",
      recipeId: "recipe-1",
      listId: UUID,
      navId: "0xa",
      badNav: "0xzz",
      routeKey: "recipe/[id]-k1",
      topVCClass: "RNSScreen",
      reason: "dead0",
      outcome: "F1",
      phase: "Not a phase",
      label: "Carbonara",
      invalidReason: "focusedStackMissing",
      arm: "Z",
    });
    expect(out).toEqual({
      title: "[redacted]",
      ingredient: "[redacted]",
      listName: "[redacted]",
      user: "[redacted]",
      recipeId: "[redacted]",
      listId: UUID,
      navId: "0xa",
      badNav: "[redacted]",
      routeKey: "recipe/[id]-k1",
      topVCClass: "RNSScreen",
      reason: "dead0",
      outcome: "F1",
      phase: "[redacted]",
      label: "[redacted]",
      invalidReason: "focusedStackMissing",
      arm: "[redacted]",
    });
  });

  it("accepts the v11 header-calibration vocabulary (label, reasons, phases) and redacts the rest", () => {
    expect(
      redactDetail({
        label: "headerCalibEval",
        phase: "set",
        reason: "headerCalibEval",
        stale: false,
        hit: true,
        latencyMs: 12.5,
      }),
    ).toEqual({ label: "headerCalibEval", phase: "set", reason: "headerCalibEval", stale: false, hit: true, latencyMs: 12.5 });
    expect(redactDetail({ phase: "restore", reason: "headerCalibPre" })).toEqual({ phase: "restore", reason: "headerCalibPre" });
    expect(redactDetail({ reason: "headerCalib" })).toEqual({ reason: "headerCalib" });
    expect(redactDetail({ reason: "notCalibrated" })).toEqual({ reason: "notCalibrated" });
    expect(redactDetail({ label: "headerCalibSet", phase: "setting" })).toEqual({ label: "[redacted]", phase: "[redacted]" });
  });

  it("registers a header-calibration setter that receives the active flag", () => {
    const calls: boolean[] = [];
    navDiagnostics.registerHeaderCalib((active) => {
      calls.push(active);
    });
    navDiagnostics.getHeaderCalib()?.(true);
    navDiagnostics.getHeaderCalib()?.(false);
    expect(calls).toEqual([true, false]);
    navDiagnostics.registerHeaderCalib(null);
    expect(navDiagnostics.getHeaderCalib()).toBeNull();
  });

  it("enumeration keys accept only their fixed vocabulary", () => {
    expect(redactDetail({ phase: "Carbonara", mode: "spaghetti", path: "Weekly" })).toEqual({
      phase: "[redacted]",
      mode: "[redacted]",
      path: "[redacted]",
    });
    expect(
      redactDetail({ phase: "saved", mode: "sheet", path: "sheetCancel", type: "GO_BACK", visitKind: "trial" }),
    ).toEqual({ phase: "saved", mode: "sheet", path: "sheetCancel", type: "GO_BACK", visitKind: "trial" });
  });

  it("drops unsupported value types instead of serialising them", () => {
    const out = redactDetail({ fn: () => 1, sym: Symbol("s"), n: 1 });
    expect(out).toEqual({ n: 1 });
  });
});

describe("timebase contract (7.5)", () => {
  it("exposes the contract bounds", () => {
    expect(U_MAX_MS).toBe(100);
    expect(W_MAX_MS).toBe(600);
    expect(OPEN_SETTLE_MS).toBe(500);
  });

  it("accepts an anchor at u = 100 and rejects u > 100, recording the rejection", () => {
    const tb = createTimebase();
    const ok = acceptAnchor(tb, sample("enable", 100, 100, 10));
    expect(ok.accepted).toBe(true);
    expect(ok.detail).toMatchObject({ source: "enable", epoch: 0, u: 100, roundTripMs: 200, gap: false, rejected: false, driftMs: null });
    const bad = acceptAnchor(tb, sample("calibOpen", 1000, 101, 11));
    expect(bad.accepted).toBe(false);
    expect(bad.anchor).toBeNull();
    expect(bad.detail).toMatchObject({ source: "calibOpen", rejected: true, u: 101 });
    expect(tb.anchors).toHaveLength(1);
    expect(tb.rejected).toBe(1);
  });

  it("computes the record interval at u = 100 (7.5.4) inside a usable segment", () => {
    // A0: jsMid 100, u 100, native 10 s; A1: jsMid 1100, u 100, native 11 s => D = 0.
    const tb = timebaseWith(sample("enable", 100, 100, 10), sample("calibOpen", 1100, 100, 11));
    expect(tb.anchors[1]).toMatchObject({ driftMs: 0, widthSegMs: 400, gap: false, epoch: 0 });
    const r = translateNative(tb, 10.5, 2000);
    expect(r).toEqual({ t: 600, tLo: 500, tHi: 900, epoch: 0, tb: "ok" });
  });

  it("keeps a segment usable at width_seg = W_MAX and declares a GAP at W_MAX + 1 (u = 0)", () => {
    const usable = timebaseWith(sample("enable", 0, 0, 10), sample("s", 1000 + 600, 0, 11));
    expect(usable.anchors[1]).toMatchObject({ driftMs: 600, widthSegMs: 600, gap: false, epoch: 0 });
    expect(usable.gaps).toBe(0);
    expect(translateNative(usable, 10.5, 5000)?.tb).toBe("ok");

    const gapped = timebaseWith(sample("enable", 0, 0, 10), sample("s", 1000 + 601, 0, 11));
    expect(gapped.anchors[1]).toMatchObject({ driftMs: 601, widthSegMs: 601, gap: true, epoch: 1 });
    expect(gapped.gaps).toBe(1);
    expect(epochCount(gapped)).toBe(2);
    expect(translateNative(gapped, 10.5, 5000)?.tb).toBe("indeterminate");
  });

  it("declares no false gap at S = 0 with two 200 ms anchors, across the whole +-C error band", () => {
    for (const jsMidError of [-200, -100, 0, 100, 200]) {
      const tb = timebaseWith(sample("enable", 100, 100, 10), sample("s", 1100 + jsMidError, 100, 11));
      expect(tb.anchors[1]?.gap).toBe(false);
      expect(tb.gaps).toBe(0);
    }
  });

  it("always detects a sleep of 601 ms at u = 0 (7.5.5 detection guarantee)", () => {
    const tb = timebaseWith(sample("enable", 0, 0, 10), sample("wake", 1000 + 601, 0, 11));
    expect(tb.anchors[1]?.gap).toBe(true);
    expect(translateNative(tb, 10.2, 5000)?.tb).toBe("indeterminate");
  });

  it("may leave a 400 ms sleep undetected but keeps the true time inside the declared interval", () => {
    const tb = timebaseWith(sample("enable", 0, 0, 10), sample("s", 1400, 0, 11));
    expect(tb.anchors[1]?.gap).toBe(false);
    const r = translateNative(tb, 10.5, 5000);
    expect(r).toEqual({ t: 500, tLo: 500, tHi: 900, epoch: 0, tb: "ok" });
    // The sleep happened either before the record (true JS time 900) or after it (500).
    for (const trueT of [500, 900]) {
      expect(trueT).toBeGreaterThanOrEqual(r?.tLo ?? Infinity);
      expect(trueT).toBeLessThanOrEqual(r?.tHi ?? -Infinity);
    }
  });

  it("turns the Build 6 688 s lock fixture into an INDETERMINATE record and a sequence-invalid window (7.5.8)", () => {
    const tb = timebaseWith(sample("export", 0, 10, 100), sample("export", 700_000, 10, 111.5));
    expect(tb.anchors[1]).toMatchObject({ driftMs: 688_500, gap: true, epoch: 1 });
    const r = translateNative(tb, 105, 800_000);
    // 7.5.4 holds whether or not a gap is declared: [t - u_k, t + max(0,D) + 2u_k + u_k+1].
    expect(r).toEqual({ t: 5000, tLo: 4990, tHi: 693_530, epoch: 0, tb: "indeterminate", tAlt: 693_500 });
    // The true JS time lies in [t, t + D] (sleep before or after the record) and inside the interval.
    for (const trueT of [5000, 693_500]) {
      expect(trueT).toBeGreaterThanOrEqual(r?.tLo ?? Infinity);
      expect(trueT).toBeLessThanOrEqual(r?.tHi ?? -Infinity);
    }
    const e = nativeEntry(9, r?.t ?? 0, "native.popDelegate", { kind: "shouldPop" }, r ?? {});
    expect(windowMembership(e, 4000, 6000)).toBe("indeterminate");
    expect(windowMembership(e, 0, 800_000)).toBe("indeterminate");
    expect(windowSequenceValid(tb, 1000, 700_000)).toBe(false);
  });

  it("gives post-anchor records the [t - u_k, jsDrainAfter] interval (7.5.6)", () => {
    const tb = timebaseWith(sample("enable", 100, 10, 10));
    expect(translateNative(tb, 10.5, 900)).toEqual({ t: 600, tLo: 590, tHi: 900, epoch: 0, tb: "postAnchor" });
  });

  it("labels a record older than the first anchor INDETERMINATE and returns null with no anchor", () => {
    const tb = timebaseWith(sample("enable", 1000, 10, 10));
    expect(translateNative(tb, 9.5, 2000)?.tb).toBe("indeterminate");
    expect(translateNative(createTimebase(), 9.5, 2000)).toBeNull();
  });

  it("judges window sequence validity on the bounding anchors' epochs (7.5.7)", () => {
    const same = timebaseWith(sample("a", 0, 0, 10), sample("b", 5000, 0, 15));
    expect(windowSequenceValid(same, 1000, 3000)).toBe(true);
    expect(windowSequenceValid(same, 1000, 5000)).toBe(true);
    // No accepted anchor at or after endT: never valid through fallback (7.5.7).
    expect(windowSequenceValid(same, 1000, 9000)).toBe(false);
    expect(windowSequenceValid(same, 1000, 5001)).toBe(false);
    // No accepted anchor at or before startT: fail closed.
    expect(windowSequenceValid(same, -1, 3000)).toBe(false);
    expect(windowSequenceValid(createTimebase(), 0, 1)).toBe(false);
    // Epoch 0: a; epoch 1: wake (700 ms sleep) and b (no further drift).
    const split = timebaseWith(sample("a", 0, 0, 10), sample("wake", 5000 + 700, 0, 15), sample("b", 9000, 0, 18.3));
    expect(windowSequenceValid(split, 1000, 3000)).toBe(false);
    expect(windowSequenceValid(split, 1000, 9000)).toBe(false);
    expect(windowSequenceValid(split, 6000, 8000)).toBe(true);
    expect(windowSequenceValid(split, 6000, 9001)).toBe(false);
  });
});

describe("membership and ordering (section 10 head)", () => {
  const window = { startT: 1000, endT: 3000 };

  it("classifies IN / OUT / INDETERMINATE on the whole interval", () => {
    const inside = nativeEntry(1, 1500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1400, tHi: 1700 });
    const before = nativeEntry(2, 500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 400, tHi: 900 });
    const after = nativeEntry(3, 3500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 3001, tHi: 3600 });
    expect(windowMembership(inside, window.startT, window.endT)).toBe("in");
    expect(windowMembership(before, window.startT, window.endT)).toBe("out");
    expect(windowMembership(after, window.startT, window.endT)).toBe("out");
  });

  it("makes a shouldPop straddling the window boundary INDETERMINATE so S7/S8 absence claims fail closed", () => {
    const straddleStart = nativeEntry(1, 1000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 950, tHi: 1050 });
    const straddleEnd = nativeEntry(2, 3000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 2900, tHi: 3100 });
    expect(windowMembership(straddleStart, window.startT, window.endT)).toBe("indeterminate");
    expect(windowMembership(straddleEnd, window.startT, window.endT)).toBe("indeterminate");
    const gapRecord = nativeEntry(3, 2000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1900, tHi: 2100, tb: "indeterminate", tAlt: 9000 });
    expect(windowMembership(gapRecord, window.startT, window.endT)).toBe("indeterminate");
    expect(windowMembership(gapRecord, 0, 10_000)).toBe("indeterminate");
  });

  it("treats a JS entry as an exact point", () => {
    expect(windowMembership(entry(1, 1000, "diag.backAttempt"), 1000, 3000)).toBe("in");
    expect(windowMembership(entry(1, 3000, "diag.mark"), 1000, 3000)).toBe("in");
    expect(windowMembership(entry(1, 3001, "diag.mark"), 1000, 3000)).toBe("out");
  });

  it("orders on intervals (T): resolved, reversed, or overlapping => indeterminate (null)", () => {
    const attempt = entry(1, 1000, "diag.backAttempt");
    const later = nativeEntry(2, 1200, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1100, tHi: 1300 });
    const overlap = nativeEntry(3, 1050, "native.popDelegate", { kind: "shouldPop" }, { tLo: 950, tHi: 1150 });
    const touching = nativeEntry(4, 1000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1000, tHi: 1100 });
    expect(orderedBefore(attempt, later)).toBe(true);
    expect(orderedBefore(later, attempt)).toBe(false);
    expect(orderedBefore(attempt, overlap)).toBeNull();
    expect(orderedBefore(attempt, touching)).toBeNull();
    const gap = nativeEntry(5, 5000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 4000, tHi: 6000, tb: "indeterminate", tAlt: 6000 });
    expect(orderedBefore(attempt, gap)).toBeNull();
  });

  it("never proves a shouldPop absence claim (S7/S8) from a straddling or GAP record", () => {
    const isShouldPop = (e: TraceEntry) => e.k === "native.popDelegate" && e.d.kind === "shouldPop";
    const none = [entry(1, 1500, "diag.mark", { label: "backDead" })];
    expect(windowAbsence(none, window.startT, window.endT, isShouldPop)).toBe("absent");
    const outside = [nativeEntry(2, 500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 400, tHi: 900 })];
    expect(windowAbsence(outside, window.startT, window.endT, isShouldPop)).toBe("absent");
    const inside = [nativeEntry(3, 1500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1400, tHi: 1700 })];
    expect(windowAbsence(inside, window.startT, window.endT, isShouldPop)).toBe("present");
    const straddling = [nativeEntry(4, 1000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 950, tHi: 1050 })];
    expect(windowAbsence(straddling, window.startT, window.endT, isShouldPop)).toBe("indeterminate");
    const gap = [nativeEntry(5, 2000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1900, tHi: 2100, tb: "indeterminate", tAlt: 9000 })];
    expect(windowAbsence(gap, window.startT, window.endT, isShouldPop)).toBe("indeterminate");
    // A present record wins over an indeterminate one; an indeterminate one blocks "absent".
    expect(windowAbsence([...straddling, ...inside], window.startT, window.endT, isShouldPop)).toBe("present");
    expect(windowAbsence([...straddling, ...outside], window.startT, window.endT, isShouldPop)).toBe("indeterminate");
  });

  it("selects observation-window entries by exact t for JS records and by interval membership for native records", () => {
    const boundarySeq = 10;
    const all: TraceEntry[] = [
      entry(1, 999, "scr.gestureCancel", { routeKey: "r" }),
      entry(2, 1000, "diag.swipe", { phase: "start" }),
      entry(3, 2000, "scr.transitionEnd", { routeKey: "r", closing: true }),
      // Pre-boundary native record straddling the window start: context, never dropped by its point t.
      nativeEntry(4, 990, "native.popDelegate", { kind: "shouldPop" }, { tLo: 950, tHi: 1050 }),
      // Pre-boundary native record wholly outside.
      nativeEntry(5, 500, "native.headerUpdate", { kind: "headerUpdate" }, { tLo: 400, tHi: 600 }),
      // Pre-boundary native record whose point t is inside but whose interval straddles the end.
      nativeEntry(6, 2990, "native.popDelegate", { kind: "shouldPop" }, { tLo: 2900, tHi: 3100 }),
      // Post-boundary JS record inside the time window: excluded (window closed by sequence).
      entry(11, 2500, "nav.action", { type: "GO_BACK", noop: false }),
      // Post-boundary native records: by interval.
      nativeEntry(12, 1500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 1400, tHi: 1700 }),
      nativeEntry(13, 3500, "native.popDelegate", { kind: "shouldPop" }, { tLo: 3400, tHi: 3600 }),
      nativeEntry(14, 3000, "native.popDelegate", { kind: "shouldPop" }, { tLo: 2950, tHi: 3050, tb: "indeterminate", tAlt: 9000 }),
      // Closing records after the boundary.
      entry(15, 3001, "diag.snapshot", { reason: "swipe3000" }),
      entry(16, 3002, "diag.timebase", { source: "swipe3000" }),
      entry(17, 3003, "diag.swipe", { phase: "end", outcome: "noEvent" }),
      entry(18, 3004, "guard", { locked: false }),
    ];
    const { windowEntries, appendixEntries } = selectWindowEntries(all, 1000, 3000, boundarySeq);
    // Timebase order (t, then seq): 990, 1000, 1500, 2000, 2990, 3000.
    expect(windowEntries.map((e) => e.s)).toEqual([4, 2, 12, 3, 6, 14]);
    expect(appendixEntries.map((e) => e.s)).toEqual([4, 2, 12, 3, 6, 14, 15, 16, 17]);
  });
});

describe("persistence", () => {
  const capture: CaptureRecord = {
    header: header(),
    capturedAt: "2026-09-02T00:00:01.000Z",
    entries: [entry(1, 1, "diag.mark", { label: "backDead" })],
    appendices: [],
  };

  it("persistCapture writes only the immutable capture key", async () => {
    await expect(persistCapture(capture)).resolves.toBe(true);
    expect(sharedStorage.has(NAV_CAPTURE_STORAGE_KEY)).toBe(true);
    expect(sharedStorage.has(NAV_TRACE_STORAGE_KEY)).toBe(false);
  });

  it("persistTrace writes only the rolling key and never touches the capture", async () => {
    await persistCapture(capture);
    const captured = sharedStorage.get(NAV_CAPTURE_STORAGE_KEY);
    await expect(
      persistTrace({ header: header(), entries: [entry(1, 2, "guard", { locked: false })] }),
    ).resolves.toBe(true);
    expect(sharedStorage.get(NAV_CAPTURE_STORAGE_KEY)).toBe(captured);
    expect(sharedStorage.has(NAV_TRACE_STORAGE_KEY)).toBe(true);
  });

  it("writeVerified reports a failed read-back", async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce("{\"tampered\":true}");
    await expect(writeVerified("k", { a: 1 })).resolves.toBe(false);
  });

  it("writeVerified reports a rejected write instead of throwing", async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("disk"));
    await expect(writeVerified("k", { a: 1 })).resolves.toBe(false);
  });

  it("deleteDiagnosticData still removes the rolling key when the capture removal rejects", async () => {
    await persistCapture(capture);
    await persistTrace({ header: header(), entries: [] });
    (AsyncStorage.removeItem as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("locked");
    });
    const result = await deleteDiagnosticData();
    expect(result).toEqual({ captureRemoved: false, traceRemoved: true });
    expect(sharedStorage.has(NAV_TRACE_STORAGE_KEY)).toBe(false);
    // The capture is still on disk, so the in-memory state stays truthful.
    expect(sharedStorage.has(NAV_CAPTURE_STORAGE_KEY)).toBe(true);
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(true);
    expect(navDiagnostics.getLastCaptureJson()).toBe(sharedStorage.get(NAV_CAPTURE_STORAGE_KEY));
  });

  it("hydrates a byte-identical capture in a fresh module instance", async () => {
    await persistCapture(capture);
    const stored = sharedStorage.get(NAV_CAPTURE_STORAGE_KEY);
    expect(stored).toBeDefined();

    let hydrated: CaptureRecord | null = null;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        const fresh = require("../../../lib/diagnostics/navTrace") as {
          hydrateCapture: typeof hydrateCapture;
          navDiagnostics: typeof navDiagnostics;
        };
        expect(fresh.navDiagnostics.getStatus().hasLastCapture).toBe(false);
        fresh
          .hydrateCapture()
          .then((rec) => {
            hydrated = rec;
            expect(fresh.navDiagnostics.getStatus().hasLastCapture).toBe(true);
            resolve();
          })
          .catch(reject);
      });
    });
    expect(hydrated).not.toBeNull();
    expect(JSON.stringify(hydrated)).toBe(stored);
  });
});

describe("evaluateCalibration (section 6 C1 sub-codes, v10)", () => {
  const navId = "0xa";
  const routeKey = "r";
  const evalT = 2000;
  const shouldPopDetail = {
    kind: "shouldPop",
    navId,
    result: true,
    wrapperFound: true,
    wrapperToken: "0x1",
    wrapperEnabledBefore: true,
    wrapperEnabledAfter: false,
  };
  /** Healthy Build 6 shape: no didPop anywhere (section 23.1). */
  const healthy: TraceEntry[] = [
    entry(1, 100, "nav.state", { navKey: "app", depth: 2, index: 1 }),
    entry(2, 1000, "diag.backAttempt", { navId, visitNo: 1 }),
    nativeEntry(3, 1200, "native.popDelegate", shouldPopDetail, { tLo: 1190, tHi: 1230 }),
    entry(4, 1260, "scr.transitionStart", { routeKey, closing: true }),
    entry(5, 1700, "nav.action", { type: "POP", noop: false }),
    entry(6, 1701, "scr.transitionEnd", { routeKey, closing: true }),
    entry(7, 1720, "nav.state", { navKey: "app", depth: 1, index: 0 }),
  ];
  const sOpen = snap({ vcCount: 2 });
  const sPre = snap({ vcCount: 2 });
  const sPost = snap({ vcCount: 1, coordinatorPresent: false });
  const base = { sOpen, sPre, sPost, navId, routeKey, evalT, sequenceValid: true, sPostSeq: 8 };

  it("passes a healthy Back WITHOUT any didPop record and reports latency and didPop telemetry", () => {
    const r = evaluateCalibration({ ...base, entries: healthy });
    expect(r.ok).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.c1Failing).toEqual([]);
    expect(r.armToDelegateMs).toBe(200);
    expect(r.didPopObserved).toBe(0);
  });

  it("counts an in-window didPop as telemetry only (never a criterion)", () => {
    const entries = [
      ...healthy,
      nativeEntry(8, 1750, "native.popDelegate", { kind: "didPop", navId, wrapperToken: "0x1", wrapperEnabledAfter: true }, { tLo: 1740, tHi: 1780 }),
    ];
    const r = evaluateCalibration({ ...base, entries });
    expect(r.ok).toBe(true);
    expect(r.didPopObserved).toBe(1);
  });

  it("fails C1.pop when no nav.action POP follows the attempt", () => {
    const entries = healthy.filter((e) => e.k !== "nav.action");
    const r = evaluateCalibration({ ...base, entries });
    expect(r.ok).toBe(false);
    expect(r.failing).toEqual(["C1.pop"]);
  });

  it("fails C1.pop on a GO_BACK instead of a POP (JS-originated back)", () => {
    const entries = healthy.map((e) => (e.k === "nav.action" ? { ...e, d: { type: "GO_BACK", noop: false } } : e));
    expect(evaluateCalibration({ ...base, entries }).failing).toEqual(["C1.pop"]);
  });

  it("fails C1.late when the shouldPop upper bound exceeds the 10 s bound", () => {
    const entries = healthy.map((e) =>
      e.k === "native.popDelegate"
        ? { ...e, t: 1000 + BACK_DEAD_MAX_ANCHOR_MS, tLo: 1000 + BACK_DEAD_MAX_ANCHOR_MS - 10, tHi: 1000 + BACK_DEAD_MAX_ANCHOR_MS + 1 }
        : e,
    );
    const r = evaluateCalibration({ ...base, entries, evalT: 20_000 });
    expect(r.failing[0]).toBe("C1.late");
  });

  it("fails C1.gate when a shouldPop with result NO is in (or indeterminate for) the window", () => {
    const entries = [
      ...healthy,
      nativeEntry(8, 1500, "native.popDelegate", { ...shouldPopDetail, result: false }, { tLo: 1490, tHi: 1520 }),
    ];
    expect(evaluateCalibration({ ...base, entries }).failing[0]).toBe("C1.gate");
    const straddling = [
      ...healthy,
      nativeEntry(8, 2000, "native.popDelegate", { ...shouldPopDetail, result: false }, { tLo: 1990, tHi: 2010 }),
    ];
    expect(evaluateCalibration({ ...base, entries: straddling }).failing[0]).toBe("C1.gate");
  });

  it("fails C1.gate when wrapperEnabledAfter is true on the intercepted record", () => {
    const entries = healthy.map((e) =>
      e.k === "native.popDelegate" ? { ...e, d: { ...e.d, wrapperEnabledAfter: true } } : e,
    );
    expect(evaluateCalibration({ ...base, entries }).failing[0]).toBe("C1.gate");
  });

  it("fails C1.gate (fail closed) when the only YES shouldPop has indeterminate membership", () => {
    const entries = healthy.map((e) =>
      e.k === "native.popDelegate" ? { ...e, tb: "indeterminate" as const, tAlt: 9000 } : e,
    );
    expect(evaluateCalibration({ ...base, entries }).failing[0]).toBe("C1.gate");
  });

  it("fails C1.gate when two YES shouldPops are in the window (not exactly one)", () => {
    const entries = [
      ...healthy,
      nativeEntry(8, 1400, "native.popDelegate", shouldPopDetail, { tLo: 1390, tHi: 1420 }),
    ];
    expect(evaluateCalibration({ ...base, entries }).failing[0]).toBe("C1.gate");
  });

  it("fails C1.time when the calibration window is not sequence-valid", () => {
    const r = evaluateCalibration({ ...base, entries: healthy, sequenceValid: false });
    expect(r.ok).toBe(false);
    expect(r.failing).toEqual(["C1.time"]);
  });

  it("fails C1.order (O1) when the shouldPop interval overlaps the arm instant", () => {
    const entries = healthy.map((e) =>
      e.k === "native.popDelegate" ? { ...e, tLo: 1000, tHi: 1230 } : e,
    );
    const r = evaluateCalibration({ ...base, entries });
    expect(r.failing).toEqual(["C1.order"]);
  });

  it("fails C1.order (O4/O5) when POP precedes transitionStart or nav.state precedes POP", () => {
    const popFirst = healthy.map((e) => {
      if (e.k === "scr.transitionStart") return { ...e, s: 5 };
      if (e.k === "nav.action") return { ...e, s: 4 };
      return e;
    });
    expect(evaluateCalibration({ ...base, entries: popFirst }).failing).toEqual(["C1.order"]);
    const stateFirst = healthy.map((e) => {
      if (e.k === "nav.action") return { ...e, s: 7 };
      if (e.k === "nav.state" && e.d.depth === 1) return { ...e, s: 5 };
      return e;
    });
    expect(evaluateCalibration({ ...base, entries: stateFirst }).failing).toEqual(["C1.order"]);
  });

  it("fails C1.order (O6) when the depth-decreased nav.state lands after S-post, or S-post is unknown", () => {
    expect(evaluateCalibration({ ...base, entries: healthy, sPostSeq: 6 }).failing).toEqual(["C1.order"]);
    expect(evaluateCalibration({ ...base, entries: healthy, sPostSeq: 7 }).ok).toBe(true);
    expect(evaluateCalibration({ ...base, entries: healthy, sPostSeq: null }).failing).toEqual(["C1.order"]);
  });

  it("accepts POP after transitionEnd and transitionEnd after nav.state (orders not required)", () => {
    const popAfterEnd = healthy.map((e) => {
      if (e.k === "nav.action") return { ...e, s: 6, t: 1702 };
      if (e.k === "scr.transitionEnd") return { ...e, s: 5, t: 1700 };
      return e;
    });
    expect(evaluateCalibration({ ...base, entries: popAfterEnd }).ok).toBe(true);
    const endAfterState = healthy.map((e) => {
      if (e.k === "scr.transitionEnd") return { ...e, s: 7, t: 1730 };
      if (e.k === "nav.state" && e.d.depth === 1) return { ...e, s: 6, t: 1710 };
      return e;
    });
    expect(evaluateCalibration({ ...base, entries: endAfterState }).ok).toBe(true);
  });

  it("fails C1.trans when the closing transitions are missing or belong to another route", () => {
    const missing = healthy.filter((e) => e.k !== "scr.transitionEnd");
    expect(evaluateCalibration({ ...base, entries: missing }).failing).toEqual(["C1.trans"]);
    expect(evaluateCalibration({ ...base, entries: healthy, routeKey: "other" }).failing).toEqual(["C1.trans"]);
    expect(evaluateCalibration({ ...base, entries: healthy, routeKey: null }).failing).toEqual(["C1.trans"]);
  });

  it("fails C1.depth when no pre-attempt depth was observed or the post depth is not smaller", () => {
    const noBaseline = healthy.filter((e) => !(e.k === "nav.state" && e.d.depth === 2));
    expect(evaluateCalibration({ ...base, entries: noBaseline }).failing).toEqual(["C1.depth"]);
    const notSmaller = healthy.map((e) =>
      e.k === "nav.state" && e.d.depth === 1 ? { ...e, d: { ...e.d, depth: 2 } } : e,
    );
    expect(evaluateCalibration({ ...base, entries: notSmaller }).failing).toEqual(["C1.depth"]);
  });

  it("fails C1.count when S-post does not show one fewer controller", () => {
    const r = evaluateCalibration({ ...base, entries: healthy, sPost: snap({ vcCount: 2 }) });
    expect(r.failing).toEqual(["C1.count"]);
  });

  it("reports only the FIRST failing C1 sub-code, in contract order, plus C3/C4", () => {
    const entries = healthy
      .filter((e) => e.k !== "nav.action")
      .map((e) => (e.k === "native.popDelegate" ? { ...e, d: { ...e.d, wrapperEnabledAfter: true } } : e));
    const r = evaluateCalibration({
      ...base,
      entries,
      sOpen: snap({ wrapperFound: false }),
      sPost: snap({ vcCount: 1, navId: "0xb" }),
    });
    expect(r.failing).toEqual(["C1.gate", "C3", "C4"]);
    expect(r.c1Failing).toContain("C1.pop");
    expect(r.c1Failing).toContain("C1.count");
  });

  it("fails C3 when the wrapper lookup never resolved", () => {
    const r = evaluateCalibration({ ...base, entries: healthy, sOpen: snap({ wrapperFound: false }) });
    expect(r.failing).toEqual(["C3"]);
  });

  it("fails C4 on a navId mismatch anywhere in the set", () => {
    const r = evaluateCalibration({ ...base, entries: healthy, sPost: snap({ vcCount: 1, navId: "0xb" }) });
    expect(r.failing).toContain("C4");
  });

  it("only reads records after the most recent Back arm", () => {
    const stale = [
      nativeEntry(0, 50, "native.popDelegate", shouldPopDetail, { tLo: 40, tHi: 60 }),
      ...healthy.filter((e) => e.k !== "native.popDelegate"),
    ];
    const r = evaluateCalibration({ ...base, entries: stale });
    expect(r.ok).toBe(false);
    expect(r.failing[0]).toBe("C1.gate");
    expect(r.armToDelegateMs).toBeNull();
  });

  it("fails C1.gate when no Back arm anchors the window at all", () => {
    const r = evaluateCalibration({ ...base, entries: healthy.filter((e) => e.k !== "diag.backAttempt") });
    expect(r.failing[0]).toBe("C1.gate");
  });
});

describe("computeSwipeOutcome", () => {
  it("reports popped on a controller count decrease", () => {
    expect(
      computeSwipeOutcome({
        windowEntries: [],
        pre: snap({ vcCount: 2 }),
        late: snap({ vcCount: 1 }),
      }),
    ).toBe("popped");
  });

  it("reports popped on a closing transition end", () => {
    expect(
      computeSwipeOutcome({
        windowEntries: [entry(1, 1, "scr.transitionEnd", { closing: true })],
        pre: snap({ vcCount: 2 }),
        late: null,
      }),
    ).toBe("popped");
  });

  it("reports cancelled on a gesture cancel without a pop", () => {
    expect(
      computeSwipeOutcome({
        windowEntries: [entry(1, 1, "scr.gestureCancel", { routeKey: "r" })],
        pre: snap({ vcCount: 2 }),
        late: snap({ vcCount: 2 }),
      }),
    ).toBe("cancelled");
  });

  it("reports noEvent when nothing was observed", () => {
    expect(
      computeSwipeOutcome({
        windowEntries: [entry(1, 1, "diag.snapshot", { reason: "swipe300" })],
        pre: snap({ vcCount: 2 }),
        late: snap({ vcCount: 2 }),
      }),
    ).toBe("noEvent");
  });
});

describe("classifyJsBack (section 10 Phase 3 partition)", () => {
  const base: JsBackObservation = {
    dispatchError: false,
    actionEvent: null,
    stateEventCount: 0,
    finalChange: false,
    nativePopped: false,
    indexPre: 1,
  };

  it("maps the named rows", () => {
    expect(classifyJsBack({ ...base, dispatchError: true })).toBe("Q5e");
    expect(
      classifyJsBack({ ...base, actionEvent: { noop: false }, nativePopped: true }),
    ).toBe("A");
    expect(
      classifyJsBack({ ...base, actionEvent: { noop: false }, finalChange: true }),
    ).toBe("F1");
    expect(
      classifyJsBack({ ...base, actionEvent: { noop: false }, stateEventCount: 1 }),
    ).toBe("F2");
    expect(classifyJsBack({ ...base, actionEvent: { noop: false } })).toBe("F3");
    expect(classifyJsBack({ ...base, actionEvent: { noop: true } })).toBe("B");
    expect(classifyJsBack({ ...base, stateEventCount: 1 })).toBe("G");
    expect(classifyJsBack({ ...base, finalChange: true })).toBe("G");
    expect(classifyJsBack({ ...base, nativePopped: true })).toBe("G");
    expect(classifyJsBack({ ...base, indexPre: 0 })).toBe("C");
    expect(classifyJsBack(base)).toBe("D");
  });

  it("labels an uninterpretable pre-dispatch index INVALID instead of C or D", () => {
    expect(classifyJsBack({ ...base, indexPre: -1 })).toBe("INVALID");
    expect(classifyJsBack({ ...base, indexPre: -1, actionEvent: { noop: false } })).toBe("INVALID");
    expect(classifyJsBack({ ...base, indexPre: -1, dispatchError: true })).toBe("Q5e");
  });

  it("lands every cell of the observation space in exactly one row", () => {
    const rows = new Set<string>();
    const actions: JsBackObservation["actionEvent"][] = [
      null,
      { noop: true },
      { noop: false },
    ];
    let cells = 0;
    for (const dispatchError of [false, true]) {
      for (const actionEvent of actions) {
        for (const stateEventCount of [0, 1]) {
          for (const finalChange of [false, true]) {
            for (const nativePopped of [false, true]) {
              for (const indexPre of [0, 1]) {
                cells += 1;
                const row = classifyJsBack({
                  dispatchError,
                  actionEvent,
                  stateEventCount,
                  finalChange,
                  nativePopped,
                  indexPre,
                });
                expect(typeof row).toBe("string");
                rows.add(row);
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(96);
    expect([...rows].sort()).toEqual(["A", "B", "C", "D", "F1", "F2", "F3", "G", "Q5e"]);
    expect(rows.has("INVALID")).toBe(false);
  });
});
