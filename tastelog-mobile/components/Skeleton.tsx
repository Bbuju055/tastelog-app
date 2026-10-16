import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { motion, radius, spacing, shadows } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
// Deep import (15.1.2 precedent): keeps the lib/hooks barrel out of this
// component's test module graph.
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

/**
 * Skeleton placeholders shown during initial loading instead of a spinner.
 *
 * - Opacity pulse (0.4 -> 0.8) on a 1000ms loop, RN Animated + useNativeDriver.
 * - Skeleton color is `palette.text4` (theme-aware, no new tokens).
 * - Each primitive runs its own loop; out-of-phase is acceptable and simpler
 *   than threading a shared driver through context.
 * - Shape compositions match their real-content counterparts so the hand-off
 *   to the Phase 10.C content fade-in is visually continuous.
 *
 * Initial load only — pull-to-refresh still uses RefreshControl.
 */

/**
 * Static opacity used under Reduce Motion (G-15.1 ruling: the pulse is
 * decorative and must be suppressed). Midpoint of the 0.4–0.8 pulse
 * envelope — visible in both themes, no new design surface.
 */
const SKELETON_STATIC_OPACITY = 0.6;

function useSkeletonPulse(): Animated.Value {
  const opacity = useRef(new Animated.Value(0.4)).current;
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (reduceMotion) {
      // Cancel an in-flight pulse (covers the async-preference window)
      // and hold a stable, visible opacity. The loop resumes via this
      // effect if Reduce Motion is turned back off while still mounted.
      opacity.stopAnimation();
      opacity.setValue(SKELETON_STATIC_OPACITY);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.8,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);
  return opacity;
}

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

type SkeletonLineProps = {
  width: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
};

export function SkeletonLine({ width, height = 12, style }: SkeletonLineProps) {
  const { palette } = useTheme();
  const opacity = useSkeletonPulse();
  return (
    <Animated.View
      style={[
        {
          width,
          height,
          backgroundColor: palette.text4,
          borderRadius: radius.sm,
          opacity,
        },
        style,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Shape: recipe card (matches components/RecipeCard.tsx layout)
// ---------------------------------------------------------------------------

export function SkeletonRecipeCard() {
  const { palette, theme } = useTheme();
  const s = cardStyles(palette);
  return (
    <View style={[s.container, theme === "light" && shadows.card]}>
      <View style={s.titleRow}>
        <SkeletonLine width="62%" height={19} />
        <SkeletonLine width={36} height={11} />
      </View>
      <View style={s.metaRow}>
        <SkeletonLine width={56} height={16} />
        <SkeletonLine width={38} height={11} />
      </View>
      <View style={s.actionsRow}>
        <SkeletonLine width={18} height={18} />
        <SkeletonLine width={18} height={18} />
      </View>
    </View>
  );
}

function cardStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: {
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      paddingVertical: 6,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.sm,
      marginRight: spacing.xs,
      borderRadius: radius.card,
    },
    titleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: spacing.xs,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    actionsRow: {
      flexDirection: "row",
      gap: spacing.md,
      marginTop: spacing.xs,
    },
  });
}

// ---------------------------------------------------------------------------
// Shape: grocery row (matches grocery item row layout)
// ---------------------------------------------------------------------------

export function SkeletonGroceryRow() {
  const { palette } = useTheme();
  const s = groceryStyles(palette);
  return (
    <View style={s.row}>
      <View style={s.checkbox} />
      <SkeletonLine width="70%" height={15} />
    </View>
  );
}

function groceryStyles(palette: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: palette.divider,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      marginRight: spacing.md,
    },
  });
}

// ---------------------------------------------------------------------------
// Composition: recipe detail (matches app/(app)/recipe/[id].tsx layout)
// ---------------------------------------------------------------------------

export function SkeletonRecipeDetail() {
  return (
    <View style={detailStyles.container}>
      {/* Header badge */}
      <SkeletonLine
        width={90}
        height={20}
        style={{ marginBottom: spacing.base }}
      />

      {/* Title (two lines) */}
      <SkeletonLine
        width="85%"
        height={38}
        style={{ marginBottom: spacing.xs }}
      />
      <SkeletonLine
        width="55%"
        height={38}
        style={{ marginBottom: spacing.base }}
      />

      {/* Meta cards row */}
      <View style={detailStyles.metaRow}>
        <SkeletonLine width={88} height={54} />
        <SkeletonLine width={88} height={54} />
        <SkeletonLine width={88} height={54} />
      </View>

      {/* Ingredients section */}
      <SkeletonLine
        width={110}
        height={18}
        style={{ marginBottom: spacing.md }}
      />
      <SkeletonLine
        width="90%"
        height={14}
        style={{ marginBottom: spacing.sm }}
      />
      <SkeletonLine
        width="78%"
        height={14}
        style={{ marginBottom: spacing.sm }}
      />
      <SkeletonLine
        width="85%"
        height={14}
        style={{ marginBottom: spacing.sm }}
      />
      <SkeletonLine
        width="70%"
        height={14}
        style={{ marginBottom: spacing.sm }}
      />
      <SkeletonLine
        width="82%"
        height={14}
        style={{ marginBottom: spacing.xl }}
      />

      {/* Steps section */}
      <SkeletonLine
        width={80}
        height={18}
        style={{ marginBottom: spacing.md }}
      />
      <SkeletonLine
        width="95%"
        height={14}
        style={{ marginBottom: spacing.xs }}
      />
      <SkeletonLine
        width="88%"
        height={14}
        style={{ marginBottom: spacing.md }}
      />
      <SkeletonLine
        width="92%"
        height={14}
        style={{ marginBottom: spacing.xs }}
      />
      <SkeletonLine width="76%" height={14} />
    </View>
  );
}

