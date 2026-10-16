import { useCallback, useEffect, useRef } from "react";
import { Animated, Pressable, View, Text, StyleSheet } from "react-native";
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import type { RecipeSearchResult } from "../lib/api/schemas";
import { fonts, fontSize, motion, spacing, radius, shadows } from "../theme";
import type { ThemePalette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeProvider";
import { hapticTap } from "../lib/haptics/haptics";
// Deep import on purpose (NOT the lib/hooks barrel) — see Button.tsx.
import { useReducedMotion } from "../lib/hooks/useReducedMotion";

type RecipeCardProps = {
  recipe: RecipeSearchResult;
  onPress: (recipe: RecipeSearchResult) => void;
  onToggleFavorite: (recipe: RecipeSearchResult) => void;
  onAddToGrocery?: (recipe: RecipeSearchResult) => void;
  groceryPending?: boolean;
  onLongPress?: (recipe: RecipeSearchResult) => void;
  selected?: boolean;
  /**
   * Phase 10.G — staggered entrance opacity supplied by `useStaggeredEntrance`.
   * When provided, the card fades in via this value. Undefined → no entrance
   * animation, card renders at full opacity (rows beyond the animation cap).
   */
  entranceOpacity?: Animated.Value;
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RecipeCard({
  recipe,
  onPress,
  onToggleFavorite,
  onAddToGrocery,
  groceryPending,
  onLongPress,
  selected,
  entranceOpacity,
}: RecipeCardProps) {
  const { palette, theme } = useTheme();
  const s = createStyles(palette);
  const firstTag = recipe.tags[0] ?? null;
  const reduceMotion = useReducedMotion();
  const pressScale = useSharedValue(1);
  const pressOpacity = useSharedValue(1);

  const handlePressIn = useCallback(() => {
    if (reduceMotion) {
      pressScale.value = 0.98;
      pressOpacity.value = 0.9;
    } else {
      pressScale.value = withSpring(0.98, motion.spring.touch);
      pressOpacity.value = withSpring(0.9, motion.spring.touch);
    }
  }, [pressScale, pressOpacity, reduceMotion]);

  const handlePressOut = useCallback(() => {
    if (reduceMotion) {
      pressScale.value = 1;
      pressOpacity.value = 1;
    } else {
      pressScale.value = withSpring(1, motion.spring.touch);
      pressOpacity.value = withSpring(1, motion.spring.touch);
    }
  }, [pressScale, pressOpacity, reduceMotion]);

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
    opacity: pressOpacity.value,
  }));

  // 15.1.5 — gold-fill pop when a recipe BECOMES favorited. The ref seeds
  // from the current prop so a virtualized remount of an already-favorited
  // card observes no transition (no scroll-back re-pop). Unfavorite is
  // instant. A failed-unfavorite rollback (false→true) replays the pop —
  // accepted: the star is re-asserting saved state.
  const starScale = useSharedValue(1);
  const wasFavoriteRef = useRef(recipe.favorite);

  useEffect(() => {
    if (recipe.favorite && !wasFavoriteRef.current && !reduceMotion) {
      starScale.value = withSequence(
        withTiming(1.3, {
          duration: motion.duration.fast,
          easing: Easing.bezier(...motion.easing.out),
        }),
        withSpring(1, motion.spring.touch),
      );
    }
    wasFavoriteRef.current = recipe.favorite;
  }, [recipe.favorite, reduceMotion, starScale]);

  const starStyle = useAnimatedStyle(() => ({
    transform: [{ scale: starScale.value }],
  }));

  return (
    <Animated.View style={{ opacity: entranceOpacity ?? 1 }}>
    <Reanimated.View style={pressStyle}>
      <Pressable
        onPress={() => onPress(recipe)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onLongPress={onLongPress ? () => onLongPress(recipe) : undefined}
        accessibilityRole="button"
        style={[
          s.container,
          theme === "light" && shadows.card,
          selected && s.containerSelected,
        ]}
      >
        {/* Title row */}
        <View style={s.titleRow}>
          <Text style={s.title} numberOfLines={1}>
            {recipe.title?.trim() ? recipe.title : "Untitled recipe"}
          </Text>
          <Text style={s.date}>{formatDate(recipe.created_at)}</Text>
        </View>

        {/* Meta row */}
        <View style={s.metaRow}>
          {firstTag && (
            <View style={s.tagPill}>
              <Text style={s.tagPillText}>{firstTag.toUpperCase()}</Text>
            </View>
          )}
          {recipe.cook_time != null && (
            <Text style={s.metaText}>{recipe.cook_time}</Text>
          )}
          {recipe.cook_time == null && recipe.prep_time != null && (
            <Text style={s.metaText}>{recipe.prep_time}</Text>
          )}
          {recipe.parent_recipe_id && (
            <Text
              style={s.metaText}
              accessibilityLabel="Riff recipe"
            >
              Riff
            </Text>
          )}
        </View>

        {/* Actions row */}
        <View style={s.actionsRow}>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              hapticTap();
              onToggleFavorite(recipe);
            }}
            accessibilityRole="button"
            accessibilityLabel={recipe.favorite ? "Remove from favorites" : "Add to favorites"}
            accessibilityState={{ selected: recipe.favorite }}
            hitSlop={8}
            style={s.actionButton}
          >
            <Reanimated.View style={starStyle}>
              <Text style={[s.star, recipe.favorite && s.starActive]}>
                {recipe.favorite ? "\u2605" : "\u2606"}
              </Text>
            </Reanimated.View>
          </Pressable>
          {onAddToGrocery && (
            <Pressable
              onPress={(e) => {
                e?.stopPropagation?.();
                if (!groceryPending) {
                  hapticTap();
                  onAddToGrocery(recipe);
                }
              }}
              disabled={groceryPending}
              accessibilityRole="button"
              accessibilityLabel="Add to grocery list"
              hitSlop={8}
              style={[s.actionButton, groceryPending && { opacity: 0.4 }]}
            >
              <Ionicons name="cart-outline" size={18} color={palette.text3} />
            </Pressable>
          )}
        </View>
      </Pressable>
    </Reanimated.View>
    </Animated.View>
  );
}

function createStyles(palette: ThemePalette) {
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
    containerSelected: {
      backgroundColor: palette.selected,
      borderWidth: 1,
      borderColor: palette.selectedBorder,
    },
    titleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "baseline",
      marginBottom: spacing.xs,
    },
    title: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.lg,
      color: palette.text1,
      flex: 1,
      marginRight: spacing.md,
      letterSpacing: -0.2,
    },
    date: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text4,
      flexShrink: 0,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    tagPill: {
      backgroundColor: palette.pillBg,
      paddingHorizontal: spacing.sm + 1,
      paddingVertical: 3,
      borderRadius: radius.sm,
    },
    tagPillText: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.sm,
      color: palette.pillText,
      letterSpacing: 0.5,
    },
    metaText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text4,
    },
    actionsRow: {
      flexDirection: "row",
      gap: spacing.md,
      marginTop: spacing.xs,
    },
    actionButton: {
      padding: spacing.xs,
    },
    star: {
      fontSize: fontSize.md,
      color: palette.starEmpty,
    },
    starActive: {
      color: palette.star,
    },
  });
}
