/**
 * Build 5 Class B diagnostic (section 4.D.17): gating, capture order,
 * observation windows, GO_BACK probe semantics, Settings rows and the
 * "Back arm" inertness contract, exercised through the real root owner,
 * pill and detail screen with the native probe and container faked.
 * v10 (section 23.6): the 9.0a arm-eligibility / wake gate with the 500 ms
 * open-settle hold, calibration without didPop and its C1 sub-codes, the
 * 7.5 timebase (simulated device sleep = the fake native clock lags the JS
 * clock), capture-header window flags and the jsClockProvider guard.
 */
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Animated, AppState, Share } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  NavigationContext,
  NavigationRouteContext,
} from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { renderWithTheme } from "../test-utils";

// ---------------------------------------------------------------------------
// Flag (read lazily on every access so tests can flip it between mounts)
// ---------------------------------------------------------------------------
const mockFlag = { value: "0" };
jest.mock("../../lib/config", () => ({
  get env() {
    return {
      EXPO_PUBLIC_API_BASE_URL: "http://test.local",
      EXPO_PUBLIC_RIFF_STREAMING: false,
      EXPO_PUBLIC_WEB_BASE_URL: undefined,
      EXPO_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "anon",
      EXPO_PUBLIC_SENTRY_DSN: "",
      EXPO_PUBLIC_NAV_DIAGNOSTICS: mockFlag.value,
    };
  },
}));

// ---------------------------------------------------------------------------
// Unified call log: storage, probe and clipboard calls in the order they
// happen, so capture ordering is asserted on one timeline.
// ---------------------------------------------------------------------------
const mockLog: string[] = [];
const mockStorage = new Map<string, string>();
/** When set, every getItem waits on it (hydration gating test). */
const mockStorageHold: { promise: Promise<void> | null } = { promise: null };

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => {
      if (mockStorageHold.promise) await mockStorageHold.promise;
      mockLog.push(`get:${key}`);
      return mockStorage.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      mockLog.push(`set:${key}`);
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockLog.push(`remove:${key}`);
      mockStorage.delete(key);
    }),
  },
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: { version: "1.0.0", ios: { buildNumber: "6" } },
    platform: { ios: { platform: "iPhone14,2", buildNumber: "6", systemVersion: "26.6" } },
  },
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async (value: string) => {
    mockLog.push("clipboard");
    mockClipboard.last = value;
    return true;
  }),
}));
const mockClipboard: { last: string | null } = { last: null };

// ---------------------------------------------------------------------------
// Native probe fake
// ---------------------------------------------------------------------------
type RawNativeRecord = {
  kind: "shouldPop" | "didPop" | "headerUpdate";
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

/**
 * Fake native clock (7.5.1): CACurrentMediaTime = 100 s + JS ms / 1000 minus
 * `nativeOffsetS`, the seconds the device has slept (the JS clock keeps
 * counting through sleep, the native clock stops).
 */
function nativeNowS(): number {
  return 100 + performance.now() / 1000 - mockProbe.nativeOffsetS;
}

async function makeSnapshot(reason: string) {
  mockLog.push(`snapshot:${reason}`);
  return {
    navId: "0xa",
    vcCount: mockProbe.vcCount,
    topVCClass: "RNSScreen",
    topIsBeingDismissed: false,
    coordinatorPresent: mockProbe.coordinatorPresent,
    coordinatorInteractive: false,
    coordinatorCancelled: false,
    navBarEnabled: true,
    windowEnabled: true,
    contentViewFound: true,
    wrapperFound: mockProbe.wrapperFound,
    wrapperClass: "_UIButtonBarButton",
    wrapperToken: "0x1",
    wrapperEnabled: mockProbe.wrapperEnabled,
    wrapperSuperEnabled: true,
    hidesBackButton: false,
    leftItemPresent: false,
    rightItemPresent: true,
    titleViewPresent: false,
    presentedVCClass: null,
    popGestureState: 0,
    contentPopGestureState: 0,
    nativeTimeS: nativeNowS(),
  };
}

const mockProbe = {
  vcCount: 2,
  coordinatorPresent: false,
  wrapperFound: true,
  wrapperEnabled: true,
  nativeOffsetS: 0,
  drainQueue: [] as RawNativeRecord[],
  drainOverflow: 0,
  drainFails: false,
  api: {
    enable: jest.fn(async (_token: string) => {
      mockLog.push("enable");
      return {
        popHooks: "installed",
        headerHook: "installed",
        ios26: true,
        navId: "0xa",
        nativeTimebaseAnchorS: 100,
      };
    }),
    snapshot: jest.fn(makeSnapshot),
    drain: jest.fn(async () => {
      mockLog.push("drain");
      if (mockProbe.drainFails) throw new Error("drain failed");
      const records = mockProbe.drainQueue;
      mockProbe.drainQueue = [];
      const overflow = mockProbe.drainOverflow;
      mockProbe.drainOverflow = 0;
      return { records, overflow };
    }),
    disable: jest.fn(async () => undefined),
  },
};

jest.mock("../../modules/nav-probe", () => ({
  getNavProbe: () => mockProbe.api,
}));

// ---------------------------------------------------------------------------
// expo-router: container ref + imperative router fakes
// ---------------------------------------------------------------------------
type Listener = (e: { data: unknown }) => void;
const mockContainer = {
  listeners: new Map<string, Set<Listener>>(),
  rootState: null as unknown,
  ref: {
    isReady: () => true,
    addListener: jest.fn((evt: string, cb: Listener) => {
      const set = mockContainer.listeners.get(evt) ?? new Set<Listener>();
      set.add(cb);
      mockContainer.listeners.set(evt, set);
      return () => {
        set.delete(cb);
      };
    }),
    getRootState: () => mockContainer.rootState,
    current: {},
  },
  emit(evt: string, data: unknown) {
    for (const cb of mockContainer.listeners.get(evt) ?? []) cb({ data });
  },
};
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockImperativeBack = jest.fn();
const mockUseNavigationContainerRef = jest.fn(() => mockContainer.ref);

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(() => ({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })),
  useRouter: jest.fn(() => ({
    push: mockRouterPush,
    back: mockRouterBack,
    navigate: jest.fn(),
  })),
  Stack: { Screen: () => null },
  useNavigationContainerRef: () => mockUseNavigationContainerRef(),
  router: { back: () => mockImperativeBack() },
}));

