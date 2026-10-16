/**
 * Build 5 Class B native-Back diagnostic: screen-side hook and operator pill.
 * Authority: docs/build5-classb-native-back-diagnostic-plan.md (sections
 * 4.B.10, 6, 7.1, 9.0). INTERNAL TESTFLIGHT DIAGNOSTIC ONLY.
 *
 * `useNavDiagnosticsScreen` wires the recipe detail's screen listeners
 * (transitionStart/End, gestureCancel, focus, blur), writes the visit's
 * ui.detailMount record, mirrors guard-lock and toast transitions, and
 * registers the header-calibration action (P5). With the flag off it attaches
 * nothing: no listeners, no records, no store access.
 *
 * `NavDiagnosticsPill` is the operator surface on the detail. "Back arm" is
 * the section 9.0 anchor: ONE synchronous ring write from the press handler,
 * then a pill-local re-render only (no detail or root state, no navigation
 * action, no setOptions, no haptic, no animation). Every other button calls
 * the root-owned controller.
 */
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { NavigationContext, NavigationRouteContext } from "@react-navigation/native";

import {
  BACK_ARM_WINDOW_MS,
  isNavDiagnosticsEnabled,
  navDiagnostics,
  type Anchor,
  type Arm,
  type TraceEntryKind,
  type VisitKind,
} from "./navTrace";

// ---------------------------------------------------------------------------
// Screen hook
// ---------------------------------------------------------------------------

type ScreenEvent = { data?: unknown };

/** The subset of the native-stack navigation object the hook touches. */
type ScreenNavigation = {
  addListener(type: string, callback: (e: ScreenEvent) => void): () => void;
  setOptions(options: object): void;
};

const SCREEN_EVENTS: [string, TraceEntryKind][] = [
  ["transitionStart", "scr.transitionStart"],
  ["transitionEnd", "scr.transitionEnd"],
  ["gestureCancel", "scr.gestureCancel"],
  ["focus", "scr.focus"],
  ["blur", "scr.blur"],
];

export type NavDiagnosticsScreenOptions = {
  recipeId: string | undefined;
  guardLocked: boolean;
  toastVisible: boolean;
  /**
   * P5 (v11): set (active = true) or restore (active = false) the header
   * config's title through navigation.setOptions; the root calls the
   * reference registered by the visit that started P5.
   */
  setHeaderCalibTitle: (active: boolean, setOptions: (options: object) => void) => void;
};

export function useNavDiagnosticsScreen(options: NavDiagnosticsScreenOptions): {
  enabled: boolean;
  routeKey: string | null;
} {
  const enabled = isNavDiagnosticsEnabled();
  // Contexts (never hooks that throw): undefined outside a navigator.
  const navigation = useContext(NavigationContext) as unknown as ScreenNavigation | undefined;
  const route = useContext(NavigationRouteContext);
  const routeKey = route?.key ?? null;
  const { recipeId, guardLocked, toastVisible } = options;
  const setterRef = useRef(options.setHeaderCalibTitle);
  setterRef.current = options.setHeaderCalibTitle;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let unsubStatus: (() => void) | null = null;

    // ui.detailMount carries launchNo, which the root resolves from storage;
    // on the launch's first visit the record waits for that initialisation
    // and says so (deferred: its timestamp is the initialisation time, not
    // the mount time).
    const writeMount = (deferred: boolean) => {
      const visit = navDiagnostics.beginVisit();
      navDiagnostics.record("ui.detailMount", {
        routeKey,
        recipeId: recipeId ?? null,
        launchNo: visit.launchNo,
        visitNo: visit.visitNo,
        visitKind: visit.visitMode.kind,
        arm: visit.visitMode.arm,
        cycle: visit.visitMode.cycle,
        anchor: visit.visitMode.anchor,
        deferred,
      });
    };
    if (navDiagnostics.getStatus().initialised) {
      writeMount(false);
    } else {
      unsubStatus = navDiagnostics.subscribe(() => {
        if (cancelled || !navDiagnostics.getStatus().initialised) return;
        unsubStatus?.();
        unsubStatus = null;
        writeMount(true);
      });
    }

    const unsubs: (() => void)[] = [];
    if (navigation) {
      for (const [event, kind] of SCREEN_EVENTS) {
        unsubs.push(
          navigation.addListener(event, (e) => {
            const closing = (e?.data as { closing?: boolean } | undefined)?.closing;
            navDiagnostics.record(
              kind,
              closing === undefined ? { routeKey } : { routeKey, closing },
            );
          }),
        );
      }
      navDiagnostics.registerHeaderCalib((active) => {
        setterRef.current(active, (opts) => navigation.setOptions(opts));
      });
    }

    return () => {
      cancelled = true;
      unsubStatus?.();
      for (const unsub of unsubs) unsub();
      navDiagnostics.registerHeaderCalib(null);
    };
  }, [enabled, navigation, routeKey, recipeId]);

  useEffect(() => {
    if (!enabled) return;
    navDiagnostics.record("guard", { locked: guardLocked });
  }, [enabled, guardLocked]);

  const toastSeenRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (toastVisible) {
      toastSeenRef.current = true;
      navDiagnostics.record("toast.show", {});
    } else if (toastSeenRef.current) {
      navDiagnostics.record("toast.dismiss", {});
    }
  }, [enabled, toastVisible]);

  return { enabled, routeKey };
}

