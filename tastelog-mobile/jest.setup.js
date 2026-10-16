// Defaults for EXPO_PUBLIC_* env vars consumed by lib/config.ts at module
// load. Required because Phase 13.5 introduced an env import in
// useRiffSession (for the streaming flag), which transitively triggers
// parseEnv() during test imports. ??= preserves any real values set by
// the test runner (e.g. CI overrides) and only fills in defaults when
// the variable is unset. EXPO_PUBLIC_RIFF_STREAMING is intentionally
// NOT set here so existing tests run with streaming disabled by default.
process.env.EXPO_PUBLIC_API_BASE_URL ??= "http://test.local";
process.env.EXPO_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  ImpactFeedbackStyle: { Light: "light" },
}));

// Default no-op stub for expo-speech-recognition. Per-file `jest.mock` calls
// (e.g. the Phase 9.C hook unit tests) override this with richer
// listener-capture semantics. The global stub keeps any test that
// transitively imports useVoiceCommands (e.g. CookingMode screen tests)
// from blowing up at module load.
jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    requestPermissionsAsync: jest
      .fn()
      .mockResolvedValue({ granted: false, canAskAgain: true }),
    requestMicrophonePermissionsAsync: jest
      .fn()
      .mockResolvedValue({ granted: false, canAskAgain: true }),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

// Reanimated official jest support (Phase 15.1.2 — first Reanimated
// consumers: Button/RecipeCard press feedback). setUpTests() installs
// the jest-friendly animation runtime so animated styles resolve to
// their current values in the test tree.
require("react-native-reanimated").setUpTests();

// useScreenTheme uses useFocusEffect from @react-navigation/native.
// In tests without a NavigationContainer, execute the callback immediately.
jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  return {
    ...actual,
    useFocusEffect: (cb) => {
      // Execute the callback on mount, matching focused-screen behavior
      const { useEffect } = require("react");
      useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === "function" ? cleanup : undefined;
      }, [cb]);
    },
  };
});