function makeRootState(appIndex: number) {
  const routes = [
    { key: "(tabs)-1", name: "(tabs)" },
    { key: "recipe/[id]-k1", name: "recipe/[id]", params: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" } },
  ].slice(0, appIndex + 1);
  return {
    key: "root-1",
    index: 0,
    routeNames: ["(app)"],
    routes: [
      {
        key: "(app)-1",
        name: "(app)",
        state: {
          key: "app-stack",
          type: "stack",
          index: appIndex,
          routeNames: ["(tabs)", "recipe/[id]"],
          routes,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Screen navigation fake (NavigationContext / NavigationRouteContext)
// ---------------------------------------------------------------------------
const mockNav = {
  listeners: new Map<string, Set<Listener>>(),
  api: {
    addListener: jest.fn((evt: string, cb: Listener) => {
      const set = mockNav.listeners.get(evt) ?? new Set<Listener>();
      set.add(cb);
      mockNav.listeners.set(evt, set);
      return () => {
        set.delete(cb);
      };
    }),
    removeListener: jest.fn(),
    setOptions: jest.fn(),
    dispatch: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    isFocused: () => true,
    canGoBack: () => true,
    getParent: () => undefined,
    getState: () => (makeRootState(1).routes[0] as { state: unknown }).state,
  },
  emit(evt: string, data: unknown) {
    for (const cb of mockNav.listeners.get(evt) ?? []) cb({ data });
  },
};
const mockRoute = {
  key: "recipe/[id]-k1",
  name: "recipe/[id]",
  params: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
};

// ---------------------------------------------------------------------------
// Detail-screen dependency mocks (mirrors RecipeDetailGroceryFeedback)
// ---------------------------------------------------------------------------
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({
    removeQueries: jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
    getQueryData: jest.fn(),
    setQueryData: jest.fn(),
  }),
}));

const mockRecipe = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  title: "Pasta Carbonara",
  servings: "4",
  prep_time: "10 min",
  cook_time: "20 min",
  confidence_score: 0.95,
  favorite: false,
  tags: [],
  content_rev: 1,
  ingredients: [
    {
      id: "ing-1",
      recipe_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      position: 1,
      quantity: "200",
      unit: "g",
      name: "spaghetti",
      prep: null,
      raw_text: "200g spaghetti",
    },
  ],
  steps: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const mockUseRecipe = jest.fn(() => ({
  data: mockRecipe,
  error: null,
  isLoading: false,
  refetch: jest.fn(),
}));
jest.mock("../../lib/hooks/useRecipe", () => ({
  useRecipe: () => mockUseRecipe(),
}));

jest.mock("../../lib/hooks/useDeleteRecipe", () => ({
  useDeleteRecipe: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

const mockRemakeMutate = jest.fn();
const mockPickList = jest.fn(
  (cb: (listId: string | null, wasCreated: boolean) => void) => cb("list-1", false),
);
jest.mock("../../lib/hooks", () => ({
  useRemakeGroceryList: jest.fn(() => ({ mutate: mockRemakeMutate, isPending: false })),
  useUpdateRecipeTags: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useGroceryLists: jest.fn(() => ({ lists: [], isLoading: false })),
  useGroceryPicker: jest.fn(() => ({ pickList: mockPickList })),
}));

const mockHapticTap = jest.fn();
jest.mock("../../lib/haptics/haptics", () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
  hapticTap: () => mockHapticTap(),
}));

jest.mock("../../lib/ingredients/scaleIngredient", () => ({
  scaleIngredient: jest.fn(() => ({
    kind: "numeric",
    scaled: { n: 200n, d: 1n },
    unit: "g",
    name: "spaghetti",
  })),
}));
jest.mock("../../lib/ingredients/formatIngredient", () => ({
  formatIngredient: jest.fn(() => ({
    main: "200 g spaghetti",
    prep: null,
    annotation: null,
    showNotScaled: false,
  })),
}));
jest.mock("../../lib/ingredients/parseServings", () => ({
  parseServings: jest.fn(() => 4),
}));
jest.mock("../../lib/ingredients", () => ({
  buildGroceryOverrideItems: jest.fn(() => undefined),
  shouldBlockScaledAdd: jest.fn(() => false),
}));
jest.mock("../../lib/ingredients/rational", () => ({
  make: jest.fn(() => ({ n: 1n, d: 1n })),
  ONE: { n: 1n, d: 1n },
}));
jest.mock("../../lib/hooks/useCookEvents", () => ({
  useCookEvents: jest.fn(() => ({ data: [], isLoading: false })),
}));
jest.mock("../../lib/hooks/useDeleteCookEvent", () => ({
  useDeleteCookEvent: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));
jest.mock("../../lib/auth/context", () => ({
  useSession: jest.fn(() => ({
    session: { user: { id: "user-1" } },
    signOut: jest.fn(async () => undefined),
  })),
}));

// Settings-screen dependencies
jest.mock("../../lib/api/endpoints", () => ({
  listCaptureTokens: jest.fn(async () => []),
  revokeCaptureToken: jest.fn(async () => undefined),
  createGroceryList: jest.fn(),
}));
jest.mock("../../lib/auth/storage", () => ({
  removeCaptureToken: jest.fn(async () => undefined),
  getCaptureTokenId: jest.fn(async () => null),
}));
jest.mock("../../lib/auth/tokenOrchestrator", () => ({
  provisionAndStoreCaptureToken: jest.fn(async () => ({ ok: true })),
}));

import RecipeDetailScreen from "../../app/(app)/recipe/[id]";
import SettingsScreen from "../../app/(app)/(tabs)/settings";
import { INVALID_RUN_MESSAGE, NavDiagnosticsRootGate } from "../../lib/diagnostics/NavDiagnosticsRoot";
import {
  HEADER_CALIB_TITLE,
  NAV_CAPTURE_STORAGE_KEY,
  NAV_TRACE_STORAGE_KEY,
  OPEN_SETTLE_MS,
  navDiagnostics,
  type CaptureRecord,
  type TraceEntry,
  type TraceHeader,
} from "../../lib/diagnostics/navTrace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function Harness({ children }: { children: React.ReactNode }) {
  return (
    <NavigationContext.Provider
      value={mockNav.api as unknown as NavigationProp<ParamListBase>}
    >
      <NavigationRouteContext.Provider value={mockRoute}>
        <NavDiagnosticsRootGate />
        {children}
      </NavigationRouteContext.Provider>
    </NavigationContext.Provider>
  );
}

function renderDetail() {
  return renderWithTheme(
    <Harness>
      <RecipeDetailScreen />
    </Harness>,
  );
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderWithTheme(
    <QueryClientProvider client={queryClient}>
      <Harness>
        <SettingsScreen />
      </Harness>
    </QueryClientProvider>,
  );
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

function ringEntries(): TraceEntry[] {
  return navDiagnostics.hasRing() ? navDiagnostics.getRing().entries() : [];
}

function entriesOf(kind: string): TraceEntry[] {
  return ringEntries().filter((e) => e.k === kind);
}

function storedCaptureOrNull(): CaptureRecord | null {
  const raw = mockStorage.get(NAV_CAPTURE_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as CaptureRecord) : null;
}

function storedCapture(): CaptureRecord {
  const raw = mockStorage.get(NAV_CAPTURE_STORAGE_KEY);
  if (!raw) throw new Error("capture not stored");
  return JSON.parse(raw) as CaptureRecord;
}

function logSince(marker: number): string[] {
  return mockLog.slice(marker);
}

/** Fire the root's AppState "change" listener (react-native's Jest mock records it). */
function appState(state: "active" | "background" | "inactive"): void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls as [string, (s: string) => void][];
  const listeners = calls.filter((c) => c[0] === "change").map((c) => c[1]);
  expect(listeners.length).toBeGreaterThan(0);
  act(() => {
    for (const cb of listeners) cb(state);
  });
}

/**
 * 6 P2 / 9.0a: the visit's open transition ends, the root takes the
 * visitOpen/calibOpen snapshot, and (when `settle`) the 500 ms open-settle
 * hold elapses so the pill reads "Ready".
 */
async function openVisit(settle = true): Promise<void> {
  act(() => {
    mockNav.emit("transitionEnd", { closing: false });
  });
  await flush(10);
  if (settle) await advance(OPEN_SETTLE_MS);
}

/** Mount with the flag on, wait for probe enablement, open (and settle) the visit. */
async function mountEnabled(settle = true) {
  mockFlag.value = "1";
  const utils = renderDetail();
  await flush(20);
  await openVisit(settle);
  return utils;
}

function exportedHeader(): TraceHeader {
  return (JSON.parse(mockClipboard.last ?? "{}") as { header: TraceHeader }).header;
}

/** Emit the native-dismiss chain of a healthy pop (section 6 C1, Build 6 shape: no didPop). */
type PopChainOptions = {
  didPop?: boolean;
  popAction?: boolean;
  order?: "default" | "popAfterEnd";
  /** false on a latched launch, whose operator line is the plain-language stop. */
  expectReadinessText?: boolean;
};
async function emitHealthyPop(opts: PopChainOptions = {}): Promise<void> {
  mockProbe.drainQueue.push(nativeRecord("shouldPop"));
  act(() => {
    mockNav.emit("transitionStart", { closing: true });
  });
  await advance(200);
  if (opts.didPop) {
    mockProbe.drainQueue.push(
      nativeRecord("didPop", { wrapperEnabledBefore: false, wrapperEnabledAfter: true }),
    );
  }
  mockProbe.vcCount = 1;
  const emitPop = () => {
    if (opts.popAction === false) return;
    mockContainer.emit("__unsafe_action__", { action: { type: "POP" }, noop: false });
  };
  act(() => {
    if (opts.order === "popAfterEnd") {
      mockNav.emit("transitionEnd", { closing: true });
      emitPop();
    } else {
      emitPop();
      mockNav.emit("transitionEnd", { closing: true });
    }
    mockContainer.rootState = makeRootState(0);
    mockContainer.emit("state", { state: makeRootState(0) });
  });
  await flush(10);
  await advance(300);
  await flush(10);
}

/** 5.5: the visit's push-time header record (detail VC token), queued right after the push. */
function queueVisitHeaderRecord(vcToken = "0x9"): void {
  mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true, vcToken }));
}

/** Calib -> S-pre -> Back arm -> healthy pop (one C1 sample on the open, settled visit). */
async function runSample(opts: PopChainOptions = {}): Promise<void> {
  fireEvent.press(screen.getByText("Calib"));
  await flush(10);
  fireEvent.press(screen.getByText("Back arm"));
  await advance(200);
  await emitHealthyPop(opts);
}

/** Re-push the detail, open and settle it (the next calibration visit). */
async function reopenVisit(opts: { headerToken?: string } = {}): Promise<void> {
  mockProbe.vcCount = 2;
  mockContainer.rootState = makeRootState(1);
  act(() => {
    mockContainer.emit("state", { state: makeRootState(1) });
  });
  queueVisitHeaderRecord(opts.headerToken);
  await openVisit();
}

type P5Options = {
  setRecord?: boolean;
  restoreRecord?: boolean;
  setToken?: string;
  restoreToken?: string;
  setDelayMs?: number;
  restoreDelayMs?: number;
  /** Runs inside the set window (after its record), e.g. a navigation event. */
  duringSet?: () => void | Promise<void>;
  /** Runs inside the restore window (after its record). */
  duringRestore?: () => void | Promise<void>;
};

/**
 * P5 (v11): Header calib -> pre snapshot + drain -> set window (1 s, boundary
 * snapshot, drain) -> restore -> restore window (1 s, boundary snapshot,
 * drain) -> one decision. Records are injected at the given offsets.
 */
async function runP5(opts: P5Options = {}): Promise<void> {
  fireEvent.press(screen.getByText("Header calib"));
  await flush(10);
  const setDelay = opts.setDelayMs ?? 400;
  await advance(setDelay);
  if (opts.setRecord !== false) {
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true, vcToken: opts.setToken ?? "0x9" }));
  }
  if (opts.duringSet) await opts.duringSet();
  await advance(Math.max(0, 1000 - setDelay));
  await flush(10);
  const restoreDelay = opts.restoreDelayMs ?? 400;
  await advance(restoreDelay);
  if (opts.restoreRecord !== false) {
    mockProbe.drainQueue.push(
      nativeRecord("headerUpdate", { animated: true, vcToken: opts.restoreToken ?? "0x9" }),
    );
  }
  if (opts.duringRestore) await opts.duringRestore();
  await advance(Math.max(0, 1000 - restoreDelay));
  await flush(10);
}

/** A stored rolling-trace header (8.2) for hydration cases. */
function storedTraceHeader(overrides: Partial<TraceHeader> = {}): TraceHeader {
  return {
    sessionToken: "seed",
    launchNo: 1,
    wallStart: "2026-09-01T00:00:00.000Z",
    appVersion: "1.0.0",
    appBuild: "7",
    iosVersion: "26.6",
    deviceModel: "iPhone14,2",
    flag: "1",
    probeStatus: null,
    calibrationStatus: "CALIBRATED",
    c2PassedSession: true,
    c1DidPopObserved: 0,
    jsClockProvider: "steady",
    timebaseAnchors: 4,
    timebaseGaps: 0,
    epochCount: 1,
    attemptWindowSequenceValid: null,
    escapeWindowsSequenceValid: { swipe: null, jsBack: null },
    jsRingCapacity: 4096,
    nativeRingCapacity: 2048,
    jsOverflow: 0,
    nativeOverflow: 0,
    c2SetLatencyMs: 12,
    c2RestoreLatencyMs: 12,
    calibAttempts1: 1,
    calibAttempts2: 1,
    postP5SamplePassed: true,
    ...overrides,
  };
}

function setOptionsCalls(): Record<string, unknown>[] {
  return mockNav.api.setOptions.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

/** P2-P4 on the fakes (the visit is re-opened and settled first). */
async function runP2toP4(opts: PopChainOptions = {}): Promise<void> {
  act(() => {
    mockContainer.emit("state", { state: makeRootState(1) });
  });
  queueVisitHeaderRecord();
  await openVisit(false);
  if (opts.expectReadinessText !== false) expect(screen.getByText(/Not ready/)).toBeTruthy();
  await advance(OPEN_SETTLE_MS);
  if (opts.expectReadinessText !== false) expect(screen.getByText(/Ready/)).toBeTruthy();
  fireEvent.press(screen.getByText("Calib"));
  await flush(10);
  fireEvent.press(screen.getByText("Back arm"));
  await advance(200);
  await emitHealthyPop(opts);
}

/** Swipe now -> full 3000 ms window -> "Saved" (noEvent unless injected). */
async function runSwipe(): Promise<void> {
  fireEvent.press(screen.getByText("Swipe now"));
  await flush();
  await advance(300);
  await advance(1200);
  await advance(1500);
  await flush(10);
  expect(navDiagnostics.getStatus().phase).toBe("swipeSaved");
}

function nativeRecord(
  kind: RawNativeRecord["kind"],
  overrides: Partial<RawNativeRecord> = {},
): RawNativeRecord {
  return {
    kind,
    nativeTimeS: nativeNowS(),
    navId: "0xa",
    itemToken: "0x2",
    wrapperToken: "0x1",
    vcToken: "0x9",
    coordinatorPresent: false,
    wrapperFound: true,
    wrapperEnabledBefore: true,
    wrapperEnabledAfter: false,
    result: true,
    animated: false,
    ...overrides,
  };
}

/**
 * Launch preamble P2-P5 (v11) on the fakes: sample 1, reopen, P5 set/restore,
 * the required post-P5 sample 2; ends CALIBRATED with navId 0xa pinned.
 */
async function calibrate(): Promise<void> {
  await runP2toP4();
  expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK, C2 pending/);
  await reopenVisit();
  await runP5();
  expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
  await runSample();
  expect(navDiagnostics.getStatus().calibration).toBe("CALIBRATED");
  // Back on the detail for the counted attempt: re-pushed, opened, settled.
  await reopenVisit();
}