// ---------------------------------------------------------------------------
// Pill
// ---------------------------------------------------------------------------

const KINDS: VisitKind[] = ["calibration", "priming", "trial"];
const ARMS: Arm[] = ["A", "B", "C", "D"];
const ANCHORS: Anchor[] = ["A1", "A2", "A3", "A4"];

function next<T>(list: T[], current: T): T {
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length] ?? current;
}

export function NavDiagnosticsPill({ routeKey }: { routeKey: string | null }) {
  const status = useSyncExternalStore(navDiagnostics.subscribe, navDiagnostics.getStatus);
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    },
    [],
  );

  // Section 9.0: one synchronous ring write, then a pill-local re-render.
  // The visual "armed" state lasts the 3 s native-Back window only; the
  // 10 s dead-marker bound (9.1) is measured by the root from the record.
  const onBackArm = () => {
    const st = navDiagnostics.getStatus();
    if (!st.initialised) return;
    const accepted = navDiagnostics.getRing().push("diag.backAttempt", {
      launchNo: st.launchNo,
      visitNo: st.visitNo,
      navId: st.navId,
      routeKey,
    });
    // 9.0a: a refused arm (null) enters no armed state.
    if (accepted === null) return;
    setArmed(true);
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => {
      armTimerRef.current = null;
      setArmed(false);
    }, BACK_ARM_WINDOW_MS);
  };

  // Controls are inert until the root has hydrated the last capture and
  // enabled the probe (8.3): the controller is registered only then.
  const call = (fn: (c: NonNullable<ReturnType<typeof navDiagnostics.getController>>) => void) => {
    const controller = navDiagnostics.getController();
    if (controller && navDiagnostics.getStatus().initialised) fn(controller);
  };

  const clearArmed = () => {
    if (armTimerRef.current !== null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setArmed(false);
  };

  const mode = status.visitMode;
  const buttons: { label: string; onPress: () => void }[] = [
    { label: "Back arm", onPress: onBackArm },
    {
      label: "Back dead",
      onPress: () => {
        clearArmed();
        call((c) => c.backDead());
      },
    },
    { label: "Swipe now", onPress: () => call((c) => c.swipeNow()) },
    { label: "JS back", onPress: () => call((c) => c.jsBack()) },
    { label: "Calib", onPress: () => call((c) => c.calib()) },
    { label: "Header calib", onPress: () => call((c) => c.headerCalib()) },
    { label: "Trace", onPress: () => call((c) => c.exportTrace()) },
    { label: "Arm end", onPress: () => call((c) => c.armEnd()) },
    { label: "Share", onPress: () => call((c) => c.share()) },
    {
      label: `Kind: ${mode.kind}`,
      onPress: () => call((c) => c.setVisitMode({ kind: next(KINDS, mode.kind) })),
    },
    {
      label: `Arm: ${mode.arm}`,
      onPress: () => call((c) => c.setVisitMode({ arm: next(ARMS, mode.arm) })),
    },
    {
      label: `Anchor: ${mode.anchor}`,
      onPress: () => call((c) => c.setVisitMode({ anchor: next(ANCHORS, mode.anchor) })),
    },
  ];

  return (
    <View testID="nav-diag-pill" style={styles.pill} accessibilityLabel="Navigation diagnostics">
      <Text style={styles.line}>{status.probeLine}</Text>
      <Text style={styles.line}>
        {`Calib: ${status.calibration} | L${status.launchNo} V${status.visitNo} ${mode.kind} ${mode.arm} c${mode.cycle} ${mode.anchor}`}
      </Text>
      <Text style={styles.message}>{`${status.message}${armed ? " [armed]" : ""}`}</Text>
      <View style={styles.row}>
        {buttons.map((b) => (
          <Pressable
            key={b.label}
            onPress={b.onPress}
            style={styles.button}
            accessibilityRole="button"
            testID={`nav-diag-${b.label.split(":")[0]?.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <Text style={styles.buttonText}>{b.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 24,
    backgroundColor: "rgba(20, 20, 20, 0.92)",
    borderRadius: 12,
    padding: 8,
  },
  line: {
    color: "#FFFFFF",
    fontSize: 11,
    fontFamily: "monospace",
  },
  message: {
    color: "#FFD966",
    fontSize: 11,
    fontFamily: "monospace",
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  button: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#3A3A3A",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 11,
  },
});
