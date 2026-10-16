import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  findNodeHandle,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Button } from "./Button";
import { fonts, fontSize, motion, spacing } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

/**
 * Shared onboarding panels (Phase 15.3.2).
 *
 * One component, two consumers: the pre-auth first-run route and the
 * signed-in Settings replay. The component itself never touches completion
 * state — `onComplete` reports how the user left (`finish` = walked every
 * panel, `skip` = the always-available skip/close affordance) and the
 * consumer decides what that means. Replay consumers map both to a plain
 * dismiss, so replaying can never mutate the completion flag.
 *
 * Charter (§3): the only motion is a state-driven crossfade on panel change
 * (motion tokens; instant under Reduced Motion). No idle loops, no
 * choreography; every panel is fully comprehensible with zero motion.
 */

export type OnboardingCompletionVia = "finish" | "skip";

type OnboardingPanelsProps = {
  mode: "firstRun" | "replay";
  onComplete: (via: OnboardingCompletionVia) => void;
};

type PanelContent = {
  key: string;
  heading: string;
  body: string;
};

const PANELS: readonly PanelContent[] = [
  {
    key: "capture",
    heading: "Capture any recipe",
    body:
      "Snap a photo of a cookbook page, or paste a link to a recipe online. " +
      "Tastelog reads it and builds a structured recipe for you. If one way " +
      "doesn't work, try the other. Captures that finish are saved as drafts.",
  },
  {
    key: "review",
    heading: "Review, then save",
    body:
      "Every capture becomes a draft first. Check the ingredients and steps, " +
      "fix anything that needs it, then save the recipe to your cookbook.",
  },
  {
    key: "cook",
    heading: "Cook it your way",
    body:
      "Cook step by step, send ingredients to your grocery list, or riff to " +
      "adapt a recipe. Hands-free voice control lives inside cooking mode. " +
      "It asks for the microphone only there, and only if you turn it on.",
  },
] as const;

export function OnboardingPanels({ mode, onComplete }: OnboardingPanelsProps) {
  const { palette } = useTheme();
  const reduceMotion = useReducedMotion();
  const [panelIndex, setPanelIndex] = useState(0);
  const opacity = useRef(new Animated.Value(1)).current;
  const headingRef = useRef<Text | null>(null);
  const hasChangedPanelRef = useRef(false);
  const completedRef = useRef(false);

  const isLast = panelIndex === PANELS.length - 1;
  const panel = PANELS[panelIndex] ?? PANELS[0];

  const complete = useCallback(
    (via: OnboardingCompletionVia) => {
      // Exactly-once: a double tap across Skip/CTA must not double-navigate.
      if (completedRef.current) return;
      completedRef.current = true;
      onComplete(via);
    },
    [onComplete],
  );

  const handleAdvance = useCallback(() => {
    if (isLast) {
      complete("finish");
      return;
    }
    setPanelIndex((current) => Math.min(current + 1, PANELS.length - 1));
  }, [isLast, complete]);

  // State-driven crossfade on panel change; instant under Reduced Motion.
  // The initial mount renders at full opacity (no entrance choreography).
  useEffect(() => {
    if (!hasChangedPanelRef.current) {
      hasChangedPanelRef.current = true;
      return;
    }
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: motion.duration.base,
      easing: Easing.bezier(...motion.easing.out),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [panelIndex, reduceMotion, opacity]);

  // Move screen-reader focus to the new panel's heading so page changes are
  // announced in reading order (heading → body → primary action → skip).
  useEffect(() => {
    if (panelIndex === 0) return;
    const node = findNodeHandle(headingRef.current);
    if (node != null) {
      AccessibilityInfo.setAccessibilityFocus(node);
    }
  }, [panelIndex]);

  const skipLabel = mode === "firstRun" ? "Skip" : "Close";
  const primaryLabel = isLast
    ? mode === "firstRun"
      ? "Start capturing"
      : "Done"
    : "Next";

  const s = createStyles(palette);

  return (
    <View style={s.container}>
      <Animated.View style={[s.panelBody, { opacity }]}>
        {/*
          Panel copy scrolls: heading and body scale without caps (no font-
          scaling limits, per the charter), so at AX-large sizes the text can
          exceed the panel box. Scrolling keeps every panel fully readable
          while the footer controls stay pinned and reachable. Short copy
          still centres via `flexGrow` + `justifyContent`.
        */}
        <ScrollView
          contentContainerStyle={s.panelScrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text
            ref={headingRef}
            accessibilityRole="header"
            style={s.heading}
          >
            {panel.heading}
          </Text>
          <Text style={s.body}>{panel.body}</Text>
        </ScrollView>
      </Animated.View>

      <View style={s.footer}>
        <View
          accessible
          accessibilityLabel={`Panel ${panelIndex + 1} of ${PANELS.length}`}
          style={s.dotsRow}
        >
          {PANELS.map((p, i) => (
            <View
              key={p.key}
              style={[s.dot, i === panelIndex ? s.dotActive : s.dotInactive]}
            />
          ))}
        </View>

        <Button
          title={primaryLabel}
          onPress={handleAdvance}
          accessibilityLabel={primaryLabel}
        />

        <Pressable
          onPress={() => complete("skip")}
          accessibilityRole="button"
          accessibilityLabel={
            mode === "firstRun" ? "Skip onboarding" : "Close"
          }
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
          style={s.skipButton}
        >
          <Text style={s.skipText}>{skipLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: "space-between",
      paddingVertical: spacing.xl,
    },
    panelBody: {
      flex: 1,
    },
    panelScrollContent: {
      flexGrow: 1,
      justifyContent: "center",
    },
    heading: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.hero,
      color: palette.text1,
      marginBottom: spacing.lg,
    },
    body: {
      fontFamily: fonts.body,
      fontSize: fontSize.lg,
      lineHeight: fontSize.lg * 1.5,
      color: palette.text2,
    },
    footer: {
      gap: spacing.md,
    },
    dotsRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    dotActive: {
      backgroundColor: palette.primary,
    },
    dotInactive: {
      backgroundColor: palette.text4,
    },
    skipButton: {
      alignItems: "center",
      paddingVertical: spacing.sm,
      minHeight: 44,
      justifyContent: "center",
    },
    skipText: {
      // text2, not text3: skip is body-size text on a NEW surface, so the
      // charter §3.7 ≥4.5:1 floor applies (light text3 on bg is ~2.9:1).
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
    },
  });
}