/** Back arm -> Back dead -> full passive window -> "Captured and saved". */
async function captureDeadBack(): Promise<void> {
  fireEvent.press(screen.getByText("Back arm"));
  await advance(1200);
  fireEvent.press(screen.getByText("Back dead"));
  await flush();
  await advance(500);
  await advance(1500);
  await flush(10);
  expect(screen.getByText(/Captured and saved/)).toBeTruthy();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockLog.length = 0;
  mockStorage.clear();
  mockClipboard.last = null;
  mockContainer.listeners.clear();
  mockContainer.rootState = makeRootState(1);
  mockNav.listeners.clear();
  mockProbe.vcCount = 2;
  mockProbe.coordinatorPresent = false;
  mockProbe.wrapperFound = true;
  mockProbe.wrapperEnabled = true;
  mockProbe.nativeOffsetS = 0;
  mockProbe.api.snapshot.mockImplementation(makeSnapshot);
  mockProbe.drainQueue = [];
  mockProbe.drainOverflow = 0;
  mockProbe.drainFails = false;
  mockStorageHold.promise = null;
  mockFlag.value = "0";
  navDiagnostics.resetForTests();
  jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Flag off
// ---------------------------------------------------------------------------
describe("flag off", () => {
  it("mounts no pill, no listeners, no root owner and touches no storage", async () => {
    renderDetail();
    await flush();
    expect(screen.queryByTestId("nav-diag-pill")).toBeNull();
    expect(mockNav.api.addListener).not.toHaveBeenCalled();
    expect(mockContainer.ref.addListener).not.toHaveBeenCalled();
    expect(mockUseNavigationContainerRef).not.toHaveBeenCalled();
    expect(mockProbe.api.enable).not.toHaveBeenCalled();
    expect(
      mockLog.filter((l) => l.includes(NAV_CAPTURE_STORAGE_KEY) || l.includes(NAV_TRACE_STORAGE_KEY)),
    ).toEqual([]);
    expect(navDiagnostics.hasRing()).toBe(false);
  });

  it("renders the root gate as nothing", () => {
    const { toJSON } = renderWithTheme(<NavDiagnosticsRootGate />);
    expect(toJSON()).toBeNull();
  });

  it("shows no diagnostic rows in Settings", async () => {
    renderSettings();
    await flush();
    expect(screen.queryByText("Export last Back failure")).toBeNull();
    expect(screen.queryByText("Export current trace")).toBeNull();
    expect(screen.queryByText("Delete diagnostic data")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flag on
// ---------------------------------------------------------------------------
describe("flag on", () => {
  it("mounts the pill, enables the probe once and wires listeners", async () => {
    await mountEnabled();
    expect(screen.getByTestId("nav-diag-pill")).toBeTruthy();
    expect(mockProbe.api.enable).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/pop=installed header=installed nav=0xa/)).toBeTruthy();
    const navEvents = mockNav.api.addListener.mock.calls.map((c) => c[0]);
    for (const evt of ["transitionStart", "transitionEnd", "gestureCancel", "focus", "blur"]) {
      expect(navEvents).toContain(evt);
    }
    const containerEvents = mockContainer.ref.addListener.mock.calls.map((c) => c[0]);
    expect(containerEvents).toContain("state");
    expect(containerEvents).toContain("__unsafe_action__");
    const mounts = entriesOf("ui.detailMount");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.d).toMatchObject({
      routeKey: "recipe/[id]-k1",
      recipeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      launchNo: 1,
      visitNo: 1,
      visitKind: "calibration",
      // The harness mounts the detail together with the root, so this
      // launch's first record was written when initialisation completed.
      deferred: true,
    });
  });

  it("records screen transition and container events into the ring", async () => {
    await mountEnabled();
    act(() => {
      mockNav.emit("transitionEnd", { closing: false });
      mockNav.emit("gestureCancel", undefined);
      mockContainer.emit("__unsafe_action__", {
        action: { type: "GO_BACK", source: "recipe/[id]-k1", target: "app-stack" },
        noop: false,
      });
      mockContainer.emit("state", { state: makeRootState(0) });
    });
    expect(entriesOf("scr.transitionEnd")[0]?.d).toEqual({
      routeKey: "recipe/[id]-k1",
      closing: false,
    });
    expect(entriesOf("scr.gestureCancel")[0]?.d).toEqual({ routeKey: "recipe/[id]-k1" });
    expect(entriesOf("nav.action")[0]?.d).toEqual({
      type: "GO_BACK",
      noop: false,
      source: "recipe/[id]-k1",
      target: "app-stack",
    });
    expect(entriesOf("nav.state")[0]?.d).toMatchObject({
      navKey: "app-stack",
      index: 0,
      depth: 1,
    });
  });

  it("records grocery press, mutation phases and toast show/dismiss", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Grocery"));
    expect(entriesOf("grocery.press")).toHaveLength(1);
    expect(entriesOf("grocery.mutation")[0]?.d).toEqual({ phase: "start" });
    const options = mockRemakeMutate.mock.calls[0]?.[1] as {
      onSuccess: (data: unknown) => void;
    };
    act(() => {
      options.onSuccess({
        list: { name: "Weekly", display_name: "Weekly", id: "list-1" },
        items_added: 2,
        items_merged: 0,
      });
    });
    expect(entriesOf("grocery.mutation")[1]?.d).toEqual({ phase: "success" });
    expect(entriesOf("toast.show")).toHaveLength(1);
    await advance(10_000);
    expect(entriesOf("toast.dismiss")).toHaveLength(1);
    const serialised = JSON.stringify(ringEntries());
    expect(serialised).not.toContain("Weekly");
    expect(serialised).not.toContain("Carbonara");
  });
});

// ---------------------------------------------------------------------------
// Back arm inertness (section 9.0)
// ---------------------------------------------------------------------------
describe("Back arm", () => {
  it("writes exactly one diag.backAttempt and perturbs nothing else", async () => {
    await mountEnabled();
    const timingSpy = jest.spyOn(Animated, "timing");
    const before = {
      detailRenders: mockUseRecipe.mock.calls.length,
      rootRenders: mockUseNavigationContainerRef.mock.calls.length,
      ring: ringEntries().length,
      setOptions: mockNav.api.setOptions.mock.calls.length,
      dispatch: mockNav.api.dispatch.mock.calls.length,
      haptics: mockHapticTap.mock.calls.length,
      timing: timingSpy.mock.calls.length,
      log: mockLog.length,
    };

    fireEvent.press(screen.getByText("Back arm"));
    await flush();

    const attempts = entriesOf("diag.backAttempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.d).toEqual({
      launchNo: 1,
      visitNo: 1,
      navId: "0xa",
      routeKey: "recipe/[id]-k1",
    });
    expect(ringEntries().length).toBe(before.ring + 1);
    expect(mockUseRecipe.mock.calls.length).toBe(before.detailRenders);
    expect(mockUseNavigationContainerRef.mock.calls.length).toBe(before.rootRenders);
    expect(mockNav.api.setOptions.mock.calls.length).toBe(before.setOptions);
    expect(mockNav.api.dispatch.mock.calls.length).toBe(before.dispatch);
    expect(mockRouterBack).not.toHaveBeenCalled();
    expect(mockImperativeBack).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockHapticTap.mock.calls.length).toBe(before.haptics);
    expect(timingSpy.mock.calls.length).toBe(before.timing);
    expect(mockLog.length).toBe(before.log);
    expect(screen.getByText(/armed/)).toBeTruthy();
    await advance(3000);
    expect(screen.queryByText(/armed/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Back dead capture order (section 9.2)
// ---------------------------------------------------------------------------
describe("Back dead", () => {
  it("captures dead0/dead500/dead2000 before drain, immutable write, read-back and copy", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Back arm"));
    await advance(1200);
    const marker = mockLog.length;
    fireEvent.press(screen.getByText("Back dead"));
    await flush();

    const marks = entriesOf("diag.mark").filter((e) => e.d.label === "backDead");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.d).toMatchObject({ launchNo: 1, visitNo: 1, anchored: true });
    expect(marks[0]?.d.tapToMarkerMs).toBe(1200);
    expect(logSince(marker)).toEqual(["snapshot:dead0"]);
    expect(screen.getByText(/Capturing, hold still/)).toBeTruthy();

    fireEvent.press(screen.getByText("Swipe now"));
    await flush();
    expect(entriesOf("diag.swipe")).toHaveLength(0);

    await advance(500);
    expect(logSince(marker)).toEqual(["snapshot:dead0", "snapshot:dead500"]);
    await advance(1500);
    await flush(10);
    expect(logSince(marker)).toEqual([
      "snapshot:dead0",
      "snapshot:dead500",
      "snapshot:dead2000",
      "drain",
      `set:${NAV_CAPTURE_STORAGE_KEY}`,
      `get:${NAV_CAPTURE_STORAGE_KEY}`,
      "clipboard",
    ]);
    expect(screen.getByText(/Captured and saved/)).toBeTruthy();

    const capture = storedCapture();
    expect(mockClipboard.last).toBe(mockStorage.get(NAV_CAPTURE_STORAGE_KEY));
    expect(capture.header.launchNo).toBe(1);
    expect(capture.appendices).toEqual([]);
    const kinds = capture.entries.map((e) => `${e.k}:${String(e.d.reason ?? e.d.label ?? "")}`);
    expect(kinds).toContain("diag.backAttempt:");
    expect(kinds).toContain("diag.mark:backDead");
    expect(kinds).toContain("diag.snapshot:dead0");
    expect(kinds).toContain("diag.snapshot:dead500");
    expect(kinds).toContain("diag.snapshot:dead2000");
    expect(capture.entries.some((e) => e.k === "diag.capture" && e.d.phase === "write")).toBe(true);
    expect(capture.entries.some((e) => e.k === "diag.capture" && e.d.phase === "saved")).toBe(false);
    expect(entriesOf("diag.capture").some((e) => e.d.phase === "saved")).toBe(true);
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(true);
  });

  it("ignores a second Back dead in the same visit so the first capture and its appendices survive", async () => {
    await mountEnabled();
    await captureDeadBack();
    await runSwipe();
    const stored = mockStorage.get(NAV_CAPTURE_STORAGE_KEY);
    const marker = mockLog.length;
    fireEvent.press(screen.getByText("Back arm"));
    await advance(300);
    fireEvent.press(screen.getByText("Back dead"));
    await flush();
    await advance(2500);
    await flush(10);
    expect(entriesOf("diag.mark").filter((e) => e.d.label === "backDead")).toHaveLength(1);
    expect(logSince(marker).filter((l) => l.startsWith("snapshot:dead") || l.includes(NAV_CAPTURE_STORAGE_KEY))).toEqual([]);
    expect(mockStorage.get(NAV_CAPTURE_STORAGE_KEY)).toBe(stored);
    expect(navDiagnostics.getStatus().phase).toBe("swipeSaved");
    expect(screen.getByText(/already captured/)).toBeTruthy();
  });

  it("marks the launch PROBE INVALID when a drain fails during capture", async () => {
    await mountEnabled();
    mockProbe.drainFails = true;
    fireEvent.press(screen.getByText("Back arm"));
    await advance(100);
    fireEvent.press(screen.getByText("Back dead"));
    await flush();
    await advance(500);
    await advance(1500);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID/);
    expect(entriesOf("diag.overflow").some((e) => e.d.drainFailed === true)).toBe(true);
    expect(storedCapture().header.calibrationStatus).toMatch(/INVALID/);
  });

  it("marks an unanchored attempt when no Back arm preceded it", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Back dead"));
    await flush();
    const mark = entriesOf("diag.mark").find((e) => e.d.label === "backDead");
    expect(mark?.d).toMatchObject({ anchored: false, tapToMarkerMs: null });
    expect(screen.getByText(/UNANCHORED/)).toBeTruthy();
  });

  it("marks an attempt unanchored when the marker arrives after 10 s", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Back arm"));
    await advance(10_001);
    fireEvent.press(screen.getByText("Back dead"));
    await flush();
    const mark = entriesOf("diag.mark").find((e) => e.d.label === "backDead");
    expect(mark?.d).toMatchObject({ anchored: false, tapToMarkerMs: 10_001 });
  });
});

// ---------------------------------------------------------------------------
// Swipe now (section 9.3)
// ---------------------------------------------------------------------------
describe("Swipe now", () => {
  it("opens a 3000 ms root-owned window and appends a noEvent outcome to the capture", async () => {
    await mountEnabled();
    await captureDeadBack();
    const originalEntries = storedCapture().entries;
    const marker = mockLog.length;

    fireEvent.press(screen.getByText("Swipe now"));
    await flush();
    expect(entriesOf("diag.swipe")[0]?.d).toEqual({ phase: "start" });
    expect(logSince(marker)).toEqual(["snapshot:swipePre"]);
    await advance(300);
    expect(logSince(marker)).toEqual(["snapshot:swipePre", "snapshot:swipe300"]);
    await advance(1200);
    expect(logSince(marker)).toEqual([
      "snapshot:swipePre",
      "snapshot:swipe300",
      "snapshot:swipe1500",
    ]);
    expect(entriesOf("diag.swipe")).toHaveLength(1);
    await advance(1500);
    await flush(10);
    expect(entriesOf("diag.swipe")[1]?.d).toEqual({ phase: "end", outcome: "noEvent" });
    // 7.5.6 / 7.5.7: the window-end boundary anchor precedes the drain.
    expect(logSince(marker).slice(3)).toEqual([
      "snapshot:swipe3000",
      "drain",
      `set:${NAV_CAPTURE_STORAGE_KEY}`,
      `get:${NAV_CAPTURE_STORAGE_KEY}`,
    ]);
    const capture = storedCapture();
    expect(capture.entries).toEqual(originalEntries);
    expect(capture.appendices).toHaveLength(1);
    expect(capture.appendices[0]?.label).toBe("swipe");
    expect(capture.appendices[0]?.entries.some((e) => e.k === "diag.swipe" && e.d.phase === "end")).toBe(true);
    expect(screen.getByText(/Saved/)).toBeTruthy();
  });

  it("refreshes the overflow header fields when an appendix is written", async () => {
    await mountEnabled();
    await captureDeadBack();
    expect(storedCapture().header.nativeOverflow).toBe(0);
    mockProbe.drainOverflow = 3;
    await runSwipe();
    expect(storedCapture().header.nativeOverflow).toBe(3);
    expect(navDiagnostics.getStatus().message).toMatch(/INVALID FOR SEQUENCE CLAIMS/);
  });

  it("ignores a gesture cancel that lands after the 3000 ms window", async () => {
    await mountEnabled();
    await captureDeadBack();
    fireEvent.press(screen.getByText("Swipe now"));
    await flush();
    await advance(1500);
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    act(() => {
      mockNav.emit("gestureCancel", undefined);
    });
    await flush(10);
    expect(entriesOf("diag.swipe")[1]?.d).toEqual({ phase: "end", outcome: "noEvent" });
    const appendix = storedCapture().appendices[0];
    expect(appendix?.entries.some((e) => e.k === "scr.gestureCancel")).toBe(false);
    expect(appendix?.entries.some((e) => e.k === "diag.swipe" && e.d.phase === "end")).toBe(true);
  });

  it("carries a probe fault during the swipe appendix into the persisted header and message", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    expect(storedCapture().header.calibrationStatus).toBe("CALIBRATED");
    mockProbe.drainFails = true;
    await runSwipe();
    expect(storedCapture().header.calibrationStatus).toMatch(/INVALID/);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
  });

  it("reports cancelled when a gesture cancel lands inside the window", async () => {
    await mountEnabled();
    await captureDeadBack();
    fireEvent.press(screen.getByText("Swipe now"));
    await flush();
    await advance(400);
    act(() => {
      mockNav.emit("gestureCancel", undefined);
    });
    await advance(2600);
    await flush(10);
    expect(entriesOf("diag.swipe")[1]?.d).toEqual({ phase: "end", outcome: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// JS back (section 9.4 / section 10 Phase 3)
// ---------------------------------------------------------------------------
describe("JS back", () => {
  it("snapshots before dispatch, records the pre-dispatch index and finalises row A only at jsBack3000", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    const marker = mockLog.length;

    fireEvent.press(screen.getByText("JS back"));
    await flush();
    expect(logSince(marker)).toEqual(["snapshot:jsBackPre"]);
    expect(mockImperativeBack).toHaveBeenCalledTimes(1);
    const start = entriesOf("diag.jsBack")[0];
    expect(start?.d).toEqual({
      phase: "start",
      focusedNavKey: "app-stack",
      focusedNavName: "(app)",
      indexPre: 1,
      routeKeyPre: "recipe/[id]-k1",
      routesLenPre: 2,
    });
    const preSnapshotSeq = entriesOf("diag.snapshot").find((e) => e.d.reason === "jsBackPre")?.s ?? -1;
    expect(preSnapshotSeq).toBeGreaterThan(-1);
    expect(start?.s ?? -1).toBeGreaterThan(preSnapshotSeq);

    act(() => {
      mockContainer.emit("__unsafe_action__", {
        action: { type: "GO_BACK", source: undefined, target: undefined },
        noop: false,
      });
      mockContainer.rootState = makeRootState(0);
      mockContainer.emit("state", { state: makeRootState(0) });
    });
    mockProbe.vcCount = 1;
    await advance(300);
    await advance(1200);
    expect(entriesOf("diag.jsBack")).toHaveLength(1);
    await advance(1500);
    await flush(10);
    expect(logSince(marker).filter((l) => l.startsWith("snapshot:"))).toEqual([
      "snapshot:jsBackPre",
      "snapshot:jsBack300",
      "snapshot:jsBack1500",
      "snapshot:jsBack3000",
    ]);
    const end = entriesOf("diag.jsBack")[1];
    expect(end?.d).toMatchObject({ phase: "end", outcome: "A", indexPre: 1 });
    const capture = storedCapture();
    expect(capture.appendices.map((a) => a.label)).toEqual(["swipe", "jsBack"]);
  });

  it("classifies an unobserved GO_BACK with indexPre > 0 as row D", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    expect(entriesOf("diag.jsBack")[1]?.d).toMatchObject({ phase: "end", outcome: "D" });
  });

  it("classifies an unobserved GO_BACK with indexPre === 0 as row C", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    mockContainer.rootState = makeRootState(0);
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    expect(entriesOf("diag.jsBack")[1]?.d).toMatchObject({ phase: "end", outcome: "C", indexPre: 0 });
  });

  it("rejects JS back before the Swipe window has been saved (binding order, section 12)", async () => {
    await mountEnabled();
    await captureDeadBack();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    expect(entriesOf("diag.jsBack")).toHaveLength(0);
    expect(mockImperativeBack).not.toHaveBeenCalled();
    expect(navDiagnostics.getStatus().phase).toBe("captured");
  });

  it("rejects a repeated Swipe and a repeated JS back", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("Swipe now"));
    await flush();
    expect(entriesOf("diag.swipe").filter((e) => e.d.phase === "start")).toHaveLength(1);
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    expect(entriesOf("diag.jsBack").filter((e) => e.d.phase === "start")).toHaveLength(1);
    expect(mockImperativeBack).toHaveBeenCalledTimes(1);
  });

  it("closes the observation window at the jsBack3000 boundary, before the snapshot resolves", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(1500);
    // Fire the boundary timer WITHOUT flushing microtasks, then inject an
    // action event: it lands after the window closed and must not count.
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    act(() => {
      mockContainer.emit("__unsafe_action__", {
        action: { type: "GO_BACK" },
        noop: false,
      });
    });
    await flush(10);
    expect(entriesOf("diag.jsBack").at(-1)?.d).toMatchObject({ phase: "end", outcome: "D" });
    const appendix = storedCapture().appendices.at(-1);
    expect(appendix?.label).toBe("jsBack");
    expect(appendix?.entries.some((e) => e.k === "nav.action")).toBe(false);
    expect(appendix?.entries.some((e) => e.k === "diag.jsBack" && e.d.phase === "end")).toBe(true);
    expect(appendix?.entries.some((e) => e.k === "diag.snapshot" && e.d.reason === "jsBack3000")).toBe(true);
  });

  it("ignores action and state events timestamped after the deadline even when the boundary callback runs late", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(1500);
    // Simulate a late boundary callback: the clock (and therefore every record
    // timestamp) is already 500 ms past the deadline when these events land,
    // but the 3000 ms timer has not fired yet.
    const late = performance.now() + 2000;
    const nowSpy = jest.spyOn(performance, "now").mockReturnValue(late);
    act(() => {
      mockContainer.emit("__unsafe_action__", {
        action: { type: "GO_BACK" },
        noop: false,
      });
      mockContainer.rootState = makeRootState(0);
      mockContainer.emit("state", { state: makeRootState(0) });
    });
    nowSpy.mockRestore();
    await advance(1500);
    await flush(10);
    const end = entriesOf("diag.jsBack").at(-1)?.d;
    expect(end).toMatchObject({ phase: "end", outcome: "D", stateEvents: 0, actionObserved: false, finalChange: false });
  });

  it("labels a GO_BACK probe without a pinned controller INVALID (V1)", async () => {
    await mountEnabled();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    expect(entriesOf("diag.jsBack").at(-1)?.d).toMatchObject({
      phase: "end",
      outcome: "INVALID",
      invalidReason: "noPinnedController",
    });
  });

  it("labels a GO_BACK probe INVALID when a boundary snapshot is unavailable", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(1500);
    // The next snapshot is the jsBack3000 boundary snapshot.
    mockProbe.api.snapshot.mockImplementationOnce(async () => {
      throw new Error("snapshot failed");
    });
    await advance(1500);
    await flush(10);
    expect(entriesOf("diag.jsBack").at(-1)?.d).toMatchObject({
      phase: "end",
      outcome: "INVALID",
      invalidReason: "snapshotUnavailable",
    });
  });

  it("labels a missing focused stack INVALID rather than C or D", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    mockContainer.rootState = { key: "root-1", index: 0, routes: [] };
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    expect(entriesOf("diag.jsBack").at(-1)?.d).toMatchObject({
      phase: "end",
      outcome: "INVALID",
      invalidReason: "focusedStackMissing",
    });
  });

  it("records a dispatch error as Q5e", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    await runSwipe();
    mockImperativeBack.mockImplementationOnce(() => {
      throw new Error("not ready");
    });
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    expect(entriesOf("diag.jsBack").some((e) => e.d.phase === "dispatchError")).toBe(true);
    await advance(3000);
    await flush(10);
    expect(entriesOf("diag.jsBack").at(-1)?.d).toMatchObject({ phase: "end", outcome: "Q5e" });
  });
});

