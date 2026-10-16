import { useCallback } from "react";
import { useRouter } from "expo-router";
import { OnboardingPanels, Screen } from "../../components";
import { useScreenTheme } from "../../theme/ThemeProvider";

/**
 * Signed-in onboarding replay (Phase 15.3.2) — "How Tastelog works" from
 * Settings. Presents the same shared panels read-only: leaving by ANY path
 * (Done or Close) simply dismisses. Replay never touches the device-local
 * completion flag or the post-auth destination.
 */
export default function HowItWorksScreen() {
  useScreenTheme("light");
  const router = useRouter();

  const handleComplete = useCallback(() => {
    router.back();
  }, [router]);

  return (
    <Screen>
      <OnboardingPanels mode="replay" onComplete={handleComplete} />
    </Screen>
  );
}
