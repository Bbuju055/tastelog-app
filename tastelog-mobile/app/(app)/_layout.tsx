import { Stack } from "expo-router";
import { fonts } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { useReducedMotion } from "../../lib/hooks";

export default function AppLayout() {
  const { palette } = useTheme();
  // 15.1.4 audit verdict: iOS modal present durations are NOT config-tunable
  // (react-native-screens wires its duration animator into push/pop only;
  // modal presents go through UIKit at system duration). The only real
  // lever on the fullScreenModal screens is the reduced-motion crossfade
  // below ("fade" → UIModalTransitionStyleCrossDissolve). Normal motion stays
  // platform-default. Push screens and the cook-log sheet are deliberately
  // untouched (back-swipe / pull-down dismiss preserved).
  const reduceMotion = useReducedMotion();

  return (
    <Stack
      initialRouteName="(tabs)"
      screenOptions={{
        headerStyle: { backgroundColor: palette.surface },
        headerTintColor: palette.text1,
        headerTitleStyle: { fontFamily: fonts.bodySemiBold },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="recipe/[id]"
        // headerBackTitle: the native back label otherwise inherits the
        // previous screen's title — the "(tabs)" route group — surfacing an
        // internal name. A truthful "Back" label is a screen-local header
        // option (no navigation-architecture change).
        options={{ title: "Recipe", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="draft/[id]"
        // Same reason as recipe/[id]: without it the back label is "(tabs)".
        options={{ title: "Review Draft", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="review/[id]"
        options={{ title: "Capture Result", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="recipe/edit/[id]"
        // Issue 3: dedicated edit modal. gestureEnabled: false, an
        // unsaved form must never be silently discarded by a swipe; the
        // in-screen Cancel owns the dirty-discard confirmation.
        options={{
          headerShown: false,
          presentation: "modal",
          gestureEnabled: false,
          animation: reduceMotion ? "fade" : "default",
        }}
      />
      <Stack.Screen
        name="recipe/cook/[id]"
        options={{
          headerShown: false,
          presentation: "fullScreenModal",
          animation: reduceMotion ? "fade" : "default",
        }}
      />
      <Stack.Screen
        name="recipe/riff/[id]"
        options={{
          headerShown: false,
          presentation: "fullScreenModal",
          animation: reduceMotion ? "fade" : "default",
        }}
      />
      <Stack.Screen
        name="draft/riff/[id]"
        options={{
          headerShown: false,
          presentation: "fullScreenModal",
          animation: reduceMotion ? "fade" : "default",
        }}
      />
      <Stack.Screen
        name="recipe/cook-log/[id]"
        options={{
          headerShown: false,
          presentation: "modal",
        }}
      />
      <Stack.Screen
        name="how-it-works"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: reduceMotion ? "fade" : "default",
        }}
      />
    </Stack>
  );
}