// ---------------------------------------------------------------------------
// Settings rows (section 8.4)
// ---------------------------------------------------------------------------
describe("Settings rows", () => {
  const seededCapture: CaptureRecord = {
    header: {
      sessionToken: "seed",
      launchNo: 1,
      wallStart: "2026-09-01T00:00:00.000Z",
      appVersion: "1.0.0",
      appBuild: "6",
      iosVersion: "26.6",
      deviceModel: "iPhone14,2",
      flag: "1",
      probeStatus: null,
      calibrationStatus: "CALIBRATED",
      c2PassedSession: true,
      c1DidPopObserved: 0,
      jsClockProvider: "steady",
      timebaseAnchors: 4,
      timebaseGaps: 0,
      epochCount: 1,
      attemptWindowSequenceValid: true,
      escapeWindowsSequenceValid: { swipe: null, jsBack: null },
      jsRingCapacity: 4096,
      nativeRingCapacity: 2048,
      jsOverflow: 0,
      nativeOverflow: 0,
      c2SetLatencyMs: null,
      c2RestoreLatencyMs: null,
      calibAttempts1: 1,
      calibAttempts2: 0,
      postP5SamplePassed: null,
    },
    capturedAt: "2026-09-01T00:00:01.000Z",
    entries: [{ s: 1, t: 1, k: "diag.mark", d: { label: "backDead" }, tLo: 1, tHi: 1 }],
    appendices: [],
  };

  it("exports the hydrated last failure without a snapshot, drain or write", async () => {
    const seeded = JSON.stringify(seededCapture);
    mockStorage.set(NAV_CAPTURE_STORAGE_KEY, seeded);
    mockFlag.value = "1";
    renderSettings();
    await flush(10);
    const marker = mockLog.length;
    fireEvent.press(screen.getByText("Export last Back failure"));
    await flush(10);
    expect(mockClipboard.last).toBe(seeded);
    expect(logSince(marker)).toEqual(["clipboard"]);
  });

  it("exports the current trace through snapshot, drain and the rolling key only", async () => {
    mockFlag.value = "1";
    renderSettings();
    await flush(10);
    const marker = mockLog.length;
    fireEvent.press(screen.getByText("Export current trace"));
    await flush(10);
    expect(logSince(marker)).toEqual([
      "snapshot:export",
      "drain",
      `set:${NAV_TRACE_STORAGE_KEY}`,
      `get:${NAV_TRACE_STORAGE_KEY}`,
      "clipboard",
    ]);
    expect(mockStorage.has(NAV_CAPTURE_STORAGE_KEY)).toBe(false);
    const exported = JSON.parse(mockClipboard.last ?? "{}") as { header: { launchNo: number } };
    expect(exported.header.launchNo).toBe(1);
  });

  it("keeps the export controls inactive until hydration and enablement complete", async () => {
    const seeded = JSON.stringify(seededCapture);
    mockStorage.set(NAV_CAPTURE_STORAGE_KEY, seeded);
    let release: () => void = () => undefined;
    mockStorageHold.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFlag.value = "1";
    renderSettings();
    await flush(10);
    expect(navDiagnostics.getStatus().initialised).toBe(false);
    expect(navDiagnostics.getController()).toBeNull();
    fireEvent.press(screen.getByText("Export last Back failure"));
    fireEvent.press(screen.getByText("Export current trace"));
    await flush(10);
    expect(mockClipboard.last).toBeNull();
    expect(mockLog.filter((l) => l === "clipboard" || l.startsWith("snapshot:"))).toEqual([]);
    release();
    mockStorageHold.promise = null;
    await flush(20);
    expect(navDiagnostics.getStatus().initialised).toBe(true);
    expect(navDiagnostics.getController()).not.toBeNull();
    expect(mockStorage.has(NAV_TRACE_STORAGE_KEY)).toBe(true);
    fireEvent.press(screen.getByText("Export last Back failure"));
    await flush(10);
    expect(mockClipboard.last).toBe(seeded);
  });

  it("deletes both persisted records", async () => {
    mockStorage.set(NAV_CAPTURE_STORAGE_KEY, JSON.stringify(seededCapture));
    mockFlag.value = "1";
    renderSettings();
    await flush(10);
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(true);
    fireEvent.press(screen.getByText("Delete diagnostic data"));
    await flush(10);
    expect(mockStorage.has(NAV_CAPTURE_STORAGE_KEY)).toBe(false);
    expect(mockStorage.has(NAV_TRACE_STORAGE_KEY)).toBe(false);
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arm boundary (section 7.2 / 11)
// ---------------------------------------------------------------------------
describe("Arm end", () => {
  it("resets the ring and the native overflow accounting after a verified export", async () => {
    await mountEnabled();
    mockProbe.drainOverflow = 2;
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    const first = JSON.parse(mockClipboard.last ?? "{}") as { header: { nativeOverflow: number } };
    expect(first.header.nativeOverflow).toBe(2);
    fireEvent.press(screen.getByText("Arm end"));
    await flush(10);
    expect(ringEntries()).toHaveLength(0);
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    const second = JSON.parse(mockClipboard.last ?? "{}") as { header: { nativeOverflow: number } };
    expect(second.header.nativeOverflow).toBe(0);
  });

  it("keeps the ring when the arm-boundary persistence fails verification", async () => {
    await mountEnabled();
    const before = ringEntries().length;
    expect(before).toBeGreaterThan(0);
    const AsyncStorage = require("@react-native-async-storage/async-storage").default as {
      setItem: jest.Mock;
    };
    AsyncStorage.setItem.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    fireEvent.press(screen.getByText("Arm end"));
    await flush(10);
    expect(ringEntries().length).toBeGreaterThanOrEqual(before);
    expect(navDiagnostics.getStatus().message).toMatch(/persist FAILED/);
  });
});

// ---------------------------------------------------------------------------
// Calibration (section 6, P2-P5)
// ---------------------------------------------------------------------------
describe("Calibration", () => {
  it("passes C1/C3/C4 on a healthy Back WITHOUT didPop, then C2 by title set/restore, then CALIBRATED only after the post-P5 sample", async () => {
    await mountEnabled();
    await runP2toP4();
    expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK, C2 pending/);
    expect(navDiagnostics.getStatus().navId).toBe("0xa");
    const calibrated = entriesOf("diag.mark").find((e) => e.d.label === "calibrated");
    expect(calibrated?.d).toMatchObject({ didPopObserved: 0 });
    // Translated through the 7.5 anchors (floating point), hence closeTo.
    expect(calibrated?.d.tapToMarkerMs).toBeCloseTo(200, 6);
    expect(entriesOf("diag.mark").some((e) => e.d.label === "calibEval")).toBe(true);
    // B1: the calibration window is bounded by an accepted anchor at its end (7.5.7).
    expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibEval")).toBe(true);
    const evalMark = entriesOf("diag.mark").find((e) => e.d.label === "calibEval");
    const evalSnap = entriesOf("diag.snapshot").find((e) => e.d.reason === "calibEval");
    expect(evalMark?.t).toBe(evalSnap?.t);

    // 5.4a: the reopened calibration visit names Header calib as the next action.
    await reopenVisit();
    expect(navDiagnostics.getStatus().message).toMatch(/Tap Header calib and touch nothing/);
    await runP5();
    // P5 touches only headerTitle: set, then restore through the same setter.
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
    expect(setOptionsCalls().some((c) => "headerRight" in c)).toBe(false);
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals.map((e) => e.d.phase)).toEqual(["set", "restore"]);
    for (const e of evals) {
      expect(e.d).toMatchObject({ hit: true, quiet: true, valid: true, stale: false });
      expect(e.d.latencyMs as number).toBeCloseTo(400, 0);
    }
    expect(entriesOf("diag.snapshot").filter((e) => e.d.reason === "headerCalibEval")).toHaveLength(2);
    // Amendment 1: C2 alone is never CALIBRATED and never unlocks trials.
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
    expect(navDiagnostics.getStatus().message).toMatch(
      /C2 PASS\. Check the title says Recipe again, then tap Calib, wait for 'S-pre taken', then Back arm, then Back once/,
    );
    expect(mockStorage.get(NAV_TRACE_STORAGE_KEY)).toContain('"c2PassedSession":true');
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    expect(exportedHeader()).toMatchObject({
      c1DidPopObserved: 0,
      jsClockProvider: "steady",
      timebaseGaps: 0,
      epochCount: 1,
      c2PassedSession: true,
      postP5SamplePassed: false,
      calibAttempts1: 1,
      calibAttempts2: 0,
    });
    expect(exportedHeader().c2SetLatencyMs as number).toBeCloseTo(400, 0);
    expect(exportedHeader().c2RestoreLatencyMs as number).toBeCloseTo(400, 0);
    expect(exportedHeader().timebaseAnchors).toBeGreaterThan(3);

    // The required post-P5 sample (sample 2) completes the launch calibration.
    await runSample();
    expect(navDiagnostics.getStatus().calibration).toBe("CALIBRATED");
    expect(navDiagnostics.getStatus().message).toMatch(/CALIBRATED \(arm-to-delegate \d+ ms\)/);
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    expect(exportedHeader()).toMatchObject({ postP5SamplePassed: true, calibAttempts1: 1, calibAttempts2: 1 });
    await reopenVisit();
    expect(navDiagnostics.getStatus().message).toMatch(/Calibration visits need no further action/);
  });

  it("counts an observed didPop as telemetry without making it a criterion", async () => {
    await mountEnabled();
    await runP2toP4({ didPop: true });
    expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK/);
    const calibrated = entriesOf("diag.mark").find((e) => e.d.label === "calibrated");
    expect(calibrated?.d.didPopObserved).toBe(1);
  });

  it("accepts POP landing after transitionEnd (order not required)", async () => {
    await mountEnabled();
    await runP2toP4({ order: "popAfterEnd" });
    expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK/);
  });

  it("fails C1.pop when the native pop never produces a POP action", async () => {
    await mountEnabled();
    await runP2toP4({ popAction: false });
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.pop");
    expect(screen.getByText(/PROBE INVALID/)).toBeTruthy();
  });

  it("fails C1.time when a device lock splits the calibration window into two epochs", async () => {
    await mountEnabled();
    act(() => {
      mockContainer.emit("state", { state: makeRootState(1) });
    });
    await openVisit();
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    fireEvent.press(screen.getByText("Back arm"));
    await advance(200);
    // Lock: the JS clock advances 2 s, the native clock does not (7.5.1).
    appState("background");
    mockProbe.nativeOffsetS = 2;
    await advance(2000);
    appState("active");
    await flush(10);
    expect(entriesOf("diag.timebase").some((e) => e.d.source === "wake" && e.d.gap === true)).toBe(true);
    await emitHealthyPop();
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.time");
  });

  it("marks C2.set INVALID when the set record arrives outside the 1 s window (it lands in the restore window instead)", async () => {
    await mountEnabled();
    await runP2toP4();
    await reopenVisit();
    await runP5({ setDelayMs: 1000, restoreRecord: false, setRecord: false });
    // No record in either window: the set miss decides; a later record never rescues it.
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C2.set");
    expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID: C2 failed/);
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
  });

  it("does not evaluate C2 before C1/C3/C4 pinned the navId", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Header calib"));
    await flush();
    await advance(1000);
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
  });

  it("labels native records from another controller", async () => {
    await mountEnabled();
    await runP2toP4();
    mockProbe.drainQueue.push(nativeRecord("shouldPop", { navId: "0xb" }));
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    const other = entriesOf("native.popDelegate").find((e) => e.d.navId === "0xb");
    expect(other?.d.otherController).toBe(true);
  });

  it("marks the launch PROBE INVALID when the JS clock is not the steady provider (7.5.1)", async () => {
    const spy = jest.spyOn(performance, "now").mockReturnValue(1.7e12);
    try {
      await mountEnabled(false);
      expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: timebase provider/);
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader().jsClockProvider).toBe("wall");
      // Launch-level and latched on the calibration line (the pill's status line).
      expect(screen.getByText(/Calib: INVALID: timebase provider/)).toBeTruthy();
      expect(exportedHeader().calibrationStatus).toMatch(/INVALID: timebase provider/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Header calibration P5 (v11, section 6 / 23.9): set/restore windows,
// joint decision, VC-token binding, quiet + sequence validity, interruption,
// per-sample attempt allowance (D11) and the trial arm gate (D12).
// ---------------------------------------------------------------------------
describe("Header calibration P5 (v11)", () => {
  async function toC2Pending(): Promise<void> {
    await mountEnabled();
    await runP2toP4();
    await reopenVisit();
  }

  it("never passes a failed set even when the restore hits (B1)", async () => {
    await toC2Pending();
    await runP5({ setRecord: false });
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C2.set");
    expect(navDiagnostics.getStatus().calibration).not.toMatch(/CALIBRATED|C2 OK/);
    // Cleanup still ran through the captured setter.
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
    expect(mockStorage.get(NAV_TRACE_STORAGE_KEY)).not.toContain('"c2PassedSession":true');
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals.map((e) => [e.d.phase, e.d.hit])).toEqual([["set", false], ["restore", true]]);
    // A STOP locks calibration for the launch: Calib is refused with the stop message.
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPreBack" && e.s > evals[1]!.s)).toBe(false);
    expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID for this launch/);
  });

  it("marks C2.restore INVALID when the restore window has no record", async () => {
    await toC2Pending();
    await runP5({ restoreRecord: false });
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C2.restore");
    expect(navDiagnostics.getStatus().calibration).not.toMatch(/CALIBRATED|C2 OK/);
  });

  it("treats a navigation event inside a window as INDETERMINATE, restores, and passes a clean repeat", async () => {
    await toC2Pending();
    await runP5({
      duringSet: () => {
        act(() => {
          mockContainer.emit("__unsafe_action__", { action: { type: "PUSH" }, noop: false });
        });
      },
    });
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib interrupted\. Reopen the recipe, wait for Ready, tap Header calib again/);
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals[0]?.d).toMatchObject({ phase: "set", hit: true, quiet: false });
    await reopenVisit();
    await runP5();
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
  });

  it("rejects hits carrying another VC token (the list VC) as C2.set", async () => {
    await toC2Pending();
    await runP5({ setToken: "0x8", restoreToken: "0x8" });
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C2.set");
  });

  it("refuses Header calib when the visit's detail VC token cannot be resolved (two tokens in the opening window)", async () => {
    await mountEnabled();
    await runP2toP4();
    // The harness mounts the detail once, so the visit's opening window spans
    // sample 1's push record (0x9); a second distinct token makes it ambiguous.
    await reopenVisit({ headerToken: "0x8" });
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib needs a fresh calibration visit/);
    expect(entriesOf("diag.mark").some((e) => e.d.label === "headerCalib")).toBe(false);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK, C2 pending/);
  });

  it("is INDETERMINATE when the set boundary anchor is rejected (u > 100 ms)", async () => {
    await toC2Pending();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      return snap;
    };
    // Snapshot order in P5: headerCalibPre (fast), then the set boundary (slow).
    mockProbe.api.snapshot.mockImplementationOnce(makeSnapshot).mockImplementationOnce(slow);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush();
    await advance(300);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
    const setEval = entriesOf("diag.mark").find((e) => e.d.label === "headerCalibEval" && e.d.phase === "set");
    expect(setEval?.d.valid).toBe(false);
  });

  it("is INDETERMINATE when the app backgrounds and wakes inside a window (app.state, epoch)", async () => {
    await toC2Pending();
    await runP5({
      duringSet: async () => {
        appState("background");
        mockProbe.nativeOffsetS = 2;
        await advance(100);
        appState("active");
        await flush(10);
      },
    });
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
  });

  it("marks the launch PROBE INVALID on native overflow inside a window", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    mockProbe.drainOverflow = 1;
    await advance(600);
    await flush(10);
    await advance(1000);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: .*overflow.*\(probe fault, V1\)/);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
  });

  it("refuses Back arm during P5 (reason headerCalib) and Calib while P5 is in progress", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(100);
    expect(navDiagnostics.getStatus().message).toMatch(/^Not ready/);
    const armsBefore = entriesOf("diag.backAttempt").length;
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(armsBefore);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "headerCalib" });
    const snapshots = entriesOf("diag.snapshot").length;
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    expect(entriesOf("diag.snapshot")).toHaveLength(snapshots);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib in progress, wait/);
    // The rest of P5 completes normally and readiness returns.
    await advance(300);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
  });

  it("refuses Header calib while a Calib is pending (S-pre unresolved) or armed (A3)", async () => {
    await toC2Pending();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      return snap;
    };
    mockProbe.api.snapshot.mockImplementationOnce(slow);
    fireEvent.press(screen.getByText("Calib"));
    await flush();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib must wait/);
    expect(entriesOf("diag.mark").some((e) => e.d.label === "headerCalib")).toBe(false);
    await advance(300);
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/S-pre taken/);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib must wait/);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
  });

  it("records a stale completion without touching a newer visit, and restores through the original setter", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    // A new visit opens while the set window is running (the old visit closed).
    act(() => {
      mockNav.emit("transitionEnd", { closing: true });
    });
    await flush();
    act(() => {
      navDiagnostics.record("ui.detailMount", {
        routeKey: "recipe/[id]-k2",
        recipeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        launchNo: navDiagnostics.getStatus().launchNo,
        visitNo: navDiagnostics.getStatus().visitNo + 1,
        visitKind: "calibration",
        arm: "A",
        cycle: 0,
        anchor: "A1",
        deferred: false,
      });
    });
    await flush();
    await advance(600);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    // Cleanup ran (both calls through the setter captured at the tap).
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals).toHaveLength(2);
    expect(evals.every((e) => e.d.stale === true)).toBe(true);
    // The newer visit's calibration, message and readiness are untouched: neither a
    // pass, nor the INDETERMINATE "repeat" status, nor the interruption message.
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (Header calib)");
    expect(navDiagnostics.getStatus().message).not.toMatch(/interrupted|C2 PASS|C2 OK/);
    expect(mockStorage.get(NAV_TRACE_STORAGE_KEY)).not.toContain('"c2PassedSession":true');
    expect(entriesOf("diag.ready").at(-1)?.d.reason).not.toBe("headerCalib");
  });

  it("does not run P5 on a latched launch (invalid-run message governs)", async () => {
    await toC2Pending();
    mockProbe.drainFails = true;
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    mockProbe.drainFails = false;
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
  });

  it("filters hits by the pinned navId independently of the VC token", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true, navId: "0xb" }));
    await advance(600);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true, navId: "0xb" }));
    await advance(600);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C2.set");
  });

  it("is INDETERMINATE on a quiet breaker inside the restore window only", async () => {
    await toC2Pending();
    await runP5({
      duringRestore: () => {
        act(() => {
          mockContainer.emit("__unsafe_action__", { action: { type: "PUSH" }, noop: false });
        });
      },
    });
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals.map((e) => [e.d.phase, e.d.hit, e.d.quiet])).toEqual([["set", true, true], ["restore", true, false]]);
  });

  it("treats a screen transition record as a quiet breaker", async () => {
    await toC2Pending();
    await runP5({
      duringSet: () => {
        act(() => {
          mockNav.emit("transitionStart", { closing: false });
        });
      },
    });
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
  });

  it("restores through the setter captured at the tap, not a setter registered later", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    const other = jest.fn();
    navDiagnostics.registerHeaderCalib(other);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    expect(other).not.toHaveBeenCalled();
    expect(setOptionsCalls()).toEqual([{ headerTitle: HEADER_CALIB_TITLE }, { headerTitle: undefined }]);
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
  });

  it("refuses Arm end while P5 (or any calibration work) is in flight", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    const before = ringEntries().length;
    fireEvent.press(screen.getByText("Arm end"));
    await flush(10);
    expect(ringEntries().length).toBeGreaterThanOrEqual(before);
    expect(navDiagnostics.getStatus().message).toMatch(/Arm end must wait: calibration in progress/);
  });

  it("counts overflow consumed by a Trace drain inside a window against the P5 baseline (PROBE INVALID)", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    mockProbe.drainOverflow = 1;
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    await advance(600);
    await flush(10);
    await advance(1000);
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: native overflow in Header calib window \(probe fault, V1\)/);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
  });

  it("abandons P5 inertly when the visit closes during its preparation (no title change, no message change)", async () => {
    await toC2Pending();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return snap;
    };
    mockProbe.api.snapshot.mockImplementationOnce(slow);
    fireEvent.press(screen.getByText("Header calib"));
    await flush();
    // Arms are refused from the tap.
    const armsBefore = entriesOf("diag.backAttempt").length;
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(armsBefore);
    act(() => {
      mockNav.emit("transitionEnd", { closing: true });
    });
    await flush();
    const messageAfterClose = navDiagnostics.getStatus().message;
    await advance(200);
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(entriesOf("diag.mark").some((e) => e.d.label === "headerCalib")).toBe(false);
    // Ownership was lost with the visit: the stale preparation is inert.
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (Header calib)");
    expect(navDiagnostics.getStatus().message).toBe(messageAfterClose);
    expect(navDiagnostics.getStatus().message).not.toMatch(/interrupted/);
    await reopenVisit();
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
  });

  it("keeps a replacement visit's status, message and readiness untouched when a stale P5 preparation resolves", async () => {
    await toC2Pending();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return snap;
    };
    mockProbe.api.snapshot.mockImplementationOnce(slow);
    fireEvent.press(screen.getByText("Header calib"));
    await flush();
    // The visit closes and a replacement visit opens and settles before the preparation resolves.
    act(() => {
      mockNav.emit("transitionEnd", { closing: true });
    });
    await flush();
    act(() => {
      navDiagnostics.record("ui.detailMount", {
        routeKey: "recipe/[id]-k2",
        recipeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        launchNo: navDiagnostics.getStatus().launchNo,
        visitNo: navDiagnostics.getStatus().visitNo + 1,
        visitKind: "calibration",
        arm: "A",
        cycle: 0,
        anchor: "A1",
        deferred: false,
      });
    });
    await flush();
    const statusBefore = navDiagnostics.getStatus().calibration;
    const messageBefore = navDiagnostics.getStatus().message;
    const readyBefore = entriesOf("diag.ready").length;
    await advance(200);
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(entriesOf("diag.mark").some((e) => e.d.label === "headerCalib")).toBe(false);
    expect(navDiagnostics.getStatus().calibration).toBe(statusBefore);
    expect(navDiagnostics.getStatus().message).toBe(messageBefore);
    expect(navDiagnostics.getStatus().message).not.toMatch(/interrupted/);
    expect(entriesOf("diag.ready")).toHaveLength(readyBefore);
  });

  it("abandons P5 with the interruption instruction when the Kind changes during its preparation", async () => {
    await toC2Pending();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return snap;
    };
    mockProbe.api.snapshot.mockImplementationOnce(slow);
    fireEvent.press(screen.getByText("Header calib"));
    await flush();
    fireEvent.press(screen.getByText(/^Kind:/));
    await flush();
    await advance(200);
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(entriesOf("diag.mark").some((e) => e.d.label === "headerCalib")).toBe(false);
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib interrupted/);
    // Back on a calibration visit, a clean P5 passes.
    fireEvent.press(screen.getByText(/^Kind:/));
    fireEvent.press(screen.getByText(/^Kind:/));
    await flush();
    await reopenVisit();
    await runP5();
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
  });

  it("refuses Header calib while a C1 evaluation is still pending", async () => {
    await toC2Pending();
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    fireEvent.press(screen.getByText("Back arm"));
    await advance(200);
    mockProbe.drainQueue.push(nativeRecord("shouldPop"));
    act(() => {
      mockNav.emit("transitionStart", { closing: true });
    });
    await advance(200);
    mockProbe.vcCount = 1;
    act(() => {
      mockContainer.emit("__unsafe_action__", { action: { type: "POP" }, noop: false });
      mockNav.emit("transitionEnd", { closing: true });
      mockContainer.rootState = makeRootState(0);
      mockContainer.emit("state", { state: makeRootState(0) });
    });
    await flush(10);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib must wait/);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    await advance(300);
    await flush(10);
    expect(entriesOf("diag.mark").filter((e) => e.d.label === "calibrated")).toHaveLength(2);
  });

  it("is INDETERMINATE when the app backgrounds and wakes between the two windows with both windows quiet (H2)", async () => {
    await toC2Pending();
    const brief = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      return snap;
    };
    // Snapshots in P5: headerCalibPre (fast), set boundary (100 ms, u = 50, accepted).
    mockProbe.api.snapshot.mockImplementationOnce(makeSnapshot).mockImplementationOnce(brief);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush();
    // The set window has ended; the lifecycle changes while its boundary snapshot resolves.
    await advance(10);
    appState("background");
    appState("active");
    await advance(90);
    await flush(10);
    await advance(400);
    mockProbe.drainQueue.push(nativeRecord("headerUpdate", { animated: true }));
    await advance(600);
    await flush(10);
    const evals = entriesOf("diag.mark").filter((e) => e.d.label === "headerCalibEval");
    expect(evals.map((e) => [e.d.phase, e.d.hit, e.d.quiet, e.d.interrupted])).toEqual([
      ["set", true, true, true],
      ["restore", true, true, true],
    ]);
    expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (repeat Header calib)");
    expect(navDiagnostics.getStatus().calibration).not.toMatch(/C2 OK/);
  });

  it("refuses Header calib when the visit's open anchor was rejected (M1)", async () => {
    await mountEnabled();
    await runP2toP4();
    const slow = async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      return snap;
    };
    mockProbe.vcCount = 2;
    mockContainer.rootState = makeRootState(1);
    act(() => {
      mockContainer.emit("state", { state: makeRootState(1) });
    });
    queueVisitHeaderRecord();
    mockProbe.api.snapshot.mockImplementationOnce(slow);
    await openVisit();
    // The hold runs from the (late) open completion: settle it fully.
    await advance(OPEN_SETTLE_MS);
    expect(entriesOf("diag.timebase").filter((e) => e.d.source === "calibOpen").at(-1)?.d).toMatchObject({ rejected: true });
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/Header calib needs a fresh calibration visit/);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
  });

  it("voids a C1 sample whose window saw native overflow (C1.time, locked)", async () => {
    await mountEnabled();
    act(() => {
      mockContainer.emit("state", { state: makeRootState(1) });
    });
    queueVisitHeaderRecord();
    await openVisit();
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    fireEvent.press(screen.getByText("Back arm"));
    await advance(200);
    mockProbe.drainOverflow = 1;
    await emitHealthyPop({ expectReadinessText: false });
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.time");
    expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID for this launch/);
  });

  it("refuses a repeat P5 once C2 passed this session", async () => {
    await toC2Pending();
    await runP5();
    expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
    const calls = setOptionsCalls().length;
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toMatch(/C2 already passed this session/);
    expect(setOptionsCalls()).toHaveLength(calls);
  });

  describe("hydrated session C2 (8.3)", () => {
    it("completes the launch after sample 1 alone and admits trial arms when the header hook is installed", async () => {
      mockStorage.set(NAV_TRACE_STORAGE_KEY, JSON.stringify({ header: storedTraceHeader(), entries: [] }));
      await mountEnabled();
      await runP2toP4();
      expect(navDiagnostics.getStatus().calibration).toBe("CALIBRATED");
      expect(navDiagnostics.getStatus().message).toMatch(/CALIBRATED \(arm-to-delegate/);
      await reopenVisit();
      expect(navDiagnostics.getStatus().message).toMatch(/Calibration visits need no further action/);
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      const arms = entriesOf("diag.backAttempt").length;
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(arms + 1);
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ c2PassedSession: true, postP5SamplePassed: null });
    });

    it("requires C2 again when enable() no longer reports the header hook installed", async () => {
      mockStorage.set(NAV_TRACE_STORAGE_KEY, JSON.stringify({ header: storedTraceHeader(), entries: [] }));
      mockProbe.api.enable.mockImplementationOnce(async () => ({
        popHooks: "installed",
        headerHook: "absent",
        ios26: true,
        navId: "0xa",
        nativeTimebaseAnchorS: 100,
      }));
      await mountEnabled();
      await runP2toP4();
      expect(navDiagnostics.getStatus().calibration).toBe("C1/C3/C4 OK, C2 pending (Header calib)");
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader().c2PassedSession).toBe(false);
    });

    it("refuses trial arms once a calibrated launch is latched by a probe fault", async () => {
      await mountEnabled();
      await calibrate();
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      mockProbe.drainFails = true;
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      mockProbe.drainFails = false;
      const arms = entriesOf("diag.backAttempt").length;
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(arms);
      expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "notCalibrated" });
      expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    });
  });

  describe("attempt allowance per required C1 sample (D11)", () => {
    /** Calib -> Back arm -> Back more than 10 s later: an isolated C1.late. */
    async function lateSample(): Promise<void> {
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(10_500);
      await emitHealthyPop();
    }

    it("allows a retry after an isolated C1.late, labels the sample and attempt, and passes on the next attempt", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      await lateSample();
      expect(navDiagnostics.getStatus().calibration).toBe("C1.late (sample 1 attempt 1 of 3)");
      expect(navDiagnostics.getStatus().message).toMatch(
        /Timing miss \(Back after 10 s\)\. Sample 1 attempt 1 of 3 used\. Reopen the recipe, tap Calib, wait for 'S-pre taken', then Back arm, then Back within 3 s/,
      );
      await reopenVisit();
      await runSample();
      expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK, C2 pending/);
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ calibAttempts1: 2, calibAttempts2: 0 });
    });

    it("locks the launch after three C1.late attempts on one sample", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      await lateSample();
      await reopenVisit();
      await lateSample();
      expect(navDiagnostics.getStatus().calibration).toBe("C1.late (sample 1 attempt 2 of 3)");
      await reopenVisit();
      await lateSample();
      expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.late x3 (sample 1 attempts exhausted)");
      expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID for this launch\. Tap Trace, then Share, then quit the app and open it again/);
      await reopenVisit();
      const snapshots = entriesOf("diag.snapshot").length;
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      expect(entriesOf("diag.snapshot")).toHaveLength(snapshots);
      expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.late x3 (sample 1 attempts exhausted)");
    });

    it("locks the launch when a sample's three attempts are exhausted on sample 2", async () => {
      await mountEnabled();
      await runP2toP4();
      await reopenVisit();
      await runP5();
      await lateSample();
      await reopenVisit();
      await lateSample();
      await reopenVisit();
      await lateSample();
      expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.late x3 (sample 2 attempts exhausted)");
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ calibAttempts1: 1, calibAttempts2: 3, postP5SamplePassed: false });
    });

    it("refuses a fourth accepted arm on one sample before any Back and locks the launch", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      expect(navDiagnostics.getStatus().message).toMatch(/S-pre taken \(sample 1, attempt 1 of 3 next\)/);
      for (let i = 0; i < 3; i += 1) {
        fireEvent.press(screen.getByText("Back arm"));
        await flush();
      }
      expect(entriesOf("diag.backAttempt")).toHaveLength(3);
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(3);
      expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "calibLocked" });
      expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1 attempts exhausted (sample 1, 3 arms used)");
      expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID for this launch/);
      // A healthy Back now is not evaluated as a sample.
      await emitHealthyPop({ expectReadinessText: false });
      expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(false);
    });

    it("cancels a taken Calib when the Kind changes, so the next Back is not a calibration sample", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      expect(navDiagnostics.getStatus().message).toMatch(/Calib cancelled \(Kind changed\)/);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(200);
      await emitHealthyPop();
      expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(false);
      expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPostBack")).toBe(false);
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ calibAttempts1: 0, calibAttempts2: 0 });
    });

    it("never arms from a cancelled Calib whose S-pre resolves later, even after the Kind changes back", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      const slow = async (reason: string) => {
        const snap = await makeSnapshot(reason);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        return snap;
      };
      mockProbe.api.snapshot.mockImplementationOnce(slow);
      fireEvent.press(screen.getByText("Calib"));
      await flush();
      // Cancel before the S-pre resolves, then change the Kind back.
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      expect(navDiagnostics.getStatus().message).toMatch(/Calib cancelled/);
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      expect(screen.getByText(/Kind: calibration/)).toBeTruthy();
      await advance(300);
      await flush(10);
      // The old completion neither re-arms nor publishes the S-pre instruction.
      expect(navDiagnostics.getStatus().message).not.toMatch(/S-pre taken/);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(200);
      await emitHealthyPop({ expectReadinessText: false });
      expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(false);
      expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPostBack")).toBe(false);
      expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ calibAttempts1: 0, calibAttempts2: 0 });
    });

    it("never arms from a Calib whose visit was replaced while its S-pre was unresolved", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      const slow = async (reason: string) => {
        const snap = await makeSnapshot(reason);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        return snap;
      };
      mockProbe.api.snapshot.mockImplementationOnce(slow);
      fireEvent.press(screen.getByText("Calib"));
      await flush();
      // The visit closes and a replacement visit opens before the S-pre resolves.
      act(() => {
        mockNav.emit("transitionEnd", { closing: true });
      });
      await flush();
      act(() => {
        navDiagnostics.record("ui.detailMount", {
          routeKey: "recipe/[id]-k2",
          recipeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          launchNo: navDiagnostics.getStatus().launchNo,
          visitNo: navDiagnostics.getStatus().visitNo + 1,
          visitKind: "calibration",
          arm: "A",
          cycle: 0,
          anchor: "A1",
          deferred: false,
        });
      });
      await flush();
      await advance(300);
      await flush(10);
      // The replacement visit's open hint stands; the S-pre confirmation never appears.
      expect(navDiagnostics.getStatus().message).not.toMatch(/S-pre taken \(sample/);
      // A state change now is not a calibration evaluation.
      mockProbe.vcCount = 1;
      act(() => {
        mockContainer.rootState = makeRootState(0);
        mockContainer.emit("state", { state: makeRootState(0) });
      });
      await flush(10);
      await advance(300);
      await flush(10);
      expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPostBack")).toBe(false);
      expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
    });

    it("never arms from a Calib whose visit closed (no replacement) while its S-pre was unresolved", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      const slow = async (reason: string) => {
        const snap = await makeSnapshot(reason);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        return snap;
      };
      mockProbe.api.snapshot.mockImplementationOnce(slow);
      fireEvent.press(screen.getByText("Calib"));
      await flush();
      // The originating visit closes; the visit identity stays the same (no replacement).
      act(() => {
        mockNav.emit("transitionEnd", { closing: true });
      });
      await flush();
      const messageAfterClose = navDiagnostics.getStatus().message;
      await advance(300);
      await flush(10);
      // No S-pre publication and no arming from the stale preparation.
      expect(navDiagnostics.getStatus().message).toBe(messageAfterClose);
      expect(navDiagnostics.getStatus().message).not.toMatch(/S-pre taken \(sample/);
      // A later state change is not a calibration evaluation.
      mockProbe.vcCount = 1;
      act(() => {
        mockContainer.rootState = makeRootState(0);
        mockContainer.emit("state", { state: makeRootState(0) });
      });
      await flush(10);
      await advance(300);
      await flush(10);
      expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPostBack")).toBe(false);
      expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(false);
      expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
      // The next Calib on a reopened visit is not blocked by the stale preparation.
      await reopenVisit();
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      expect(navDiagnostics.getStatus().message).toMatch(/S-pre taken \(sample 1, attempt 1 of 3 next\)/);
    });

    it("lets a newer Calib keep its pending state and arm when an older cancelled S-pre resolves afterwards", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      const slow = async (reason: string) => {
        const snap = await makeSnapshot(reason);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        return snap;
      };
      mockProbe.api.snapshot.mockImplementationOnce(slow);
      fireEvent.press(screen.getByText("Calib"));
      await flush();
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      // A fresh Calib (fast S-pre) on the calibration visit arms normally.
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      expect(navDiagnostics.getStatus().message).toMatch(/S-pre taken \(sample 1, attempt 1 of 3 next\)/);
      // The old cancelled preparation resolves now and must change nothing.
      await advance(300);
      await flush(10);
      expect(navDiagnostics.getStatus().message).toMatch(/S-pre taken \(sample 1, attempt 1 of 3 next\)/);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(200);
      await emitHealthyPop();
      expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(true);
      expect(navDiagnostics.getStatus().calibration).toMatch(/C1\/C3\/C4 OK, C2 pending/);
    });

    it("gives no retry when C1.late is not isolated (C1.pop also fails) and locks calibration", async () => {
      await mountEnabled();
      act(() => {
        mockContainer.emit("state", { state: makeRootState(1) });
      });
      queueVisitHeaderRecord();
      await openVisit();
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(10_500);
      await emitHealthyPop({ popAction: false });
      // The status names the first failing sub-code (section 6); the lock proves it was not isolated.
      expect(navDiagnostics.getStatus().calibration).toBe("INVALID: C1.late");
      expect(navDiagnostics.getStatus().message).toMatch(/PROBE INVALID for this launch/);
      await reopenVisit();
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPreBack" && e.s > 0)).toBe(true);
      // Exactly one calibPreBack exists: the refused Calib took none.
      expect(entriesOf("diag.snapshot").filter((e) => e.d.reason === "calibPreBack")).toHaveLength(1);
    });

    it("charges every attempt after C2 to sample 2 and labels it", async () => {
      await mountEnabled();
      await runP2toP4();
      await reopenVisit();
      await runP5();
      expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
      // Sample 2, attempt 1: armed, never pressed; attempt 2 on a fresh open: late.
      fireEvent.press(screen.getByText("Calib"));
      await flush(10);
      fireEvent.press(screen.getByText("Back arm"));
      await advance(10_500);
      await emitHealthyPop();
      expect(navDiagnostics.getStatus().calibration).toBe("C1.late (sample 2 attempt 1 of 3)");
      expect(navDiagnostics.getStatus().message).toMatch(/Sample 2 attempt 1 of 3 used/);
      await reopenVisit();
      await runSample();
      expect(navDiagnostics.getStatus().calibration).toBe("CALIBRATED");
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader()).toMatchObject({ calibAttempts1: 1, calibAttempts2: 2, postP5SamplePassed: true });
    });

    it("keeps the launch incomplete after C2 until the post-P5 sample passes, and the reopen hint asks for it", async () => {
      await mountEnabled();
      await runP2toP4();
      await reopenVisit();
      await runP5();
      expect(navDiagnostics.getStatus().calibration).toBe("C2 OK, post-P5 sample pending");
      await reopenVisit();
      expect(navDiagnostics.getStatus().message).toMatch(/Tap Calib, wait for 'S-pre taken', then Back arm, then Back once/);
      fireEvent.press(screen.getByText("Trace"));
      await flush(10);
      expect(exportedHeader().postP5SamplePassed).toBe(false);
    });
  });

  describe("trial arm gate (D12)", () => {
    it("refuses a trial-kind arm before the launch is CALIBRATED and accepts it after", async () => {
      await mountEnabled();
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      expect(screen.getByText(/Kind: trial/)).toBeTruthy();
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(0);
      expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "notCalibrated" });
      expect(navDiagnostics.getStatus().message).toBe("Not ready: calibration required");
      // Back to calibration kind for the preamble.
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      expect(screen.getByText(/Kind: calibration/)).toBeTruthy();
      await runP2toP4({ expectReadinessText: false });
      await reopenVisit();
      await runP5();
      // C2 alone does not unlock trials.
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(1);
      expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "notCalibrated" });
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      await runSample();
      expect(navDiagnostics.getStatus().calibration).toBe("CALIBRATED");
      await reopenVisit();
      fireEvent.press(screen.getByText(/^Kind:/));
      fireEvent.press(screen.getByText(/^Kind:/));
      await flush();
      fireEvent.press(screen.getByText("Back arm"));
      await flush();
      expect(entriesOf("diag.backAttempt")).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Arm eligibility, open-settle hold and wake gate (section 9.0a)