const detailStyles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.screen,
    paddingTop: spacing.base,
  },
  metaRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
});

// ---------------------------------------------------------------------------
// Composition: capture wait scene (Phase 15.2.1)
// ---------------------------------------------------------------------------

/**
 * "Recipe materializing" scene for the capture wait on the Add tab.
 *
 * Purely decorative: the container is hidden from assistive technology —
 * the stage text rendered by the Add screen is the accessible status.
 *
 * `stage` maps to the capture stage ladder (0 uploading, 1 analyzing,
 * 2 still working, 3 almost there). Groups accumulate: a group revealed
 * at an earlier stage stays visible. A group animates its reveal only
 * when its stage is reached by an increment observed while the scene is
 * mounted — groups already due at mount render static, so a remount can
 * never replay completed reveals.
 */
export function SkeletonCaptureScene({ stage }: { stage: number }) {
  // Stage at mount: groups at or below this render without entrance.
  const mountStageRef = useRef(stage);
  return (
    <View
      style={sceneStyles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="capture-scene"
    >
      {/* Frame — present from stage 0, never animates (present at mount) */}
      <SceneGroup revealed testID="capture-scene-frame">
        <SkeletonLine width="42%" height={16} style={sceneStyles.frameMark} />
      </SceneGroup>

      {/* Structure — appears at "Analyzing your recipe…" */}
      {stage >= 1 && (
        <SceneGroup revealed={mountStageRef.current >= 1} testID="capture-scene-structure">
          <SkeletonLine width="78%" height={22} style={sceneStyles.title} />
          <View style={sceneStyles.metaRow}>
            <SkeletonLine width={56} height={14} />
            <SkeletonLine width={56} height={14} />
            <SkeletonLine width={56} height={14} />
          </View>
        </SceneGroup>
      )}

      {/* Ingredient lines — fill in at "Still working…" */}
      {stage >= 2 && (
        <SceneGroup revealed={mountStageRef.current >= 2} testID="capture-scene-ingredients">
          <SkeletonLine width={110} height={14} style={sceneStyles.sectionHeader} />
          <SkeletonLine width="85%" height={12} style={sceneStyles.line} />
          <SkeletonLine width="72%" height={12} style={sceneStyles.line} />
          <SkeletonLine width="80%" height={12} style={sceneStyles.line} />
          <SkeletonLine width="64%" height={12} style={sceneStyles.line} />
        </SceneGroup>
      )}

      {/* Method lines — near-complete at "Almost there…" */}
      {stage >= 3 && (
        <SceneGroup revealed={mountStageRef.current >= 3} testID="capture-scene-method">
          <SkeletonLine width={80} height={14} style={sceneStyles.sectionHeader} />
          <SkeletonLine width="95%" height={12} style={sceneStyles.line} />
          <SkeletonLine width="88%" height={12} style={sceneStyles.line} />
          <SkeletonLine width="76%" height={12} style={sceneStyles.line} />
        </SceneGroup>
      )}
    </View>
  );
}

/**
 * One reveal unit of the capture scene. `revealed` groups render at full
 * opacity with no entrance. Un-revealed groups fade in once on mount
 * (they mount when their stage is reached) using the motion tokens; the
 * reveal never replays after completing. Reduce Motion cancels an
 * in-flight reveal and snaps to the completed state; flipping back off
 * after completion does not replay (parent opacity composes with the
 * grandfathered SkeletonLine pulse — intended).
 */
function SceneGroup({
  revealed = false,
  testID,
  children,
}: {
  revealed?: boolean;
  testID?: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(revealed || reduceMotion ? 1 : 0)).current;
  const doneRef = useRef(revealed || reduceMotion);

  useEffect(() => {
    if (doneRef.current) return;
    if (reduceMotion) {
      // Cancel-and-snap (G-15.1 pattern): a preference flip mid-reveal
      // completes the reveal instantly instead of leaving partial opacity.
      opacity.stopAnimation();
      opacity.setValue(1);
      doneRef.current = true;
      return;
    }
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration: motion.duration.base,
      easing: Easing.bezier(...motion.easing.out),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished) doneRef.current = true;
    });
    return () => {
      anim.stop();
    };
  }, [reduceMotion, opacity]);

  return (
    <Animated.View style={{ opacity }} testID={testID}>
      {children}
    </Animated.View>
  );
}

const sceneStyles = StyleSheet.create({
  container: {
    width: "100%",
    paddingVertical: spacing.base,
  },
  frameMark: {
    marginBottom: spacing.md,
  },
  title: {
    marginBottom: spacing.sm,
  },
  metaRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  sectionHeader: {
    marginBottom: spacing.md,
  },
  line: {
    marginBottom: spacing.sm,
  },
});
