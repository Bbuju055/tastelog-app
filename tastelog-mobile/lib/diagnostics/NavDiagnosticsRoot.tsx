/**
 * Build 5 Class B native-Back diagnostic: root owner (section 8.1).
 * Authority: docs/build5-classb-native-back-diagnostic-plan.md (v10).
 * INTERNAL TESTFLIGHT DIAGNOSTIC ONLY, NEVER PROMOTE TO CUSTOMER RELEASE.
 *
 * Mounted once in app/_layout.tsx under the flag, it survives every screen
 * mount, route change and focus change. It owns: probe enablement and the
 * per-process timebase (5.1 / 7.5: an anchor around enable and every
 * snapshot, epoch-based translation of drained native records), the
 * container listeners ('state', '__unsafe_action__', F14d), the AppState
 * wake gate and arm eligibility with the open-settle hold (9.0a), the
 * launch preamble and calibration (6), the capture state machine (9.2), the
 * root-owned observation windows (9.3 / 9.4), persistence with read-back
 * verification (8.2 / 8.5) and the export actions (8.4). The pill and the
 * Settings rows only call the controller it registers in the diagnostics
 * store; the pill's "Back arm" ring write passes through the arm gate the
 * root registers on the ring (9.0a).
 *
 * Every escape-probe classification happens at the END of its window
 * (jsBack3000, swipe window end); nothing is finalised earlier.
 */
import { useEffect } from "react";
import { AppState, Platform, Share, type AppStateStatus } from "react-native";
import { router, useNavigationContainerRef } from "expo-router";

import { getNavProbe, type NavProbeNative } from "../../modules/nav-probe";
import { env } from "../config";
import {
  BACK_DEAD_MAX_ANCHOR_MS,
  CALIB_ATTEMPTS_PER_SAMPLE,
  CALIB_SETTLE_MS,
  DEAD_SNAPSHOT_OFFSETS_MS,
  HEADER_CALIB_WINDOW_MS,
  JS_BACK_SNAPSHOT_OFFSETS_MS,
  JS_BACK_WINDOW_MS,
  JS_RING_CAPACITY,
  NATIVE_RING_CAPACITY,
  OPEN_SETTLE_MS,
  SWIPE_SNAPSHOT_OFFSETS_MS,
  SWIPE_WINDOW_MS,
  WAKE_ANCHOR_RETRIES,
  WAKE_ANCHOR_RETRY_MS,
  acceptAnchor,
  classifyJsBack,
  computeSwipeOutcome,
  createTimebase,
  deleteDiagnosticData,
  epochCount,
  evaluateCalibration,
  findFocusedStack,
  hydrateCapture,
  isNavDiagnosticsEnabled,
  jsClockProvider,
  navDiagnostics,
  nativeRecordDetail,
  nativeRecordKind,
  nowMs,
  persistCapture,
  persistTrace,
  readTrace,
  selectWindowEntries,
  stateSignature,
  summarizeState,
  translateNative,
  windowAbsence,
  windowMembership,
  windowSequenceValid,
  type CaptureAppendixLabel,
  type CaptureRecord,
  type DiagnosticsController,
  type EnableResult,
  type JsBackObservation,
  type JsClockProvider,
  type ProbeSnapshot,
  type TraceEntry,
  type TraceExport,
  type TraceHeader,
  type VisitMode,
} from "./navTrace";

// ---------------------------------------------------------------------------
// Dependencies (structural, so tests can fake the container and the probe)
// ---------------------------------------------------------------------------

type ContainerEvent = { data: unknown };

export type NavContainerLike = {
  isReady(): boolean;
  addListener(type: "state", cb: (e: ContainerEvent) => void): () => void;
  addListener(type: "__unsafe_action__", cb: (e: ContainerEvent) => void): () => void;
  getRootState(): unknown;
};

export type RootOwnerDeps = {
  container: NavContainerLike;
  probe: NavProbeNative | null;
  /** expo-router GO_BACK (F14a): queued, flushed in an effect, never a native pop. */
  routerBack: () => void;
};

type DeviceInfo = {
  appVersion: string | null;
  appBuild: string | null;
  deviceModel: string | null;
};

type JsBackWindowState = {
  /** Exact window end (9.4): records timestamped later never count. */
  deadlineT: number;
  actionEvent: { noop: boolean } | null;
  stateEvents: number;
  /** Signature of the last in-window state event (final-change basis). */
  lastSignature: string;
  dispatchError: boolean;
};

type VisitInfo = {
  routeKey: string | null;
  recipeId: string | null;
  launchNo: number;
  visitNo: number;
};

/** 7.5.2: a snapshot with its anchor bracket and its ring entry sequence. */
type SnapshotResult = {
  snap: ProbeSnapshot | null;
  jsBefore: number;
  jsAfter: number;
  jsMid: number;
  accepted: boolean;
  seq: number | null;
};

/** A wake attempt records a failure but faults only on exhaustion (9.0a). */
type SnapshotOptions = { quiet?: boolean };

type WindowFlags = { attempt: boolean | null; swipe: boolean | null; jsBack: boolean | null };

type ReadyReason =
  | "eligible"
  | "notInitialised"
  | "background"
  | "noEpoch"
  | "visitClosed"
  | "settling"
  | "headerCalib"
  | "notCalibrated"
  | "calibLocked";

/** 6 P5 (v11): one evaluated header-calibration window (set or restore). */
type P5WindowResult = {
  hit: boolean;
  quiet: boolean;
  valid: boolean;
  drainOk: boolean;
  latencyMs: number | null;
  stale: boolean;
  /** A3 / H2: the lifecycle generation changed since the tap (interruption). */
  interrupted: boolean;
};

/** A3: the P5 operation's identity, captured synchronously at the tap. */
type ActiveP5 = { id: number; visitNo: number; routeKey: string | null; gen: number };

/** Records whose presence (IN or INDETERMINATE) makes a P5 window non-quiet (6 P5). */
const P5_QUIET_BREAKERS: ReadonlySet<string> = new Set([
  "nav.action",
  "scr.transitionStart",
  "scr.transitionEnd",
  "scr.gestureCancel",
  "ui.detailMount",
  "native.popDelegate",
  "app.state",
]);

/** 19 (v11): the launch's calibration is locked; the operator exports, quits and relaunches. */
const CALIB_LOCKED_MESSAGE =
  "PROBE INVALID for this launch. Tap Trace, then Share, then quit the app and open it again.";
const SAMPLE_INSTRUCTION = "Tap Calib, wait for 'S-pre taken', then Back arm, then Back once.";
const C2_PASS_MESSAGE =
  "C2 PASS. Check the title says Recipe again, then tap Calib, wait for 'S-pre taken', then Back arm, then Back once.";

function makeSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * expo-constants and expo-clipboard ship ESM builds that the read-only Jest
 * config does not transform, and a native `import()` is not transformed
 * either. They are therefore required lazily on the flag-on path only, so
 * they never enter the module graph of app/_layout.tsx in a customer build
 * or in the existing suites (Metro inlines these requires). Each loader
 * degrades to null on any failure. These two integration-edge casts are the
 * only ones in the diagnostic code.
 */