// ---------------------------------------------------------------------------
describe("Arm eligibility (9.0a)", () => {
  it("refuses Back arm before 500 ms after the open snapshot and turns Ready at the threshold", async () => {
    await mountEnabled(false);
    expect(screen.getByText(/Not ready/)).toBeTruthy();
    expect(screen.queryByText(/Ready:/)).toBeNull();
    await advance(OPEN_SETTLE_MS - 1);
    expect(screen.queryByText(/Ready:/)).toBeNull();
    const before = { ring: ringEntries().length, log: mockLog.length };
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);
    expect(ringEntries().length).toBe(before.ring);
    expect(mockLog.length).toBe(before.log);
    expect(screen.getByText(/Not ready/)).toBeTruthy();
    // A refused arm enters no armed state: the pill's local indicator stays unset.
    expect(screen.queryByText(/\[armed\]/)).toBeNull();

    await advance(1);
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
    expect(screen.getByText(/\[armed\]/)).toBeTruthy();
    const ready = entriesOf("diag.ready");
    expect(ready.some((e) => e.d.eligible === false && e.d.reason === "settling")).toBe(true);
    expect(ready.at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
  });

  it("re-checks eligibility in the arm handler from the clock, independently of the pill state", async () => {
    await mountEnabled(false);
    await advance(400);
    expect(screen.getByText(/Not ready/)).toBeTruthy();
    // The hold timer has not fired, but the clock already says 600 ms since open.
    const spy = jest.spyOn(performance, "now").mockReturnValue(performance.now() + 200);
    try {
      fireEvent.press(screen.getByText("Back arm"));
    } finally {
      spy.mockRestore();
    }
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
  });

  it("invalidates readiness on background, restores it on the wake anchor with no new hold, and holds a visit opened after the return", async () => {
    await mountEnabled();
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    appState("background");
    await flush();
    expect(entriesOf("app.state").at(-1)?.d).toEqual({ state: "background" });
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "background" });
    expect(screen.getByText(/Not ready/)).toBeTruthy();
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);

    await advance(30_000);
    const marker = mockLog.length;
    appState("active");
    // Before the wake anchor resolves the arm is still refused.
    fireEvent.press(screen.getByText("Back arm"));
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);
    await flush(10);
    expect(logSince(marker)).toEqual(["snapshot:wake"]);
    expect(entriesOf("diag.timebase").at(-1)?.d).toMatchObject({ source: "wake", rejected: false, gap: false });
    expect(entriesOf("diag.snapshot").at(-1)?.d.reason).toBe("wake");
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    // No further hold: the visit's open age already satisfies OPEN_SETTLE_MS.
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);

    // A visit opened after the return takes its own open snapshot and hold.
    await openVisit(false);
    expect(screen.getByText(/Not ready/)).toBeTruthy();
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
    await advance(OPEN_SETTLE_MS);
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(2);
  });

  it("detects a device sleep across the lock on the wake anchor and starts a new epoch", async () => {
    await mountEnabled();
    appState("background");
    mockProbe.nativeOffsetS = 700;
    await advance(700_000);
    appState("active");
    await flush(10);
    expect(entriesOf("diag.timebase").at(-1)?.d).toMatchObject({ source: "wake", gap: true, epoch: 1 });
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    expect(exportedHeader()).toMatchObject({ timebaseGaps: 1, epochCount: 2 });
  });

  it("gives up after five rejected wake anchors, faults the probe, and recovers on the next accepted anchor", async () => {
    await mountEnabled();
    appState("background");
    await flush();
    mockProbe.api.snapshot.mockImplementation(async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      return snap;
    });
    const marker = mockLog.length;
    appState("active");
    // The slow snapshot registers its 300 ms timer one microtask after the
    // call; flush first so each advance(300) resolves exactly one attempt.
    await flush();
    for (let i = 0; i < 5; i += 1) {
      await advance(300);
      await advance(200);
    }
    await flush(10);
    expect(logSince(marker).filter((l) => l === "snapshot:wake")).toHaveLength(5);
    expect(entriesOf("diag.timebase").filter((e) => e.d.source === "wake" && e.d.rejected === true)).toHaveLength(5);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: wake anchor/);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);

    mockProbe.api.snapshot.mockImplementation(makeSnapshot);
    await openVisit();
    // Readiness is restored in the trace, but the latched launch keeps the plain stop on the pill.
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Launch-level probe invalidity (section 19, latched) and lifecycle races (9.0a)
// ---------------------------------------------------------------------------
describe("Probe invalidity latch and lifecycle generations", () => {
  it("keeps a probe-faulted launch INVALID through a later nominal calibration and refuses arms", async () => {
    await mountEnabled();
    mockProbe.drainFails = true;
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: drain failed/);
    mockProbe.drainFails = false;
    // v11 (H5): a latched launch records no new calibration: Calib and Header
    // calib are refused, no calibrated mark appears, the latch is never cleared.
    await runP2toP4({ expectReadinessText: false });
    expect(entriesOf("diag.mark").some((e) => e.d.label === "calibrated")).toBe(false);
    expect(entriesOf("diag.snapshot").some((e) => e.d.reason === "calibPreBack")).toBe(false);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: drain failed/);
    fireEvent.press(screen.getByText("Header calib"));
    await flush(10);
    await advance(1000);
    await flush(10);
    expect(mockNav.api.setOptions).not.toHaveBeenCalled();
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: drain failed/);
    expect(navDiagnostics.getStatus().calibration).not.toMatch(/CALIBRATED/);
    // A trial arm is refused on a latched launch (D12 with H5).
    await reopenVisit();
    fireEvent.press(screen.getByText(/^Kind:/));
    fireEvent.press(screen.getByText(/^Kind:/));
    await flush();
    const armsBefore = entriesOf("diag.backAttempt").length;
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(armsBefore);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "notCalibrated" });
    // Every later publication (Trace) shows only the plain-language stop.
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    // The pill renders the message.
    expect(screen.getByText(new RegExp(`^${INVALID_RUN_MESSAGE.replace(/\./g, "\\.")}`))).toBeTruthy();
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    expect(exportedHeader().calibrationStatus).toMatch(/INVALID: drain failed/);
    expect(storedCaptureOrNull()).toBeNull();
  });

  it("keeps the PROBE INVALID indication in the message after a failed calibPreBack snapshot and later hints", async () => {
    await mountEnabled();
    mockProbe.api.snapshot.mockImplementationOnce(async () => {
      throw new Error("snapshot failed");
    });
    fireEvent.press(screen.getByText("Calib"));
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: snapshot failed/);
    // The "S-pre taken" hint, a re-open, background and wake all follow the fault:
    // the operator line stays the plain-language stop and never invites continuing.
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    await openVisit();
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    appState("background");
    await flush();
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    appState("active");
    await flush(10);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    expect(navDiagnostics.getStatus().message).not.toMatch(/probe|anchor|snapshot|wrapper|clock|Ready/);
    // Engineering identity stays in diagnostic state.
    expect(navDiagnostics.getStatus().calibration).toBe("INVALID: snapshot failed (probe fault, V1)");
  });

  it("does not let a stale-generation snapshot with an ACCEPTED anchor establish the epoch while the current wake is pending", async () => {
    await mountEnabled();
    const delayed = (ms: number) => async (reason: string) => {
      const snap = await makeSnapshot(reason);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
      return snap;
    };
    // Generation N: calibPreBack takes 150 ms (u = 75, an acceptable anchor).
    // Generation N+1: the first wake attempt takes 400 ms (u = 200, rejected, retried).
    mockProbe.api.snapshot.mockImplementationOnce(delayed(150)).mockImplementationOnce(delayed(400));
    fireEvent.press(screen.getByText("Calib"));
    await flush();
    appState("background");
    await flush();
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "background" });
    appState("active");
    await flush();
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "noEpoch" });
    // The stale generation-N snapshot resolves with an accepted anchor while the wake is pending.
    await advance(150);
    const stale = entriesOf("diag.timebase").filter((e) => e.d.source === "calibPreBack");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.d.rejected).toBe(false);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "noEpoch" });
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);
    // The current-generation wake resolves (first attempt rejected, retry accepted).
    await advance(250);
    expect(entriesOf("diag.timebase").filter((e) => e.d.source === "wake" && e.d.rejected === true)).toHaveLength(1);
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);
    await advance(200);
    expect(entriesOf("diag.timebase").filter((e) => e.d.source === "wake" && e.d.rejected === false)).toHaveLength(1);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
  });

  it("retries a thrown wake snapshot without faulting and restores readiness on the successful attempt", async () => {
    await mountEnabled();
    appState("background");
    await flush();
    mockProbe.api.snapshot
      .mockImplementationOnce(async () => {
        throw new Error("wake 1");
      })
      .mockImplementationOnce(async () => {
        throw new Error("wake 2");
      });
    appState("active");
    await flush(10);
    expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
    expect(entriesOf("diag.ready").at(-1)?.d.eligible).toBe(false);
    await advance(200);
    expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
    await advance(200);
    expect(entriesOf("diag.snapshot").filter((e) => e.d.reason === "wake" && e.d.probe === "failed")).toHaveLength(2);
    expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
  });

  it("faults the wake anchor only after five thrown attempts", async () => {
    await mountEnabled();
    appState("background");
    await flush();
    mockProbe.api.snapshot.mockImplementation(async () => {
      throw new Error("wake");
    });
    appState("active");
    await flush(10);
    for (let i = 0; i < 4; i += 1) {
      expect(navDiagnostics.getStatus().calibration).toBe("PENDING");
      await advance(200);
    }
    await flush(10);
    expect(entriesOf("diag.snapshot").filter((e) => e.d.reason === "wake" && e.d.probe === "failed")).toHaveLength(5);
    expect(navDiagnostics.getStatus().calibration).toMatch(/INVALID: wake anchor/);
    expect(navDiagnostics.getStatus().message).toBe(INVALID_RUN_MESSAGE);
    mockProbe.api.snapshot.mockImplementation(makeSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Visit identity (9.0a): same-visit re-emissions vs genuinely new visits
// ---------------------------------------------------------------------------
describe("Visit identity", () => {
  it("keeps readiness when Kind/Arm/Anchor re-emit the same visit's ui.detailMount", async () => {
    await mountEnabled();
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    fireEvent.press(screen.getByText(/^Kind:/));
    fireEvent.press(screen.getByText(/^Arm:/));
    fireEvent.press(screen.getByText(/^Anchor:/));
    await flush();
    expect(entriesOf("ui.detailMount").length).toBeGreaterThanOrEqual(4);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
    expect(screen.getByText(/Ready:/)).toBeTruthy();
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(1);
  });

  it("treats a new visitNo/routeKey mount as a new visit with its own open snapshot and hold", async () => {
    await mountEnabled();
    const marker = mockLog.length;
    act(() => {
      navDiagnostics.record("ui.detailMount", {
        routeKey: "recipe/[id]-k2",
        recipeId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        launchNo: 1,
        visitNo: 2,
        visitKind: "trial",
        arm: "A",
        cycle: 1,
        anchor: "A1",
      });
    });
    await flush();
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "visitClosed" });
    fireEvent.press(screen.getByText("Back arm"));
    await flush();
    expect(entriesOf("diag.backAttempt")).toHaveLength(0);
    act(() => {
      navDiagnostics.record("scr.transitionEnd", { routeKey: "recipe/[id]-k2", closing: false });
    });
    await flush(10);
    // The open reason follows the store's visit mode (still calibration here).
    expect(logSince(marker)).toEqual(["snapshot:calibOpen"]);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: false, reason: "settling" });
    await advance(OPEN_SETTLE_MS);
    expect(entriesOf("diag.ready").at(-1)?.d).toEqual({ eligible: true, reason: "eligible" });
  });
});

