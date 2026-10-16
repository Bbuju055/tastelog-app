/**
 * NavProbe: JS boundary of the Build 5 Class B native-Back diagnostic probe
 * (docs/build5-classb-native-back-diagnostic-plan.md section 5).
 *
 * The native module is optional at runtime: `getNavProbe()` returns null when
 * the module is not compiled in (Jest, web, a build without the module), so
 * callers degrade to "probe absent" instead of throwing. Every native function
 * is an AsyncFunction forced onto the main queue (section 5.1); nothing here is
 * synchronous.
 */
// expo-modules-core is the Expo SDK core the plan pins (F2, 3.0.29). The
// `expo` entry point cannot be used here: its side-effect import graph
// (expo-asset) is not transformed by the read-only Jest config.
import { requireOptionalNativeModule } from "expo-modules-core";

export type ProbeHookState = "installed" | "absent" | "failed";

/** Native payload of `enable()` (section 5.1, minus the JS-side anchor). */
export type NativeEnableResult = {
  popHooks: ProbeHookState;
  headerHook: ProbeHookState;
  ios26: boolean;
  navId: string | null;
  nativeTimebaseAnchorS: number;
};

/** EnableResult as recorded in the trace header (section 5.1 / 5.8). */
export type EnableResult = NativeEnableResult & { jsTimebaseAnchorMs: number };

/** Read-only UIKit inspection (section 5.3). */
export type ProbeSnapshot = {
  navId: string | null;
  vcCount: number;
  topVCClass: string | null;
  topIsBeingDismissed: boolean;
  coordinatorPresent: boolean;
  coordinatorInteractive: boolean;
  coordinatorCancelled: boolean;
  navBarEnabled: boolean;
  windowEnabled: boolean;
  contentViewFound: boolean;
  wrapperFound: boolean;
  wrapperClass: string | null;
  wrapperToken: string | null;
  wrapperEnabled: boolean;
  wrapperSuperEnabled: boolean;
  hidesBackButton: boolean;
  leftItemPresent: boolean;
  rightItemPresent: boolean;
  titleViewPresent: boolean;
  presentedVCClass: string | null;
  popGestureState: number;
  contentPopGestureState: number;
  nativeTimeS: number;
};

export type NativeRecordKind = "shouldPop" | "didPop" | "headerUpdate";

/** One drained native ring record (section 5.4 / 5.5), strings only here. */
export type NativeRecord = {
  kind: NativeRecordKind;
  nativeTimeS: number;
  navId: string;
  itemToken: string;
  wrapperToken: string;
  vcToken: string;
  coordinatorPresent: boolean;
  wrapperFound: boolean;
  wrapperEnabledBefore: boolean;
  wrapperEnabledAfter: boolean;
  result: boolean;
  animated: boolean;
};

/** `drain()` returns the records and the overflow count, then resets both (5.7). */
export type DrainResult = { records: NativeRecord[]; overflow: number };

export type NavProbeNative = {
  enable(sessionToken: string): Promise<NativeEnableResult>;
  snapshot(reason: string): Promise<ProbeSnapshot>;
  drain(): Promise<DrainResult>;
  disable(): Promise<void>;
};

let cached: NavProbeNative | null | undefined;

/** Resolves the native module once; null when it is not compiled in. */
export function getNavProbe(): NavProbeNative | null {
  if (cached === undefined) {
    cached = requireOptionalNativeModule<NavProbeNative>("NavProbe");
  }
  return cached;
}