function loadDeviceInfo(): DeviceInfo {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-constants") as { default: typeof import("expo-constants").default };
    const constants = mod.default;
    const iosPlatform = constants.platform?.ios;
    return {
      appVersion: constants.expoConfig?.version ?? null,
      appBuild: constants.expoConfig?.ios?.buildNumber ?? iosPlatform?.buildNumber ?? null,
      deviceModel: iosPlatform?.platform ?? null,
    };
  } catch {
    return { appVersion: null, appBuild: null, deviceModel: null };
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Clipboard = require("expo-clipboard") as typeof import("expo-clipboard");
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

/** Operator copy for a latched probe fault (section 19): plain language only. */
export const INVALID_RUN_MESSAGE = "This test run is no longer valid. Reopen the recipe.";

// ---------------------------------------------------------------------------
// Root owner
// ---------------------------------------------------------------------------

export function createRootOwner(deps: RootOwnerDeps) {
  const ring = navDiagnostics.getRing();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const unsubs: (() => void)[] = [];
  let stopped = false;
  let busy = false;

  let sessionToken = "";
  let launchNo = 0;
  const wallStart = new Date().toISOString();
  let c2Passed = false;
  let probeLine = "Probe: not enabled";
  let enableResult: EnableResult | null = null;
  let nativeOverflowTotal = 0;
  /** A failed drain or snapshot makes this launch PROBE INVALID (19). */
  let probeFaults = 0;
  let deviceInfo: DeviceInfo = { appVersion: null, appBuild: null, deviceModel: null };

  // Timebase (7.5) and its header facts.
  const timebase = createTimebase();
  let clockProvider: JsClockProvider | "unknown" = "unknown";
  let c1DidPopObserved: number | null = null;
  const windowFlags: WindowFlags = { attempt: null, swipe: null, jsBack: null };
  /** Section 19: the first probe fault makes the whole launch INVALID (latched). */
  let launchInvalid: string | null = null;

  // Arm eligibility (9.0a).
  let appActive = AppState.currentState !== "background" && AppState.currentState !== "inactive";
  let epochEstablished = false;
  /**
   * Lifecycle generation: advanced by every inactive/background transition.
   * An async snapshot captures the generation it started in; a completion
   * from an older generation records its anchor but can neither establish
   * the epoch nor restore readiness.
   */
  let lifecycleGen = 0;
  let visitOpen = false;
  let openDoneMs: number | null = null;
  let pendingOpenRouteKey: string | null = null;
  let lastReady: { eligible: boolean; reason: ReadyReason } | null = null;
  let ready = false;
  let stepMessage = "";
  let stepJoiner = ": ";

  // Calibration (section 6), per launch.
  let sOpen: ProbeSnapshot | null = null;
  let sPre: ProbeSnapshot | null = null;
  let sPostSeq: number | null = null;
  let calibArmed = false;
  let pinnedNavId: string | null = null;
  /** calib() started and its S-pre has not resolved yet (A3: P5 refuses to interleave). */
  let calibPending = false;
  /**
   * The Calib preparation in flight, bound to its visit, route and lifecycle
   * generation; a Kind change or a completed evaluation clears it, so an older
   * S-pre completion is inert (never arms, never publishes, never touches a
   * newer operation's pending state).
   */
  let calibOp: ActiveP5 | null = null;
  let calibOpCounter = 0;
  /** 19 (v11): any non-isolated failure or an exhausted allowance locks the launch. */
  let calibLocked = false;
  let sample1Passed = false;
  /** P5 reached both hits on this launch: the post-P5 sample (sample 2) is required. */
  let p5RanThisLaunch = false;
  let sample2Passed = false;
  let calibAttempts1 = 0;
  let calibAttempts2 = 0;
  /** The current visit's open snapshot: jsAfter (5.5 token window end) and acceptance (M1). */
  let openSnapshotJsAfter: number | null = null;
  let openSnapshotAccepted = false;
  // Header calibration P5 (6, v11).
  let headerCalibActive = false;
  let activeP5: ActiveP5 | null = null;
  let p5Counter = 0;
  /** A C1 evaluation (S-post, settle, drain, evaluate) is in flight (H1). */
  let calibEvalPending = false;
  /** Native overflow total when calib() took S-pre (H3: overflow voids the C1 window). */
  let overflowAtCalib = 0;
  let c2SetLatencyMs: number | null = null;
  let c2RestoreLatencyMs: number | null = null;

  // Current visit and capture (sections 6 and 9).
  let currentVisit: VisitInfo | null = null;
  let capture: CaptureRecord | null = null;
  /** Visit that produced the in-memory capture (9.1: one Back dead per attempt). */
  let captureVisitNo: number | null = null;
  let jsBackWindow: JsBackWindowState | null = null;

  const status = () => navDiagnostics.getStatus();
  const setStatus = (patch: Parameters<typeof navDiagnostics.setStatus>[0]) => {
    if (!stopped) navDiagnostics.setStatus(patch);
  };

  /**
   * 9.0a / 11: the pill message is always "Ready: <step>" or
   * "Not ready: <step>"; readiness is the only operator-facing state.
   */
  /**
   * Section 19: while the launch is latched PROBE INVALID the operator line
   * is the plain-language stop below and nothing else, so no later hint,
   * calibration or readiness text can hide it or invite the operator to
   * continue. The fault identity stays in the calibration status line, the
   * headers and the trace for engineering.
   */
  function publishMessage(): void {
    if (launchInvalid !== null) {
      setStatus({ message: INVALID_RUN_MESSAGE });
      return;
    }
    if (!ready && lastReady?.reason === "notCalibrated") {
      setStatus({ message: "Not ready: calibration required" });
      return;
    }
    setStatus({ message: `${ready ? "Ready" : "Not ready"}${stepJoiner}${stepMessage}` });
  }

  function say(step: string, joiner = ": "): void {
    stepMessage = step;
    stepJoiner = joiner;
    publishMessage();
  }

  /** Section 19: a latched probe fault is never overwritten by a later nominal status. */
  function invalidLabel(): string | null {
    return launchInvalid === null ? null : `INVALID: ${launchInvalid} (probe fault, V1)`;
  }

  function calibrationStatus(nominal: string): string {
    return invalidLabel() ?? nominal;
  }

  function after(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!stopped) fn();
    }, ms);
    timers.add(id);
  }

  function buildHeader(flags: WindowFlags): TraceHeader {
    return {
      sessionToken,
      launchNo,
      wallStart,
      appVersion: deviceInfo.appVersion,
      appBuild: deviceInfo.appBuild,
      iosVersion: Platform.Version === undefined ? null : String(Platform.Version),
      deviceModel: deviceInfo.deviceModel,
      flag: env.EXPO_PUBLIC_NAV_DIAGNOSTICS,
      probeStatus: enableResult,
      calibrationStatus: status().calibration,
      c2PassedSession: c2Passed,
      c1DidPopObserved,
      jsClockProvider: clockProvider,
      timebaseAnchors: timebase.anchors.length,
      timebaseGaps: timebase.gaps,
      epochCount: epochCount(timebase),
      attemptWindowSequenceValid: flags.attempt,
      escapeWindowsSequenceValid: { swipe: flags.swipe, jsBack: flags.jsBack },
      jsRingCapacity: JS_RING_CAPACITY,
      nativeRingCapacity: NATIVE_RING_CAPACITY,
      jsOverflow: ring.overflow,
      nativeOverflow: nativeOverflowTotal,
      c2SetLatencyMs,
      c2RestoreLatencyMs,
      calibAttempts1,
      calibAttempts2,
      postP5SamplePassed: p5RanThisLaunch ? sample2Passed : null,
    };
  }

  /** Rolling export: window flags belong to the capture, not to the trace. */
  function buildExport(): TraceExport {
    return { header: buildHeader({ attempt: null, swipe: null, jsBack: null }), entries: ring.sorted() };
  }

  function currentEpoch(): number {
    return timebase.anchors[timebase.anchors.length - 1]?.epoch ?? 0;
  }

  /**
   * 5.3 / 7.5.2: read-only UIKit inspection bracketed by two JS-clock reads.
   * The snapshot entry carries [jsBefore, jsAfter]; an accepted anchor
   * re-establishes the epoch (9.0a); every anchor writes diag.timebase.
   */
  async function snapshot(reason: string, options: SnapshotOptions = {}): Promise<SnapshotResult> {
    const probe = deps.probe;
    const gen = lifecycleGen;
    const jsBefore = nowMs();
    if (!probe) {
      const entry = ring.push("diag.snapshot", { reason, probe: "absent" }, jsBefore);
      return { snap: null, jsBefore, jsAfter: jsBefore, jsMid: jsBefore, accepted: false, seq: entry?.s ?? null };
    }
    try {
      const snap = await probe.snapshot(reason);
      const jsAfter = nowMs();
      const outcome = acceptAnchor(timebase, { source: reason, jsBefore, jsAfter, nativeS: snap.nativeTimeS });
      const jsMid = (jsBefore + jsAfter) / 2;
      const epoch = outcome.anchor?.epoch ?? currentEpoch();
      const entry = ring.push(
        "diag.snapshot",
        {
          reason,
          optionsBuilt: navDiagnostics.getOptionsBuilt(),
          ...snap,
          otherController: pinnedNavId !== null && snap.navId !== pinnedNavId,
        },
        jsMid,
        { tLo: jsBefore, tHi: jsAfter, epoch, tb: "ok" },
      );
      ring.push("diag.timebase", outcome.detail, jsAfter);
      // Only a completion from the CURRENT lifecycle generation establishes
      // the epoch; a stale pre-background completion keeps its anchor only.
      if (outcome.accepted && gen === lifecycleGen) {
        epochEstablished = true;
        refreshEligibility();
      }
      return { snap, jsBefore, jsAfter, jsMid, accepted: outcome.accepted, seq: entry?.s ?? null };
    } catch {
      const jsAfter = nowMs();
      const entry = ring.push("diag.snapshot", { reason, probe: "failed" }, jsAfter);
      if (!options.quiet) markProbeFault("snapshot failed");
      return { snap: null, jsBefore, jsAfter, jsMid: (jsBefore + jsAfter) / 2, accepted: false, seq: entry?.s ?? null };
    }
  }

  function markProbeFault(what: string): void {
    probeFaults += 1;
    if (launchInvalid === null) launchInvalid = what;
    setStatus({ calibration: invalidLabel() ?? "" });
    publishMessage();
    // H5: a latched launch disqualifies trial arms at once.
    refreshEligibility();
  }

  /**
   * 5.7 / 7.5.4-7.5.6: drained native records join the ring translated
   * inside their epoch with their declared interval; the post-anchor tail is
   * bounded by the drain's own completion time.
   */
  async function drainNative(): Promise<void> {
    const probe = deps.probe;
    if (!probe) return;
    try {
      const result = await probe.drain();
      const jsDrainAfter = nowMs();
      for (const record of result.records) {
        // 5.2: records from a controller other than the pinned one are
        // labelled and never merged into app-stack conclusions.
        const detail = nativeRecordDetail(record);
        if (pinnedNavId !== null && record.navId !== pinnedNavId) {
          detail.otherController = true;
        }
        const translated = translateNative(timebase, record.nativeTimeS, jsDrainAfter);
        if (translated === null) {
          // No accepted anchor exists: the record has no JS-clock time at all.
          ring.push(nativeRecordKind(record), detail, jsDrainAfter, {
            tLo: jsDrainAfter,
            tHi: jsDrainAfter,
            epoch: 0,
            tb: "indeterminate",
          });
          continue;
        }
        const { t, ...tb } = translated;
        ring.push(nativeRecordKind(record), detail, t, tb);
      }
      if (result.overflow > 0) {
        nativeOverflowTotal += result.overflow;
        ring.push("diag.overflow", { js: ring.overflow, native: result.overflow });
      }
    } catch {
      ring.push("diag.overflow", { js: ring.overflow, native: 0, drainFailed: true });
      markProbeFault("drain failed");
    }
  }

  // -------------------------------------------------------------------------
  // Arm eligibility, open-settle hold and wake gate (9.0a)
  // -------------------------------------------------------------------------

  function eligibility(): { eligible: boolean; reason: ReadyReason } {
    if (!status().initialised) return { eligible: false, reason: "notInitialised" };
    if (!appActive) return { eligible: false, reason: "background" };
    if (!epochEstablished) return { eligible: false, reason: "noEpoch" };
    if (!visitOpen || openDoneMs === null) return { eligible: false, reason: "visitClosed" };
    if (nowMs() - openDoneMs < OPEN_SETTLE_MS) return { eligible: false, reason: "settling" };
    // v11: no arm during P5; no trial arm before the launch is CALIBRATED (D12).
    if (headerCalibActive) return { eligible: false, reason: "headerCalib" };
    if (status().visitMode.kind === "trial" && !launchCalibrated()) {
      return { eligible: false, reason: "notCalibrated" };
    }
    // H4: a calibration arm beyond the sample's allowance is refused and locks the launch.
    if (calibArmed && status().visitMode.kind === "calibration" && !currentSamplePassed()) {
      const used = currentSample() === 2 ? calibAttempts2 : calibAttempts1;
      if (used >= CALIB_ATTEMPTS_PER_SAMPLE) return { eligible: false, reason: "calibLocked" };
    }
    return { eligible: true, reason: "eligible" };
  }

  /**
   * 6 Outcome (v11): sample 1 passed on this launch, C2 passed this session and,
   * when P5 ran on this launch, the post-P5 sample passed too; never on a
   * latched or locked launch (H5).
   */
  function launchCalibrated(): boolean {
    if (launchInvalid !== null || calibLocked) return false;
    return sample1Passed && c2Passed && (!p5RanThisLaunch || sample2Passed);
  }

  function currentSamplePassed(): boolean {
    return currentSample() === 2 ? sample2Passed : sample1Passed;
  }

  /** Any calibration operation in flight (H3: Arm end must not reset the ring meanwhile). */
  function calibrationInProgress(): boolean {
    return calibPending || calibArmed || calibEvalPending || headerCalibActive;
  }

  function lockCalibration(statusText: string): void {
    calibLocked = true;
    setStatus({ calibration: calibrationStatus(statusText) });
    say(CALIB_LOCKED_MESSAGE);
    refreshEligibility();
  }

  /** 6 / 19 (v11): the sample an accepted calibration attempt is charged to. */
  function currentSample(): 1 | 2 {
    return p5RanThisLaunch && c2Passed ? 2 : 1;
  }

  /** Every eligibility change writes diag.ready and re-publishes the pill line. */
  function refreshEligibility(): void {
    if (stopped) return;
    const next = eligibility();
    if (lastReady !== null && lastReady.eligible === next.eligible && lastReady.reason === next.reason) return;
    lastReady = next;
    ring.push("diag.ready", next);
    ready = next.eligible;
    publishMessage();
  }

  /**
   * The gate the pill's "Back arm" write runs through (9.0a): a synchronous
   * re-evaluation from the clock, independent of the displayed state. The
   * eligible path has no side effect (9.0); a refused arm writes nothing.
   */
  function armGate(): boolean {
    const result = eligibility();
    if (result.eligible) {
      // 19 (v11): an ACCEPTED arm on a calibration visit with S-pre taken is one
      // calibration attempt, whether or not Back follows.
      if (calibArmed && status().visitMode.kind === "calibration" && !currentSamplePassed()) {
        if (currentSample() === 2) calibAttempts2 += 1;
        else calibAttempts1 += 1;
      }
      return true;
    }
    if (result.reason === "calibLocked" && !calibLocked) {
      lockCalibration(
        `INVALID: C1 attempts exhausted (sample ${currentSample()}, ${CALIB_ATTEMPTS_PER_SAMPLE} arms used)`,
      );
    }
    refreshEligibility();
    return false;
  }

  /** 6 P2 / 9.0a: the visit's open snapshot; starts the open-settle hold. */
  async function openVisitSnapshot(): Promise<void> {
    const calibration = status().visitMode.kind === "calibration";
    const result = await snapshot(calibration ? "calibOpen" : "visitOpen");
    if (stopped) return;
    if (calibration) sOpen = result.snap;
    visitOpen = true;
    openDoneMs = result.jsAfter;
    openSnapshotJsAfter = result.jsAfter;
    openSnapshotAccepted = result.accepted;
    say(calibration ? calibrationOpenHint() : "Back arm, then native Back once within 3 s.");
    refreshEligibility();
    after(Math.max(0, OPEN_SETTLE_MS - (nowMs() - openDoneMs)), refreshEligibility);
  }

  /** 6 P2 (v11): the calibration-visit open message names the next action from the state. */
  function calibrationOpenHint(): string {
    if (calibLocked) return CALIB_LOCKED_MESSAGE;
    if (!sample1Passed) return `S-open taken. ${SAMPLE_INSTRUCTION}`;
    if (!c2Passed) return "S-open taken. Tap Header calib and touch nothing.";
    if (p5RanThisLaunch && !sample2Passed) return `S-open taken. ${SAMPLE_INSTRUCTION}`;
    return "CALIBRATED. Calibration visits need no further action.";
  }

  /** A3: a visit that closes or is replaced ends its own P5 (later completions are stale). */
  function endActiveP5ForVisit(visitNo: number): void {
    if (activeP5 !== null && activeP5.visitNo === visitNo) {
      activeP5 = null;
      headerCalibActive = false;
    }
  }

  function onAppState(state: AppStateStatus): void {
    ring.push("app.state", { state });
    if (state === "active") {
      appActive = true;
      // Only the wake anchor of this generation (or a later current-generation
      // anchor) may establish the epoch again.
      epochEstablished = false;
      refreshEligibility();
      void wake();
      return;
    }
    lifecycleGen += 1;
    appActive = false;
    epochEstablished = false;
    refreshEligibility();
  }

  /**
   * 9.0a: the wake anchor, up to WAKE_ANCHOR_RETRIES attempts spaced by
   * WAKE_ANCHOR_RETRY_MS; a thrown or rejected attempt is recorded and
   * retried; only exhaustion faults the launch. Readiness returns by itself
   * on the accepted attempt (snapshot() establishes the epoch).
   */
  async function wake(): Promise<void> {
    const gen = lifecycleGen;
    for (let attempt = 0; attempt < WAKE_ANCHOR_RETRIES; attempt += 1) {
      const result = await snapshot("wake", { quiet: true });
      if (stopped || gen !== lifecycleGen) return;
      if (result.accepted) return;
      if (attempt < WAKE_ANCHOR_RETRIES - 1) {
        await sleep(WAKE_ANCHOR_RETRY_MS);
        if (stopped || gen !== lifecycleGen) return;
      }
    }
    markProbeFault("wake anchor");
    refreshEligibility();
  }

  // -------------------------------------------------------------------------
  // Initialisation (8.3 hydration, 5.1 enable, launch header)
  // -------------------------------------------------------------------------

  async function enableProbe(): Promise<void> {
    for (let attempt = 0; attempt < 100 && !deps.container.isReady(); attempt += 1) {
      await sleep(50);
      if (stopped) return;
    }
    const probe = deps.probe;
    if (!probe) {
      probeLine = "Probe: absent (native module not compiled in)";
      return;
    }
    clockProvider = jsClockProvider();
    const jsBefore = nowMs();
    try {
      const native = await probe.enable(sessionToken);
      const jsAfter = nowMs();
      enableResult = { ...native, jsTimebaseAnchorMs: (jsBefore + jsAfter) / 2 };
      const outcome = acceptAnchor(timebase, {
        source: "enable",
        jsBefore,
        jsAfter,
        nativeS: native.nativeTimebaseAnchorS,
      });
      ring.push("diag.timebase", outcome.detail, jsAfter);
      if (outcome.accepted) epochEstablished = true;
      probeLine = `Probe: pop=${native.popHooks} header=${native.headerHook} nav=${native.navId ?? "none"}`;
    } catch {
      probeLine = "Probe: enable failed";
    }
  }

  async function initialise(): Promise<void> {
    const previous = await readTrace();
    sessionToken = previous?.header.sessionToken ?? makeSessionToken();
    launchNo = (previous?.header.launchNo ?? 0) + 1;
    c2Passed = previous?.header.c2PassedSession ?? false;
    await hydrateCapture();
    deviceInfo = loadDeviceInfo();
    await enableProbe();
    if (stopped) return;
    const popInstalled = enableResult?.popHooks === "installed";
    // 6 (v11 / H6): the session-once C2 is repeated when enable() no longer
    // reports the header hook installed.
    if (c2Passed && enableResult?.headerHook !== "installed") c2Passed = false;
    setStatus({
      launchNo,
      navId: enableResult?.navId ?? null,
      probeLine,
      calibration: calibrationStatus(popInstalled ? "PENDING" : "INVALID: popHooks not installed (V1)"),
    });
    say(popInstalled ? "Open the calibration recipe (kind=calibration)" : "PROBE INVALID: popHooks not installed");
    // 7.5.1: the diagnostic clock must be the steady provider; else PROBE INVALID.
    if (deps.probe && clockProvider !== "steady") markProbeFault("timebase provider");
    // The rolling header is written at launch so launchNo and the session
    // token survive a relaunch even when no export happens in this launch.
    await persistTrace(buildExport());
    // 8.3: the pill and Settings controls become active only now, together.
    if (stopped) return;
    navDiagnostics.setController(controller);
    setStatus({ initialised: true });
    refreshEligibility();
  }

  // -------------------------------------------------------------------------
  // Container listeners (F14d, 7.1 nav.state / nav.action)
  // -------------------------------------------------------------------------

  function onState(e: ContainerEvent): void {
    const data = e.data as { state?: unknown } | undefined;
    const entry = ring.push("nav.state", summarizeState(data?.state));
    if (entry && jsBackWindow && entry.t <= jsBackWindow.deadlineT) {
      jsBackWindow.stateEvents += 1;
      jsBackWindow.lastSignature = stateSignature(data?.state);
    }
    if (calibArmed && status().visitMode.kind === "calibration") onCalibrationStateChange();
  }

  function onAction(e: ContainerEvent): void {
    const data = e.data as
      | { action?: { type?: string; source?: string; target?: string }; noop?: boolean }
      | undefined;
    const type = data?.action?.type ?? "";
    const noop = data?.noop === true;
    const entry = ring.push("nav.action", {
      type,
      noop,
      source: data?.action?.source ?? null,
      target: data?.action?.target ?? null,
    });
    if (
      entry &&
      jsBackWindow &&
      type === "GO_BACK" &&
      jsBackWindow.actionEvent === null &&
      entry.t <= jsBackWindow.deadlineT
    ) {
      jsBackWindow.actionEvent = { noop };
    }
  }

  /** Screen records (7.1): visit tracking, visit open/close, the calibration S-open. */
  function onRecord(entry: TraceEntry): void {
    if (entry.k === "ui.detailMount") {
      const routeKey = typeof entry.d.routeKey === "string" ? entry.d.routeKey : null;
      const visitNo = typeof entry.d.visitNo === "number" ? entry.d.visitNo : status().visitNo;
      // A re-emission for the SAME visit (Kind/Arm/Anchor correction, 6) is
      // not a new visit: it never resets the open state or the hold.
      if (currentVisit !== null && currentVisit.visitNo === visitNo && currentVisit.routeKey === routeKey) {
        return;
      }
      if (currentVisit !== null) endActiveP5ForVisit(currentVisit.visitNo);
      currentVisit = {
        routeKey,
        recipeId: typeof entry.d.recipeId === "string" ? entry.d.recipeId : null,
        launchNo: typeof entry.d.launchNo === "number" ? entry.d.launchNo : launchNo,
        visitNo,
      };
      visitOpen = false;
      openDoneMs = null;
      refreshEligibility();
      // A deferred mount record (first visit of a launch) may land after the
      // open transition already ended: take the open snapshot now.
      if (pendingOpenRouteKey !== null && pendingOpenRouteKey === routeKey) {
        pendingOpenRouteKey = null;
        void openVisitSnapshot();
      }
      return;
    }
    if (entry.k === "scr.transitionEnd" && entry.d.closing === false) {
      if (currentVisit !== null && entry.d.routeKey === currentVisit.routeKey) {
        void openVisitSnapshot();
      } else if (typeof entry.d.routeKey === "string") {
        pendingOpenRouteKey = entry.d.routeKey;
      }
      return;
    }
    if (
      entry.k === "scr.transitionEnd" &&
      entry.d.closing === true &&
      currentVisit !== null &&
      entry.d.routeKey === currentVisit.routeKey
    ) {
      visitOpen = false;
      endActiveP5ForVisit(currentVisit.visitNo);
      refreshEligibility();
    }
  }

  // -------------------------------------------------------------------------
  // Calibration (section 6)
  // -------------------------------------------------------------------------

  function calib(): void {
    if (busy || calibPending || calibEvalPending) return;
    // H5: a latched launch records nothing new for calibration (19).
    if (launchInvalid !== null) return;
    if (calibLocked) {
      say(CALIB_LOCKED_MESSAGE);
      return;
    }
    if (headerCalibActive) {
      say("Header calib in progress, wait.");
      return;
    }
    if (status().visitMode.kind !== "calibration") {
      say("Calib needs a calibration visit (Kind: calibration).");
      return;
    }
    calibOpCounter += 1;
    const op: ActiveP5 = {
      id: calibOpCounter,
      visitNo: currentVisit?.visitNo ?? status().visitNo,
      routeKey: currentVisit?.routeKey ?? null,
      gen: lifecycleGen,
    };
    calibOp = op;
    calibPending = true;
    overflowAtCalib = nativeOverflowTotal;
    void (async () => {
      const result = await snapshot("calibPreBack");
      // Only the operation that is still current may clear the pending state.
      const current = calibOp !== null && calibOp.id === op.id;
      if (!current) return;
      calibPending = false;
      if (stopped) return;
      const sameVisit =
        currentVisit !== null && currentVisit.visitNo === op.visitNo && currentVisit.routeKey === op.routeKey;
      if (
        calibLocked ||
        launchInvalid !== null ||
        !sameVisit ||
        !visitOpen ||
        lifecycleGen !== op.gen ||
        status().visitMode.kind !== "calibration"
      ) {
        calibOp = null;
        return;
      }
      sPre = result.snap;
      calibArmed = true;
      const sample = currentSample();
      const next = (sample === 2 ? calibAttempts2 : calibAttempts1) + 1;
      say(
        `S-pre taken (sample ${sample}, attempt ${next} of ${CALIB_ATTEMPTS_PER_SAMPLE} next). Back arm, then native Back within 3 s.`,
      );
    })();
  }

  function onCalibrationStateChange(): void {
    calibArmed = false;
    calibOp = null;
    calibEvalPending = true;
    void (async () => {
      const post = await snapshot("calibPostBack");
      sPostSeq = post.seq;
      // Transition and dismissal events from the same native pop can land in
      // either order relative to the state event; settle briefly, then drain.
      after(CALIB_SETTLE_MS, () => {
        void finishCalibration(post.snap).finally(() => {
          calibEvalPending = false;
          refreshEligibility();
        });
      });
    })();
  }

  async function finishCalibration(sPost: ProbeSnapshot | null): Promise<void> {
    // 7.5.6 / 7.5.7: the boundary anchor of the calibration window precedes
    // the evaluation drain; evalT is that anchor's JS time (6 C1).
    const boundary = await snapshot("calibEval");
    const evalT = boundary.jsMid;
    await drainNative();
    ring.push("diag.mark", { label: "calibEval", launchNo, visitNo: status().visitNo, tapToMarkerMs: null }, evalT);
    const navId = enableResult?.navId ?? sPost?.navId ?? null;
    const sample = currentSample();
    const attempts = sample === 2 ? calibAttempts2 : calibAttempts1;
    if (!sOpen || !sPre || !sPost || !navId) {
      lockCalibration("INVALID: preamble incomplete (S-open/S-pre/S-post)");
      return;
    }
    const attempt = findLastAttempt(status().visitNo);
    const result = evaluateCalibration({
      entries: ring.entries(),
      sOpen,
      sPre,
      sPost,
      navId,
      routeKey: currentVisit?.routeKey ?? null,
      evalT,
      // 7.3 / H3: native overflow since S-pre voids the window's sequence claims.
      sequenceValid:
        attempt !== null &&
        windowSequenceValid(timebase, attempt.t, evalT) &&
        nativeOverflowTotal === overflowAtCalib,
      sPostSeq,
    });
    c1DidPopObserved = result.didPopObserved;
    if (!result.ok) {
      // 19 (v11): an ISOLATED C1.late is an operator timing miss with a bounded
      // retry allowance per required sample; everything else locks the launch.
      // Isolated = C1.late is the ONLY failing sub-code (the evaluator reports the
      // first failing sub-code in `failing`; `c1Failing` lists every one).
      const isolatedLate =
        result.c1Failing.length === 1 && result.c1Failing[0] === "C1.late" && result.failing.length === 1;
      if (isolatedLate && launchInvalid === null && attempts < CALIB_ATTEMPTS_PER_SAMPLE) {
        setStatus({
          calibration: calibrationStatus(
            `C1.late (sample ${sample} attempt ${attempts} of ${CALIB_ATTEMPTS_PER_SAMPLE})`,
          ),
        });
        say(
          `Timing miss (Back after 10 s). Sample ${sample} attempt ${attempts} of ${CALIB_ATTEMPTS_PER_SAMPLE} used. Reopen the recipe, tap Calib, wait for 'S-pre taken', then Back arm, then Back within 3 s.`,
        );
        return;
      }
      lockCalibration(
        isolatedLate
          ? `INVALID: C1.late x${CALIB_ATTEMPTS_PER_SAMPLE} (sample ${sample} attempts exhausted)`
          : `INVALID: ${result.failing.join(",")}`,
      );
      return;
    }
    if (launchInvalid !== null || calibLocked) {
      // H5: a launch latched or locked meanwhile never advances calibration.
      return;
    }
    pinnedNavId = navId;
    ring.push("diag.mark", {
      label: "calibrated",
      launchNo,
      visitNo: status().visitNo,
      tapToMarkerMs: result.armToDelegateMs,
      didPopObserved: result.didPopObserved,
    });
    if (sample === 2) sample2Passed = true;
    else sample1Passed = true;
    // 6 Outcome (v11): C2 alone never completes the launch; the post-P5 sample does.
    const complete = launchCalibrated();
    setStatus({
      navId,
      calibration: calibrationStatus(
        complete
          ? "CALIBRATED"
          : c2Passed
            ? "C2 OK, post-P5 sample pending"
            : "C1/C3/C4 OK, C2 pending (Header calib)",
      ),
    });
    say(
      complete
        ? `CALIBRATED (arm-to-delegate ${Math.round(result.armToDelegateMs ?? -1)} ms)`
        : c2Passed
          ? C2_PASS_MESSAGE
          : "Open the calibration recipe again and tap Header calib (P5).",
    );
    refreshEligibility();
  }

  /**
   * 5.5 (v11): the current visit's detail VC token = the unique vcToken among
   * native.headerUpdate records on the pinned navId that are IN the visit's
   * opening window [first ui.detailMount.t, open-snapshot jsAfter] (the open
   * anchor accepted, the window sequence-valid). Unresolved (none, several,
   * an invalid window) => null.
   */
  function resolveVisitDetailToken(navId: string): string | null {
    if (currentVisit === null || openSnapshotJsAfter === null || !openSnapshotAccepted) return null;
    const visitNo = currentVisit.visitNo;
    const entries = ring.entries();
    const mount = entries.find((e) => e.k === "ui.detailMount" && e.d.visitNo === visitNo);
    if (!mount) return null;
    const startT = mount.t;
    const endT = openSnapshotJsAfter;
    if (!windowSequenceValid(timebase, startT, endT)) return null;
    const tokens = new Set<string>();
    for (const e of entries) {
      if (e.k !== "native.headerUpdate" || e.d.navId !== navId) continue;
      if (windowMembership(e, startT, endT) !== "in") continue;
      if (typeof e.d.vcToken === "string") tokens.add(e.d.vcToken);
    }
    if (tokens.size !== 1) return null;
    return [...tokens][0] ?? null;
  }

  /**
   * 6 P5 (v11): one header-calibration window [startT, startT + 1 s], closed by
   * a boundary snapshot (7.5.2 anchor) before the drain. P(W) = sequence-valid
   * AND drain ok AND a hit on the pinned navId with the visit's detail VC token
   * IN the window AND quiet. A completion whose P5 is no longer the active one
   * (visit closed or replaced, newer P5) is recorded as stale.
   */
  async function evaluateP5Window(
    phase: "set" | "restore",
    startT: number,
    navId: string,
    token: string,
    op: ActiveP5,
    baseline: { overflow: number; faults: number },
  ): Promise<P5WindowResult> {
    const endT = startT + HEADER_CALIB_WINDOW_MS;
    const { overflow: overflowBefore, faults: faultsBefore } = baseline;
    const boundary = await snapshot("headerCalibEval");
    await drainNative();
    const stale = stopped || activeP5 === null || activeP5.id !== op.id;
    const interrupted = lifecycleGen !== op.gen;
    const visitNo = op.visitNo;
    const entries = ring.entries();
    let firstHitLo: number | null = null;
    for (const e of entries) {
      if (e.k !== "native.headerUpdate" || e.d.navId !== navId || e.d.vcToken !== token) continue;
      if (windowMembership(e, startT, endT) !== "in") continue;
      if (firstHitLo === null || e.tLo < firstHitLo) firstHitLo = e.tLo;
    }
    const quiet = windowAbsence(entries, startT, endT, (e) => P5_QUIET_BREAKERS.has(e.k)) === "absent";
    const valid = boundary.accepted && windowSequenceValid(timebase, startT, endT);
    const overflowed = nativeOverflowTotal !== overflowBefore;
    if (overflowed) markProbeFault("native overflow in Header calib window");
    const drainOk = !overflowed && probeFaults === faultsBefore && launchInvalid === null;
    const result: P5WindowResult = {
      hit: firstHitLo !== null,
      quiet,
      valid,
      drainOk,
      latencyMs: firstHitLo === null ? null : firstHitLo - startT,
      stale,
      interrupted,
    };
    ring.push("diag.mark", {
      label: "headerCalibEval",
      phase,
      launchNo,
      visitNo,
      tapToMarkerMs: null,
      ...result,
    });
    return result;
  }

  /** 6 P5 (v11): the single decision from both retained window results, in contract precedence. */
  function decideC2(setResult: P5WindowResult, restoreResult: P5WindowResult, op: ActiveP5): void {
    if (launchInvalid !== null || !setResult.drainOk || !restoreResult.drainOk) {
      // PROBE INVALID (19): the latch already owns the status line and the message.
      calibLocked = true;
      return;
    }
    if (calibLocked) return;
    if (
      !setResult.valid ||
      !setResult.quiet ||
      !restoreResult.valid ||
      !restoreResult.quiet ||
      setResult.interrupted ||
      restoreResult.interrupted ||
      lifecycleGen !== op.gen
    ) {
      setStatus({ calibration: calibrationStatus("C1/C3/C4 OK, C2 pending (repeat Header calib)") });
      say("Header calib interrupted. Reopen the recipe, wait for Ready, tap Header calib again.");
      return;
    }
    if (!setResult.hit) {
      calibLocked = true;
      setStatus({ calibration: calibrationStatus("INVALID: C2.set") });
      say("PROBE INVALID: C2 failed, header evidence unavailable (19).");
      return;
    }
    if (!restoreResult.hit) {
      calibLocked = true;
      setStatus({ calibration: calibrationStatus("INVALID: C2.restore") });
      say("PROBE INVALID: C2 restore failed, header state unverified (19).");
      return;
    }
    c2Passed = true;
    c2SetLatencyMs = setResult.latencyMs;
    c2RestoreLatencyMs = restoreResult.latencyMs;
    setStatus({ calibration: calibrationStatus("C2 OK, post-P5 sample pending") });
    say(C2_PASS_MESSAGE);
    void persistTrace(buildExport());
  }

  /**
   * 6 P5 (v11): Header calib. Preconditions are messages only (nothing
   * recorded). Set phase -> 1 s window -> restore (through the setter captured
   * here, whatever is registered later) -> 1 s window -> one decision.
   */
  function headerCalib(): void {
    if (busy) return;
    // A latched launch shows only the plain-language stop (19); P5 never runs.
    if (launchInvalid !== null) return;
    if (calibLocked) {
      say(CALIB_LOCKED_MESSAGE);
      return;
    }
    if (pinnedNavId === null) {
      say("Header calib needs C1/C3/C4 first (P2-P4 on this launch).");
      return;
    }
    const setter = navDiagnostics.getHeaderCalib();
    if (!setter) {
      say("Header calib needs an open recipe detail.");
      return;
    }
    if (status().visitMode.kind !== "calibration") {
      say("Header calib needs a calibration visit (Kind: calibration).");
      return;
    }
    if (headerCalibActive) {
      say("Header calib in progress, wait.");
      return;
    }
    if (calibPending || calibArmed || calibEvalPending) {
      say("Header calib must wait: finish the Back first (or reopen the recipe).");
      return;
    }
    if (c2Passed) {
      // 6 (v11 / H6): C2 is session-once; a repeat is refused (the header-hook
      // exception is handled at initialisation).
      say("C2 already passed this session. Tap Calib for the next sample.");
      return;
    }
    if (!eligibility().eligible) {
      say("Header calib needs a Ready calibration visit.");
      return;
    }
    if (currentVisit === null) {
      say("Header calib needs an open recipe detail.");
      return;
    }
    const navId = pinnedNavId;
    // A3 / H1: ownership is bound synchronously at the tap (visit, route,
    // generation, setter, operation id); arms are refused from this point.
    p5Counter += 1;
    const op: ActiveP5 = {
      id: p5Counter,
      visitNo: currentVisit.visitNo,
      routeKey: currentVisit.routeKey,
      gen: lifecycleGen,
    };
    activeP5 = op;
    headerCalibActive = true;
    refreshEligibility();
    const baselineAtTap = { overflow: nativeOverflowTotal, faults: probeFaults };
    busy = true;
    const abandon = (message: string): void => {
      // A preparation that no longer owns the current visit (the visit closed or
      // was replaced) is inert: it changes neither status, message nor readiness
      // of the newer visit. An owning operation reports the interruption unless a
      // lock or latch already governs the status.
      const owns = activeP5 !== null && activeP5.id === op.id;
      if (!owns) return;
      activeP5 = null;
      headerCalibActive = false;
      if (launchInvalid === null && !calibLocked) {
        setStatus({ calibration: calibrationStatus("C1/C3/C4 OK, C2 pending (repeat Header calib)") });
        say(message);
      }
      refreshEligibility();
    };
    void (async () => {
      let released = false;
      try {
        // 7.5.6: a drain is preceded by a snapshot; the visit's push record
        // must be in the JS ring before the token can be resolved.
        await snapshot("headerCalibPre");
        await drainNative();
        if (stopped) return;
        // H1: revalidate every tap-time condition after the awaits.
        const sameVisit =
          currentVisit !== null && currentVisit.visitNo === op.visitNo && currentVisit.routeKey === op.routeKey;
        if (
          launchInvalid !== null ||
          calibLocked ||
          !sameVisit ||
          !visitOpen ||
          !appActive ||
          lifecycleGen !== op.gen ||
          status().visitMode.kind !== "calibration" ||
          calibPending ||
          calibArmed ||
          calibEvalPending ||
          nativeOverflowTotal !== baselineAtTap.overflow ||
          activeP5 === null ||
          activeP5.id !== op.id
        ) {
          abandon("Header calib interrupted. Reopen the recipe, wait for Ready, tap Header calib again.");
          return;
        }
        const token = resolveVisitDetailToken(navId);
        if (token === null) {
          abandon("Header calib needs a fresh calibration visit (reopen the recipe).");
          return;
        }
        ring.push("diag.mark", { label: "headerCalib", phase: "set", launchNo, visitNo: op.visitNo, tapToMarkerMs: null });
        // H6: the title is modified on this launch from here on: the post-P5
        // sample is required whatever the outcome of the windows.
        p5RanThisLaunch = true;
        const tSet = nowMs();
        setter(true);
        busy = false;
        released = true;
        after(HEADER_CALIB_WINDOW_MS, () => {
          void (async () => {
            const setResult = await evaluateP5Window("set", tSet, navId, token, op, baselineAtTap);
            // Restore on every set outcome, through the captured setter.
            ring.push("diag.mark", { label: "headerCalib", phase: "restore", launchNo, visitNo: op.visitNo, tapToMarkerMs: null });
            const baselineAfterSet = { overflow: nativeOverflowTotal, faults: probeFaults };
            const tRestore = nowMs();
            setter(false);
            after(HEADER_CALIB_WINDOW_MS, () => {
              void (async () => {
                const restoreResult = await evaluateP5Window("restore", tRestore, navId, token, op, baselineAfterSet);
                // A stale P5 (its visit closed or replaced) changes nothing for the newer visit.
                if (setResult.stale || restoreResult.stale) return;
                activeP5 = null;
                headerCalibActive = false;
                decideC2(setResult, restoreResult, op);
                refreshEligibility();
              })();
            });
          })();
        });
      } finally {
        if (!released) busy = false;
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Capture (9.2) and appendices (9.3 / 9.4)
  // -------------------------------------------------------------------------

  function findLastAttempt(visitNo: number): TraceEntry | null {
    const entries = ring.entries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (e && e.k === "diag.backAttempt" && e.d.visitNo === visitNo) return e;
    }
    return null;
  }

  function backDead(): void {
    const st = status();
    if (busy || st.phase === "capturing" || st.phase === "swipeWindow" || st.phase === "jsBackWindow") {
      return;
    }
    // 8.2 / 9.1: the immutable capture is replaced only by the NEXT incident
    // (a later visit); a repeated press in the same visit must not overwrite
    // the first failure or its appendices.
    if (capture !== null && captureVisitNo === st.visitNo) {
      say(`Back dead already captured for visit ${st.visitNo}; continue with Swipe now / JS back.`);
      return;
    }
    const markT = nowMs();
    const attempt = findLastAttempt(st.visitNo);
    const tapToMarkerMs = attempt ? markT - attempt.t : null;
    const anchored = tapToMarkerMs !== null && tapToMarkerMs <= BACK_DEAD_MAX_ANCHOR_MS;
    ring.push(
      "diag.mark",
      { label: "backDead", launchNo, visitNo: st.visitNo, tapToMarkerMs, anchored },
      markT,
    );
    setStatus({ phase: "capturing", shareText: null });
    say(anchored ? "Capturing, hold still" : "UNANCHORED (V5). Capturing, hold still");
    void runDeadCapture(attempt);
  }

  async function runDeadCapture(attempt: TraceEntry | null): Promise<void> {
    ring.push("diag.capture", { phase: "start" });
    await snapshot(`dead${DEAD_SNAPSHOT_OFFSETS_MS[0]}`);
    after(DEAD_SNAPSHOT_OFFSETS_MS[1], () => {
      void snapshot(`dead${DEAD_SNAPSHOT_OFFSETS_MS[1]}`);
    });
    after(DEAD_SNAPSHOT_OFFSETS_MS[2], () => {
      void (async () => {
        const dead2000 = await snapshot(`dead${DEAD_SNAPSHOT_OFFSETS_MS[2]}`);
        await drainNative();
        // 9.2 (5): the attempt window [diag.backAttempt.t, dead2000.t] is
        // judged now (7.5.7); the escape windows are judged when they close.
        windowFlags.attempt =
          attempt === null ? null : windowSequenceValid(timebase, attempt.t, dead2000.jsMid);
        windowFlags.swipe = null;
        windowFlags.jsBack = null;
        ring.push("diag.capture", { phase: "write" });
        const record: CaptureRecord = {
          header: buildHeader(windowFlags),
          capturedAt: new Date().toISOString(),
          entries: ring.sorted(),
          appendices: [],
        };
        const ok = await persistCapture(record);
        if (!ok) {
          ring.push("diag.capture", { phase: "writeFailed" });
          setStatus({ phase: "idle" });
          say("SAVE FAILED (read-back). Tap Back dead again.");
          return;
        }
        capture = record;
        captureVisitNo = status().visitNo;
        ring.push("diag.capture", { phase: "saved" });
        const json = JSON.stringify(record);
        await copyToClipboard(json);
        setStatus({ phase: "captured", shareText: json });
        say("Captured and saved. Next: Swipe now, then one edge-swipe.");
      })();
    });
  }

  /**
   * Exact observation window [startT, startT + windowMs] closed at
   * boundarySeq (9.3 / 9.4): JS records by exact time before the boundary,
   * native records by interval membership (context only, never classified),
   * plus the probe's own closing records after the boundary.
   */
  function collectWindow(startT: number, windowMs: number, boundarySeq: number) {
    return selectWindowEntries(ring.entries(), startT, startT + windowMs, boundarySeq);
  }

  async function appendToCapture(label: CaptureAppendixLabel, entries: TraceEntry[]): Promise<void> {
    if (!capture) {
      say("No capture in memory; appendix not written.");
      return;
    }
    // Earlier content is never removed; the header's overflow accounting,
    // calibration/probe-fault status and window flags are refreshed so the
    // INVALID labels (7.3, 19) cover anything that happened during the
    // escape probes.
    const next: CaptureRecord = {
      ...capture,
      header: {
        ...capture.header,
        calibrationStatus: status().calibration,
        escapeWindowsSequenceValid: { swipe: windowFlags.swipe, jsBack: windowFlags.jsBack },
        timebaseAnchors: timebase.anchors.length,
        timebaseGaps: timebase.gaps,
        epochCount: epochCount(timebase),
        jsOverflow: ring.overflow,
        nativeOverflow: nativeOverflowTotal,
      },
      appendices: [...capture.appendices, { label, entries }],
    };
    const ok = await persistCapture(next);
    if (!ok) {
      setStatus({ phase: "captured" });
      say(`SAVE FAILED (${label} appendix). Retry.`);
      return;
    }
    capture = next;
    const overflowNote =
      next.header.jsOverflow > 0 || next.header.nativeOverflow > 0 || probeFaults > 0
        ? " INVALID FOR SEQUENCE CLAIMS (overflow or probe fault)."
        : "";
    setStatus({
      phase: label === "swipe" ? "swipeSaved" : "jsBackSaved",
      shareText: JSON.stringify(next),
    });
    say(
      (label === "swipe"
        ? "Saved. Next: JS back (only if still on the detail)."
        : "Saved. Force-quit only if trapped; then Settings > Export last Back failure.") + overflowNote,
    );
  }

  // Binding order (12): Back dead -> Swipe now -> JS back, each once.
  function swipeNow(): void {
    if (busy || status().phase !== "captured") return;
    const startT = nowMs();
    ring.push("diag.swipe", { phase: "start" }, startT);
    setStatus({ phase: "swipeWindow" });
    say("Swipe now: ONE left-edge swipe within 3 s.");
    void (async () => {
      const pre = (await snapshot("swipePre")).snap;
      let late: ProbeSnapshot | null = null;
      after(SWIPE_SNAPSHOT_OFFSETS_MS[0], () => {
        void snapshot(`swipe${SWIPE_SNAPSHOT_OFFSETS_MS[0]}`);
      });
      after(SWIPE_SNAPSHOT_OFFSETS_MS[1], () => {
        void (async () => {
          late = (await snapshot(`swipe${SWIPE_SNAPSHOT_OFFSETS_MS[1]}`)).snap;
        })();
      });
      after(SWIPE_WINDOW_MS, () => {
        // The window closes synchronously at the boundary: JS records pushed
        // after this sequence number are outside it; native records count by
        // their own declared intervals. The boundary anchor (7.5.6 / 7.5.7)
        // precedes the drain.
        const boundarySeq = ring.lastSeq();
        void (async () => {
          await snapshot(`swipe${SWIPE_WINDOW_MS}`);
          await drainNative();
          windowFlags.swipe = windowSequenceValid(timebase, startT, startT + SWIPE_WINDOW_MS);
          const { windowEntries } = collectWindow(startT, SWIPE_WINDOW_MS, boundarySeq);
          const outcome = computeSwipeOutcome({ windowEntries, pre, late });
          ring.push("diag.swipe", { phase: "end", outcome });
          await appendToCapture(
            "swipe",
            collectWindow(startT, SWIPE_WINDOW_MS, boundarySeq).appendixEntries,
          );
        })();
      });
    })();
  }

  function jsBack(): void {
    if (busy || status().phase !== "swipeSaved") return;
    setStatus({ phase: "jsBackWindow" });
    say("JS back: observing for 3 s, hold still.");
    void (async () => {
      const pre = (await snapshot("jsBackPre")).snap;
      const rootPre = deps.container.getRootState();
      const focused = findFocusedStack(rootPre);
      const indexPre = focused?.index ?? -1;
      const signaturePre = stateSignature(rootPre);
      const startT = nowMs();
      ring.push(
        "diag.jsBack",
        {
          phase: "start",
          focusedNavKey: focused?.navKey ?? null,
          focusedNavName: focused?.navName ?? null,
          indexPre,
          routeKeyPre: focused?.routeKey ?? null,
          routesLenPre: focused?.routesLen ?? 0,
        },
        startT,
      );
      const window: JsBackWindowState = {
        deadlineT: startT + JS_BACK_WINDOW_MS,
        actionEvent: null,
        stateEvents: 0,
        lastSignature: signaturePre,
        dispatchError: false,
      };
      jsBackWindow = window;
      try {
        deps.routerBack();
      } catch {
        window.dispatchError = true;
        ring.push("diag.jsBack", { phase: "dispatchError" });
      }
      after(JS_BACK_SNAPSHOT_OFFSETS_MS[0], () => {
        void snapshot(`jsBack${JS_BACK_SNAPSHOT_OFFSETS_MS[0]}`);
      });
      after(JS_BACK_SNAPSHOT_OFFSETS_MS[1], () => {
        void snapshot(`jsBack${JS_BACK_SNAPSHOT_OFFSETS_MS[1]}`);
      });
      after(JS_BACK_WINDOW_MS, () => {
        // The window closes synchronously at the boundary: the event counts
        // and the container state are frozen here, before the asynchronous
        // jsBack3000 snapshot and drain resolve.
        const closed: JsBackWindowState = { ...window };
        jsBackWindow = null;
        const boundarySeq = ring.lastSeq();
        // Final change is judged on the last IN-WINDOW state event, so a late
        // boundary callback cannot read a state that moved after the deadline.
        const finalChange = closed.lastSignature !== signaturePre;
        void (async () => {
          const post = (await snapshot(`jsBack${JS_BACK_WINDOW_MS}`)).snap;
          await drainNative();
          windowFlags.jsBack = windowSequenceValid(timebase, startT, startT + JS_BACK_WINDOW_MS);
          // Phase 3 rows are defined on the pinned controller with both
          // boundary snapshots (10); anything less is INVALID, never C or D.
          let invalidReason: string | null = null;
          if (focused === null || focused.routeKey === null || !Number.isInteger(indexPre) || indexPre < 0) {
            invalidReason = "focusedStackMissing";
          } else if (pinnedNavId === null) {
            invalidReason = "noPinnedController";
          } else if (pre === null || post === null) {
            invalidReason = "snapshotUnavailable";
          } else if (pre.navId !== pinnedNavId || post.navId !== pinnedNavId) {
            invalidReason = "otherController";
          }
          const observation: JsBackObservation = {
            dispatchError: closed.dispatchError,
            actionEvent: closed.actionEvent,
            stateEventCount: closed.stateEvents,
            finalChange,
            nativePopped: pre !== null && post !== null && post.vcCount < pre.vcCount,
            indexPre: invalidReason === null ? indexPre : -1,
          };
          const outcome = classifyJsBack(observation);
          ring.push("diag.jsBack", {
            phase: "end",
            outcome,
            invalidReason,
            indexPre,
            actionObserved: observation.actionEvent !== null,
            noop: observation.actionEvent?.noop ?? null,
            stateEvents: observation.stateEventCount,
            finalChange: observation.finalChange,
            nativePopped: observation.nativePopped,
            coordinatorPre: pre?.coordinatorPresent ?? null,
            coordinatorPost: post?.coordinatorPresent ?? null,
          });
          await appendToCapture(
            "jsBack",
            collectWindow(startT, JS_BACK_WINDOW_MS, boundarySeq).appendixEntries,
          );
        })();
      });
    })();
  }

  // -------------------------------------------------------------------------
  // Exports (8.4) and arm boundary (7.2)
  // -------------------------------------------------------------------------

  async function exportTrace(reset: boolean): Promise<void> {
    if (busy) return;
    if (reset && calibrationInProgress()) {
      // H3: the arm-boundary reset would erase calibration evidence mid-flight.
      say("Arm end must wait: calibration in progress.");
      return;
    }
    busy = true;
    try {
      await snapshot("export");
      await drainNative();
      const exported = buildExport();
      const ok = await persistTrace(exported);
      const json = JSON.stringify(exported);
      const copied = await copyToClipboard(json);
      // 7.2 arm boundary: the ring (and the native overflow accounting it
      // reported) reset only once the export is verified on disk.
      if (reset && ok) {
        ring.reset();
        nativeOverflowTotal = 0;
        const mode: VisitMode = { ...status().visitMode, cycle: 0 };
        setStatus({ visitMode: mode });
      }
      const invalid =
        exported.header.jsOverflow > 0 || exported.header.nativeOverflow > 0 || probeFaults > 0;
      setStatus({ shareText: json });
      say(
        `${reset ? (ok ? "Arm ended: trace" : "Arm NOT ended (ring kept): trace") : "Trace"} ${copied ? "copied" : "NOT copied"}${ok ? "" : ", persist FAILED"}${invalid ? " (INVALID FOR SEQUENCE CLAIMS: overflow or probe fault)" : ""}`,
      );
    } finally {
      busy = false;
    }
  }

  async function exportLastFailure(): Promise<void> {
    const json = navDiagnostics.getLastCaptureJson();
    if (json === null) {
      say("No Back failure capture stored.");
      return;
    }
    const copied = await copyToClipboard(json);
    setStatus({ shareText: json });
    say(copied ? "Last Back failure copied." : "Copy FAILED.");
  }

  async function deleteData(): Promise<void> {
    const result = await deleteDiagnosticData();
    if (result.captureRemoved) capture = null;
    setStatus({ shareText: null });
    say(
      result.captureRemoved && result.traceRemoved
        ? "Diagnostic data deleted."
        : `Delete INCOMPLETE: capture ${result.captureRemoved ? "removed" : "FAILED"}, trace ${result.traceRemoved ? "removed" : "FAILED"}.`,
    );
  }

  function share(): void {
    const text = status().shareText;
    if (!text) return;
    void Share.share({ message: text }).catch(() => undefined);
  }

  function setVisitMode(patch: Partial<VisitMode>): void {
    const previous = status().visitMode;
    const mode: VisitMode = { ...previous, ...patch };
    setStatus({ visitMode: mode });
    if (mode.kind !== previous.kind && (calibArmed || calibPending)) {
      // H4: an arm after a Kind change is not a calibration attempt and is never
      // evaluated; an unresolved S-pre belongs to the cancelled operation and can
      // no longer arm, even if the Kind changes back before it resolves.
      calibArmed = false;
      calibPending = false;
      calibOp = null;
      sPre = null;
      say("Calib cancelled (Kind changed). Tap Calib again on a calibration visit.");
    }
    refreshEligibility();
    // The pill lives on the detail, so a mode set during a visit re-emits
    // that visit's ui.detailMount with the corrected fields; adjudication
    // reads the LAST ui.detailMount of a visitNo.
    if (currentVisit) {
      ring.push("ui.detailMount", {
        routeKey: currentVisit.routeKey,
        recipeId: currentVisit.recipeId,
        launchNo: currentVisit.launchNo,
        visitNo: currentVisit.visitNo,
        visitKind: mode.kind,
        arm: mode.arm,
        cycle: mode.cycle,
        anchor: mode.anchor,
      });
    }
  }

  const controller: DiagnosticsController = {
    backDead,
    swipeNow,
    jsBack,
    calib,
    headerCalib,
    exportTrace: () => {
      void exportTrace(false);
    },
    armEnd: () => {
      void exportTrace(true);
    },
    exportLastFailure: () => {
      void exportLastFailure();
    },
    deleteData: () => {
      void deleteData();
    },
    share,
    setVisitMode,
  };

  return {
    start(): void {
      ring.setArmGate(armGate);
      unsubs.push(navDiagnostics.subscribeRecords(onRecord));
      unsubs.push(deps.container.addListener("state", onState));
      unsubs.push(deps.container.addListener("__unsafe_action__", onAction));
      const appStateSub = AppState.addEventListener("change", onAppState);
      unsubs.push(() => appStateSub.remove());
      // The controller is registered at the end of initialise() (8.3).
      void initialise();
    },
    stop(): void {
      stopped = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      ring.setArmGate(null);
      if (navDiagnostics.getController() === controller) navDiagnostics.setController(null);
      void deps.probe?.disable().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Renders nothing; owns the diagnostics lifecycle for the process. */
export function NavDiagnosticsRoot() {
  const containerRef = useNavigationContainerRef();
  useEffect(() => {
    const owner = createRootOwner({
      container: containerRef as unknown as NavContainerLike,
      probe: getNavProbe(),
      routerBack: () => router.back(),
    });
    owner.start();
    return () => owner.stop();
  }, [containerRef]);
  return null;
}

/** app/_layout.tsx mount point: nothing exists unless the flag is "1". */
export function NavDiagnosticsRootGate() {
  return isNavDiagnosticsEnabled() ? <NavDiagnosticsRoot /> : null;
}