// ---------------------------------------------------------------------------
// Capture header window flags (9.2 / 9.3 / 9.4, 7.5.7)
// ---------------------------------------------------------------------------
describe("Window sequence validity flags", () => {
  it("records the attempt and escape windows as sequence-valid on an uninterrupted capture", async () => {
    await mountEnabled();
    await calibrate();
    await captureDeadBack();
    expect(storedCapture().header.attemptWindowSequenceValid).toBe(true);
    expect(storedCapture().header.escapeWindowsSequenceValid).toEqual({ swipe: null, jsBack: null });
    await runSwipe();
    expect(storedCapture().header.escapeWindowsSequenceValid).toEqual({ swipe: true, jsBack: null });
    fireEvent.press(screen.getByText("JS back"));
    await flush();
    await advance(3000);
    await flush(10);
    expect(storedCapture().header.escapeWindowsSequenceValid).toEqual({ swipe: true, jsBack: true });
  });

  it("flags the attempt window sequence-invalid when a device sleep splits the passive window", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Back arm"));
    await advance(200);
    fireEvent.press(screen.getByText("Back dead"));
    await flush();
    // Sleep of 2 s between dead0 and dead500: the dead500 anchor detects the gap.
    mockProbe.nativeOffsetS = 2;
    await advance(500);
    await advance(1500);
    await flush(10);
    expect(screen.getByText(/Captured and saved/)).toBeTruthy();
    expect(storedCapture().header.attemptWindowSequenceValid).toBe(false);
    expect(storedCapture().header.timebaseGaps).toBe(1);
    const shouldPopLike = storedCapture().entries.filter((e) => e.k === "diag.snapshot" && e.d.reason === "dead0");
    expect(shouldPopLike[0]?.epoch).toBe(0);
    const dead500 = storedCapture().entries.find((e) => e.k === "diag.snapshot" && e.d.reason === "dead500");
    expect(dead500?.epoch).toBe(1);
  });

  it("translates drained native records inside their epoch with declared intervals", async () => {
    await mountEnabled();
    fireEvent.press(screen.getByText("Back arm"));
    await advance(200);
    mockProbe.drainQueue.push(nativeRecord("shouldPop"));
    await advance(100);
    fireEvent.press(screen.getByText("Trace"));
    await flush(10);
    const pop = entriesOf("native.popDelegate").at(-1);
    expect(pop?.tb).toBe("ok");
    expect(pop?.epoch).toBe(0);
    expect(pop?.tLo).toBeLessThanOrEqual(pop?.t ?? -1);
    expect(pop?.tHi).toBeGreaterThanOrEqual(pop?.t ?? Infinity);
    const attempt = entriesOf("diag.backAttempt")[0];
    expect((pop?.tLo ?? 0) > (attempt?.t ?? Infinity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence across root reconstruction (section 8.3)
// ---------------------------------------------------------------------------
describe("root reconstruction", () => {
  it("re-hydrates the immutable capture byte-identically after the root remounts", async () => {
    const utils = await mountEnabled();
    await captureDeadBack();
    const stored = mockStorage.get(NAV_CAPTURE_STORAGE_KEY);
    utils.unmount();
    navDiagnostics.resetForTests();
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(false);

    renderSettings();
    await flush(10);
    expect(navDiagnostics.getStatus().hasLastCapture).toBe(true);
    fireEvent.press(screen.getByText("Export last Back failure"));
    await flush(10);
    expect(mockClipboard.last).toBe(stored);
  });
});
