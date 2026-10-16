import { useCallback } from "react";
import { type Href, useRouter } from "expo-router";
import { OnboardingPanels, Screen } from "../components";
import type { OnboardingCompletionVia } from "../components/OnboardingPanels";
import { markHasOnboarded } from "../lib/onboarding/onboardingState";
import { writePostAuthDestination } from "../lib/onboarding/postAuthDestination";
import { useScreenTheme } from "../theme/ThemeProvider";

/**
 * Pre-auth first-run onboarding route (Phase 15.3.1/15.3.2).
 *
 * Reached only by signed-out users whose device-local completion flag is
 * unset (AuthGate decision). Finishing the panels records a durable one-shot
 * post-auth destination (the Add tab) so the first-capture intent survives
 * email confirmation and relaunch; Skip records completion only. Both paths
 * land on login — completion is synchronous in memory, so the AuthGate
 * decision observes it in the same navigation tick.
 */
export default function OnboardingScreen() {
  useScreenTheme("light");
  const router = useRouter();

  const handleComplete = useCallback(
    (via: OnboardingCompletionVia) => {
      if (via === "finish") {
        // Fire-and-forget fail-open write: a lost write only means the
        // post-auth landing falls back to Recipes instead of Add.
        void writePostAuthDestination("/(app)/(tabs)/add");
      }
      markHasOnboarded();
      router.replace("/login" as Href);
    },
    [router],
  );

  return (
    <Screen>
      <OnboardingPanels mode="firstRun" onComplete={handleComplete} />
    </Screen>
  );
}
