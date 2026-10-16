import "react-native-reanimated";
// import "../global.css"; // enable once metro config supports CSS
import * as Sentry from "@sentry/react-native";
import {
  type Href,
  Slot,
  useGlobalSearchParams,
  usePathname,
  useRouter,
  useSegments,
} from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import {
  CormorantGaramond_400Regular,
  CormorantGaramond_500Medium,
  CormorantGaramond_600SemiBold,
  CormorantGaramond_700Bold,
  CormorantGaramond_400Regular_Italic,
} from "@expo-google-fonts/cormorant-garamond";
import {
  Karla_400Regular,
  Karla_500Medium,
  Karla_600SemiBold,
  Karla_700Bold,
} from "@expo-google-fonts/karla";
import QueryProvider from "../providers/QueryProvider";
import { SessionProvider, useSession } from "../lib/auth/context";
import {
  buildNavigableHref,
  decideAuthGateRoute,
  resolveSignedInDestination,
} from "../lib/auth/authGateNavigation";
import {
  getHasOnboardedSnapshot,
  hydrateHasOnboarded,
  subscribeHasOnboarded,
} from "../lib/onboarding/onboardingState";
import {
  acknowledgePostAuthDestination,
  readPostAuthDestinationOnce,
} from "../lib/onboarding/postAuthDestination";
import { lightPalette } from "../theme/palettes";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

import { initSentry } from "../lib/sentry";
// Build 5 Class B diagnostic (section 4.B.9): root owner, mounted only when
// EXPO_PUBLIC_NAV_DIAGNOSTICS is "1" (Build 6 diagnostic profile).
import { NavDiagnosticsRootGate } from "../lib/diagnostics/NavDiagnosticsRoot";

SplashScreen.preventAutoHideAsync().catch(() => {});

initSentry();

function AuthGate() {
  const { session, isLoading } = useSession();
  const { palette } = useTheme();
  const segments = useSegments();
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams();
  const router = useRouter();
  const pendingHrefRef = useRef<string | null>(null);

  // Device-local onboarding completion (15.3.1). Hydration is bounded and
  // fail-open, so the snapshot always settles; it starts at mount so a
  // signed-out fresh launch resolves as fast as session restoration. The
  // bounded hydration may still run during root initialisation for a restored
  // session, but its result can never route an authenticated user into
  // onboarding — the decision ignores it structurally whenever a session
  // exists.
  const hasOnboarded = useSyncExternalStore(
    subscribeHasOnboarded,
    getHasOnboardedSnapshot,
  );
  useEffect(() => {
    hydrateHasOnboarded();
  }, []);

  // Full current href (path + query) for deep-link preservation, mirrored
  // into a ref so the routing effect reads the latest value without
  // re-running on every params identity change.
  const currentHrefRef = useRef<{
    pathname: string;
    params: Record<string, string | string[]>;
  }>({ pathname, params: searchParams });
  currentHrefRef.current = { pathname, params: searchParams };

  const firstSegment = segments[0];

  // Latest session validity, read at the moment of navigation: the durable
  // read is async, and a session can end while it is in flight.
  const hasSessionRef = useRef(session !== null);
  hasSessionRef.current = session !== null;

  useEffect(() => {
    const decision = decideAuthGateRoute({
      isLoading,
      hasSession: session !== null,
      hasOnboarded,
      firstSegment,
    });

    if (decision.kind === "wait" || decision.kind === "stay") return;

    if (decision.kind === "onboarding" || decision.kind === "login") {
      // A signed-out user inside the app group is a deep link — preserve
      // the complete href (including query) across onboarding and login.
      if (firstSegment === "(app)") {
        const { pathname: currentPath, params } = currentHrefRef.current;
        const navigableHref = buildNavigableHref(currentPath, params);
        if (navigableHref) {
          pendingHrefRef.current = navigableHref;
        }
      }
      // Href cast at the assignment boundary (repo convention): typed-route
      // declarations regenerate only on the operator's next `expo start`.
      router.replace(
        (decision.kind === "onboarding" ? "/onboarding" : "/login") as Href,
      );
      return;
    }

    // Signed-in redirect: durable destination (bounded, NON-destructive,
    // memoised read; fails safely to null) → pending deep link → tabs.
    //
    // The read must not consume: this effect re-runs on every fresh `session`
    // object identity (INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED) and on
    // onboarding-flag settlement, so a run cancelled after the await would
    // otherwise destroy the destination its successor needs — silently losing
    // the Add intent on exactly the email-confirmation relaunch it exists for.
    let cancelled = false;
    void (async () => {
      const durableHref = await readPostAuthDestinationOnce();
      // Obsolete run: its successor shares the same in-flight read and will
      // navigate with the same href.
      if (cancelled) return;
      // The session must still be valid at the moment of navigation.
      if (!hasSessionRef.current) return;

      const pendingHref = pendingHrefRef.current;
      pendingHrefRef.current = null;
      router.replace(
        resolveSignedInDestination(durableHref, pendingHref) as Href,
      );

      // Acknowledge only once routing is dispatched, and never await it:
      // a hung or rejected clear must not block navigation (the record's TTL
      // is the backstop if the clear never lands).
      if (durableHref !== null) {
        void acknowledgePostAuthDestination();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, isLoading, hasOnboarded, firstSegment, router]);

  const waitingOnOnboardingState =
    !isLoading && session === null && hasOnboarded === null;

  if (isLoading || waitingOnOnboardingState) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: palette.bg,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <ActivityIndicator size="large" color={palette.text3} />
      </View>
    );
  }

  return <Slot />;
}

export default Sentry.wrap(function RootLayout() {
  const [fontsLoaded] = useFonts({
    CormorantGaramond_400Regular,
    CormorantGaramond_500Medium,
    CormorantGaramond_600SemiBold,
    CormorantGaramond_700Bold,
    CormorantGaramond_400Regular_Italic,
    Karla_400Regular,
    Karla_500Medium,
    Karla_600SemiBold,
    Karla_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: lightPalette.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={lightPalette.text3} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <QueryProvider>
          <SessionProvider>
            <NavDiagnosticsRootGate />
            <AuthGate />
          </SessionProvider>
        </QueryProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
});
