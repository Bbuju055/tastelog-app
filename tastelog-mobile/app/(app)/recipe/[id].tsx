import { useState, useMemo, useRef, useEffect, type ReactNode } from "react";
import { View, Text, ScrollView, TextInput, Pressable, Alert, Animated, Easing, Linking, StyleSheet } from "react-native";
// RN Easing (above) drives the legacy 10.C content fade; Reanimated's Easing
// is aliased to avoid the identifier collision.
import Reanimated, {
  Easing as ReEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Swipeable from "react-native-gesture-handler/Swipeable";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen, Button, ErrorState, SkeletonRecipeDetail, Toast, useToast } from "../../../components";
import { useRecipe } from "../../../lib/hooks/useRecipe";
import { useDeleteRecipe } from "../../../lib/hooks/useDeleteRecipe";
import { useRemakeGroceryList, useUpdateRecipeTags, useGroceryLists, useGroceryPicker } from "../../../lib/hooks";
import { useCookEvents } from "../../../lib/hooks/useCookEvents";
import { useDeleteCookEvent } from "../../../lib/hooks/useDeleteCookEvent";
import { useSession } from "../../../lib/auth/context";
import { hapticTap } from "../../../lib/haptics/haptics";
// Deep import on purpose (NOT the lib/hooks barrel) — the detail-screen test
// suites mock the barrel as object literals; see Button.tsx precedent.
import { useReducedMotion } from "../../../lib/hooks/useReducedMotion";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
// Build 5 Class B diagnostic (section 4.B.10): screen listeners, lifecycle
// records, pill mount, options-built counter and calibration action. All of
// it is inert unless EXPO_PUBLIC_NAV_DIAGNOSTICS is "1" (Build 6 only).
import { HEADER_CALIB_TITLE, navDiagnostics } from "../../../lib/diagnostics/navTrace";
import {
  NavDiagnosticsPill,
  useNavDiagnosticsScreen,
} from "../../../lib/diagnostics/NavDiagnosticsPill";
import type { CookEventResponse, IngredientResponse } from "../../../lib/api/schemas";
import { isApiError } from "../../../lib/errors";
import {
  RECENT_COOKS_QUERY_KEY,
  RECIPES_QUERY_KEY,
  cookEventsQueryKey,
  recipeDetailQueryKey,
} from "../../../lib/queryKeys";
import { scaleIngredient } from "../../../lib/ingredients/scaleIngredient";
import { formatIngredient as formatScaledIngredient } from "../../../lib/ingredients/formatIngredient";
import { parseServings, deriveScaleFactor } from "../../../lib/ingredients/scaling";
import { buildGroceryOverrideItems, shouldBlockScaledAdd } from "../../../lib/ingredients";
import { getMergeToastMessage } from "../../../lib/grocery/mergeToastMessage";
import { ONE } from "../../../lib/ingredients/rational";
import { fonts, fontSize, lineHeight, motion, spacing, radius } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";
import type { FormattedIngredient } from "../../../lib/ingredients/formatIngredient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byPosition = <T extends { position: number | null }>(a: T, b: T) =>
  (a.position ?? 0) - (b.position ?? 0);

/** Extract display domain from a URL (strip protocol, path, query). */
function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Cook history helpers
// ---------------------------------------------------------------------------

function formatCookDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days < 1) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderStars(rating: number): string {
  return "\u2605".repeat(rating);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * 15.1.5 — ingredient checklist row (same-file extraction, mirrors the
 * GroceryItemRow-in-grocery.tsx shape). The content dims smoothly between
 * checked/unchecked; the checkbox fill + checkmark stay INSTANT — they are
 * the true state indicator, the dim is emphasis. Opacity seeds from the
 * current checked state so a row that mounts checked appears dimmed
 * immediately (no wrong-default first frame). Haptics stay in the parent's
 * toggleIngredientCheck.
 */
const INGREDIENT_CHECKED_OPACITY = 0.3;

function IngredientRow({
  formatted,
  isChecked,
  isLast,
  onToggle,
  reduceMotion,
  s,
}: {
  formatted: FormattedIngredient;
  isChecked: boolean;
  isLast: boolean;
  onToggle: () => void;
  reduceMotion: boolean;
  s: ReturnType<typeof createStyles>;
}) {
  const contentOpacity = useSharedValue(
    isChecked ? INGREDIENT_CHECKED_OPACITY : 1,
  );

  useEffect(() => {
    const target = isChecked ? INGREDIENT_CHECKED_OPACITY : 1;
    if (reduceMotion) {
      contentOpacity.value = target;
    } else {
      contentOpacity.value = withTiming(target, {
        duration: motion.duration.fast,
        easing: ReEasing.bezier(...motion.easing.out),
      });
    }
  }, [isChecked, reduceMotion, contentOpacity]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  const prepSuffix = formatted.prep ? `, ${formatted.prep}` : "";

  return (
    <Pressable
      onPress={onToggle}
      style={[s.ingredientRow, !isLast && s.ingredientRowBorder]}
    >
      <View style={[s.checkbox, isChecked && s.checkboxChecked]}>
        {isChecked && <Text style={s.checkmark}>{"✓"}</Text>}
      </View>
      <Reanimated.View style={[s.ingredientContent, contentStyle]}>
        <Text style={s.ingredientText}>
          {formatted.main}{prepSuffix}
        </Text>
        {formatted.annotation && (
          <Text style={s.ingredientAnnotation}>
            {" "}{formatted.annotation}
          </Text>
        )}
        {formatted.showNotScaled && (
          <Text style={s.ingredientNotScaled}> not scaled</Text>
        )}
      </Reanimated.View>
    </Pressable>
  );
}

export default function RecipeDetailScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);

  const { id } = useLocalSearchParams<{ id?: string }>();
  const recipeId = typeof id === "string" ? id : undefined;
  const router = useRouter();
  const { data: recipe, error, isLoading, refetch } = useRecipe(recipeId);
  const deleteMutation = useDeleteRecipe();
  const queryClient = useQueryClient();
  // Issue 2 (C5) + Issue 3 (4.1) + Build 4 (C3): ONE shared
  // duplicate-activation guard owns EVERY direct push from this screen
  // (Riff, Edit, Cook, Log, cook-history edit, toast View List), so
  // cross-action double navigation is structurally impossible. Unlocks on
  // focus regain when the pushed screen dismisses.
  const navGuard = useNavigationGuard();
  const remakeMutation = useRemakeGroceryList();
  const { lists: groceryLists, isLoading: isGroceryListsLoading } = useGroceryLists();
  const { pickList } = useGroceryPicker(groceryLists, isGroceryListsLoading);
  const tagsMutation = useUpdateRecipeTags();
  const { data: cookEvents } = useCookEvents(recipeId);
  const deleteCookMutation = useDeleteCookEvent();
  const deletingCookEventIdsRef = useRef<Set<string>>(new Set());
  const { session } = useSession();
  const [newTag, setNewTag] = useState("");
  const [desiredServings, setDesiredServings] = useState("");
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set());
  const [activeStep, setActiveStep] = useState(0);

  // 15.1.5 — ingredient-check dim animation gate.
  const reduceMotion = useReducedMotion();

  // Content fade-in on first load (10.C; literals → motion tokens in 15.1.5)
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    if (reduceMotion) {
      // G-15.1: land the entrance instantly — including when the async
      // preference resolves true after a fade already started. Runs ahead
      // of the fire-once guard so it can never block final-state repair.
      hasAnimatedRef.current = true;
      contentOpacity.stopAnimation();
      contentOpacity.setValue(1);
      return;
    }
    if (!isLoading && !hasAnimatedRef.current) {
      hasAnimatedRef.current = true;
      const fade = Animated.timing(contentOpacity, {
        toValue: 1,
        duration: motion.duration.base,
        easing: Easing.bezier(...motion.easing.out),
        useNativeDriver: true,
      });
      fade.start();
      return () => fade.stop();
    }
    if (!isLoading) {
      // Build 4 (C2) convergence repair: the one-shot fade above may have
      // been stopped by this effect's cleanup (isLoading flip mid-fade).
      // Renderable content must always converge to fully visible; an
      // interrupted fade becomes a one-frame jump-cut, never a blank screen.
      contentOpacity.setValue(1);
    }
  }, [isLoading, contentOpacity, reduceMotion]);

  // Toast state + timer lifecycle — shared machine (15.0.4)
  const { toast, showToast, dismissToast, toastOpacity } = useToast();

  // Build 5 Class B diagnostic, P5 (v11, plan 23.8/23.9): the
  // header-calibration action changes the header config's title (a native
  // config prop) and restores it; `headerTitle: undefined` falls back to the
  // layout's static title. A headerRight re-application never reaches the
  // native header on this stack, so it is no longer used as the stimulus.
  const navDiag = useNavDiagnosticsScreen({
    recipeId,
    guardLocked: navGuard.locked,
    toastVisible: toast !== null,
    setHeaderCalibTitle: (active, setOptions) =>
      setOptions({ headerTitle: active ? HEADER_CALIB_TITLE : undefined }),
  });

  const baseServings = recipe ? parseServings(recipe.servings) : null;
  const hasScaleableIngredients = recipe
    ? recipe.ingredients.some((ing) => ing.quantity != null)
    : false;
  const scalingEnabled = baseServings != null && hasScaleableIngredients;
  const scaleFactor = scalingEnabled
    ? deriveScaleFactor(baseServings, desiredServings)
    : null;
  const effectiveFactor = scaleFactor ?? ONE;

  const scaledIngredients = useMemo(() => {
    if (!recipe) return [];
    const sorted = [...recipe.ingredients].sort(byPosition);
    return sorted.map((ing) => {
      const result = scaleIngredient(ing, effectiveFactor);
      const formatted = formatScaledIngredient(result, ing, effectiveFactor);
      return { ingredient: ing, result, formatted };
    });
  }, [recipe, effectiveFactor]);

  function toggleIngredientCheck(key: string) {
    hapticTap();
    setCheckedIngredients((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleAddTag() {
    const trimmed = newTag.trim();
    if (!trimmed || !recipeId || !recipe) return;
    const exists = recipe.tags.some(
      (t) => t.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setNewTag("");
      return;
    }
    tagsMutation.mutate({
      recipeId,
      tags: [...recipe.tags, trimmed],
    });
    setNewTag("");
  }

  function handleRemoveTag(tag: string) {
    if (!recipeId || !recipe) return;
    hapticTap();
    tagsMutation.mutate({
      recipeId,
      tags: recipe.tags.filter((t) => t !== tag),
    });
  }

  function handleAddToGrocery() {
    if (!recipeId || remakeMutation.isPending || isGroceryListsLoading) return;
    navDiagnostics.record("grocery.press", {});
    const items = buildGroceryOverrideItems(scaledIngredients, scaleFactor);

    if (shouldBlockScaledAdd(scaleFactor, items)) {
      if (__DEV__) {
        console.warn("[ScalingSafety] Empty override items for scaled recipe", {
          recipeId,
          scaleFactor,
        });
      }
      Alert.alert(
        "Scaling Error",
        "Couldn't add scaled ingredients. Please try again.",
      );
      return;
    }

    pickList((listId, wasCreated) => {
      navDiagnostics.record("grocery.mutation", { phase: "start" });
      remakeMutation.mutate(
        {
          recipe_id: recipeId,
          ...(items ? { items } : {}),
          ...(listId ? { list_id: listId } : {}),
        },
        {
          onSuccess: (data) => {
            navDiagnostics.record("grocery.mutation", { phase: "success" });
            showToast({
              message: getMergeToastMessage(
                data.list.display_name ?? data.list.name,
                data.items_added,
                data.items_merged,
              ),
            });
          },
          onError: () => {
            navDiagnostics.record("grocery.mutation", { phase: "error" });
            Alert.alert(
              "Error",
              wasCreated
                ? "List created but items couldn't be added. Try again from Recipes."
                : "Couldn't add to grocery list. Please try again.",
            );
          },
        },
      );
    });
  }

  function handleDelete() {
    if (!recipeId) return;
    Alert.alert(
      "Delete Recipe",
      "This recipe will be permanently deleted. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleteMutation.mutate(recipeId, {
              onSuccess: () => {
                router.back();
              },
            });
          },
        },
      ],
    );
  }

  function handleStartCooking() {
    if (!recipeId) return;
    // "Actually scaled" means the user has entered a servings value that
    // produces a real factor change. Reference-equality against ONE
    // captures the documented short-circuit from deriveScaleFactor
    // (pinned by scaling.test.ts). Both null (unparseable) and ONE (equal
    // to base) are "unscaled" for the purpose of this handoff — the cook
    // screen receives no param and renders unscaled identically.
    const trimmedServings = desiredServings.trim();
    const isScaled = scaleFactor !== null && scaleFactor !== ONE;
    navGuard.guard(() =>
      router.push({
        pathname: "/recipe/cook/[id]",
        params: isScaled
          ? { id: recipeId, desiredServings: trimmedServings }
          : { id: recipeId },
      }),
    );
  }

  function handleOpenRiff() {
    if (!recipeId) return;
    // Issue 2 (C3/C5): the Riff Button passes haptic={false} and the
    // handler owns the single tap haptic inside the guard, so a discarded
    // second tap never buzzes.
    navGuard.guard(() => {
      hapticTap();
      router.push({
        pathname: "/recipe/riff/[id]",
        params: { id: recipeId },
      });
    });
  }

  const editDisabled =
    deleteMutation.isPending || navGuard.locked || recipe?.content_rev == null;

  function handleOpenEdit() {
    // Handler no-op guard alongside disabled + accessibilityState so
    // VoiceOver cannot activate the control while locked (Issue 3, 4.1).
    if (!recipeId || editDisabled) return;
    navGuard.guard(() => {
      hapticTap();
      router.push({
        pathname: "/recipe/edit/[id]",
        params: { id: recipeId },
      });
    });
  }

  function handleDeletedConvergence() {
    // External-delete convergence (Issue 3, section 10): purge this
    // recipe's caches and converge EXPLICITLY on the Recipes destination
    // (the same canonical target the edit screen uses). Never
    // history-dependent: a deep-link entry must land on Recipes too.
    if (recipeId) {
      queryClient.removeQueries({ queryKey: recipeDetailQueryKey(recipeId) });
      queryClient.removeQueries({ queryKey: cookEventsQueryKey(recipeId) });
    }
    void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: RECENT_COOKS_QUERY_KEY });
    router.navigate("/(app)/(tabs)");
  }

  function handleIMadeThis() {
    if (!recipeId) return;
    const isScaled = scaleFactor !== null && scaleFactor !== ONE;
    const trimmedServings = desiredServings.trim();
    navGuard.guard(() =>
      router.push({
        pathname: "/recipe/cook-log/[id]",
        params: {
          id: recipeId,
          from: "detail",
          ...(isScaled && trimmedServings
            ? { scale: `${trimmedServings} servings` }
            : {}),
        },
      }),
    );
  }

  function handleEditCookEvent(event: CookEventResponse) {
    if (!recipeId) return;
    // Haptic inside the guard (Issue 2 C3/C5 precedent): a discarded
    // second tap never buzzes.
    navGuard.guard(() => {
      hapticTap();
      router.push({
        pathname: "/recipe/cook-log/[id]",
        params: {
          id: recipeId,
          from: "detail",
          editEventId: event.id,
          ...(event.rating != null ? { rating: String(event.rating) } : {}),
          ...(event.notes ? { notes: event.notes } : {}),
          ...(event.scale ? { scale: event.scale } : {}),
        },
      });
    });
  }

  function handleDeleteCookEvent(cookEventId: string) {
    if (!recipeId) return;
    // Synchronous per-event guard (15.2.4-CF-RC1): a second tap on the same
    // row before React re-renders must not issue a duplicate DELETE. The ref
    // gates per event id, so unrelated rows still delete independently.
    // mutateAsync (not per-call mutate callbacks): its promise settles with
    // THIS mutation even after a newer mutate call detaches the shared
    // observer, so the guard entry can never leak.
    if (deletingCookEventIdsRef.current.has(cookEventId)) return;
    deletingCookEventIdsRef.current.add(cookEventId);
    hapticTap();
    deleteCookMutation
      .mutateAsync({ cookEventId, recipeId })
      .catch(() => {
        // Failure surface (rollback + warning haptic) is owned by the hook.
      })
      .finally(() => {
        deletingCookEventIdsRef.current.delete(cookEventId);
      });
  }

  if (!recipeId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid recipe ID.</Text>
      </Screen>
    );
  }

  if (isLoading) {
    return (
      <Screen style={{ paddingHorizontal: 0 }}>
        <SkeletonRecipeDetail />
      </Screen>
    );
  }

  // Issue 3 (section 10): an external delete (404) is distinguished from
  // other errors, the ruled copy + a single safe return, never a generic
  // retryable terminal state (retrying a deleted recipe cannot succeed).
  if (error && isApiError(error) && error.status === 404) {
    return (
      <Screen style={s.centered}>
        <Text style={s.deletedTitle}>Recipe Deleted</Text>
        <Text style={s.deletedBody}>
          This recipe was deleted and is no longer available.
        </Text>
        <View style={s.deletedAction}>
          <Button title="Back to Recipes" onPress={handleDeletedConvergence} />
        </View>
      </Screen>
    );
  }

  if (error || !recipe) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={error?.message ?? "Failed to load recipe."}
          onRetry={refetch}
        />
      </Screen>
    );
  }

  const sortedSteps = [...recipe.steps].sort(byPosition);
  const firstTag = recipe.tags[0] ?? null;
  const hasBadge = Boolean(
    firstTag || recipe.cook_time || recipe.parent_recipe_id,
  );

  // Deterministic 2×2 workflow-action grid. Cook is the filled primary; the
  // rest share the subtle accent-surface tier. The list is chunked into two
  // explicit rows so an ineligible Grocery reflows (Cook · Log / Riff) rather
  // than leaving a blank cell. Visible copy is compact (Cook/Grocery/Log/Riff);
  // accessibility labels stay context-complete since the grid precedes the name.
  const actions: { key: string; subtle: boolean; node: ReactNode }[] = [
    {
      key: "cook",
      subtle: false,
      node: (
        <Button
          title="Cook"
          onPress={handleStartCooking}
          disabled={sortedSteps.length === 0}
          fullWidth
          accessibilityLabel={`Start cooking ${recipe.title}`}
        />
      ),
    },
    ...(scaledIngredients.length > 0
      ? [
          {
            key: "grocery",
            subtle: true,
            node: (
              <Button
                title="Grocery"
                onPress={handleAddToGrocery}
                variant="outline"
                loading={remakeMutation.isPending}
                fullWidth
                accessibilityLabel={
                  remakeMutation.isPending
                    ? `Adding ${recipe.title} to grocery list`
                    : `Add ${recipe.title} to grocery list`
                }
              />
            ),
          },
        ]
      : []),
    {
      key: "log",
      subtle: true,
      node: (
        <Button
          title="Log"
          onPress={handleIMadeThis}
          variant="outline"
          fullWidth
          accessibilityLabel={`Log ${recipe.title} as made`}
        />
      ),
    },
    {
      key: "riff",
      subtle: true,
      node: (
        <Button
          title="Riff"
          onPress={handleOpenRiff}
          variant="outline"
          fullWidth
          haptic={false}
          // Issue 2: locked while a guarded push is in flight, and while a
          // recipe deletion is pending (a riff anchored to a disappearing
          // recipe would fail).
          disabled={navGuard.locked || deleteMutation.isPending}
          accessibilityLabel={`Riff on ${recipe.title}`}
        />
      ),
    },
  ];
  const actionRows = [actions.slice(0, 2), actions.slice(2)];

  // Issue 3 (4.1): headerRight Edit entry (declared new pattern). A
  // Pressable with REAL minimum 44pt geometry (hitSlop is supplemental
  // only); disabled + accessibilityState + handler no-op guard so VoiceOver
  // cannot activate it while locked; the single tap haptic lives inside the
  // shared guard. Same fresh-function-per-render identity as before (F9);
  // the diagnostic counter below samples how often it is built.
  const renderHeaderRight = () => (
    <Pressable
      onPress={handleOpenEdit}
      disabled={editDisabled}
      accessibilityRole="button"
      accessibilityLabel={`Edit recipe ${recipe.title}`}
      accessibilityState={{ disabled: editDisabled }}
      style={s.headerEditControl}
      testID="recipe-edit-entry"
    >
      <Text
        style={[
          s.headerEditText,
          editDisabled && s.headerEditTextDisabled,
        ]}
      >
        Edit
      </Text>
    </Pressable>
  );
  navDiagnostics.noteOptionsBuilt();

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <Stack.Screen options={{ headerRight: renderHeaderRight }} />
      <Animated.View style={{ opacity: contentOpacity, flex: 1 }}>
      <ScrollView
        testID="recipe-detail-scroll"
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={true}
      >
        {/* Top workflow action grid: two explicit rows (see `actions`). */}
        <View testID="recipe-action-group" style={s.actionGrid}>
          {actionRows.map((row, ri) => (
            <View
              key={ri}
              testID={`recipe-action-row-${ri}`}
              style={ri === 0 ? s.actionRow : [s.actionRow, s.actionRowSpacing]}
            >
              {row.map((a) => (
                <View
                  key={a.key}
                  style={a.subtle ? [s.actionCell, s.actionCellSubtle] : s.actionCell}
                >
                  {a.node}
                </View>
              ))}
            </View>
          ))}
        </View>

        {/* Title */}
        <Text style={s.title}>{recipe.title}</Text>

        {/* Source link */}
        {recipe.source_url ? (
          <Pressable onPress={() => Linking.openURL(recipe.source_url!)}>
            <Text style={s.sourceLink}>
              {extractDomain(recipe.source_url)} {"\u2197"}
            </Text>
          </Pressable>
        ) : null}

        {/* Header badge — rendered below the title/source, and only when it
            has meaningful content (no empty pill above the title). */}
        {hasBadge && (
          <View testID="recipe-header-badge" style={s.headerBadge}>
            {firstTag && (
              <>
                <Text style={s.headerBadgeTag}>{firstTag.toUpperCase()}</Text>
                {(recipe.cook_time || recipe.parent_recipe_id) && <View style={s.headerBadgeDot} />}
              </>
            )}
            {recipe.cook_time && (
              <>
                <Text style={s.headerBadgeTime}>{recipe.cook_time}</Text>
                {recipe.parent_recipe_id && <View style={s.headerBadgeDot} />}
              </>
            )}
            {recipe.parent_recipe_id && (
              <Text style={s.headerBadgeTime} accessibilityLabel="Riff recipe">
                {recipe.riff_label ? `Riff · ${recipe.riff_label}` : "Riff"}
              </Text>
            )}
          </View>
        )}

        {/* Meta cards */}
        {(recipe.servings || recipe.prep_time || recipe.cook_time) && (
          <View style={s.metaCards}>
            {recipe.cook_time && (
              <View style={s.metaCard}>
                <Text style={s.metaCardLabel}>Cook time</Text>
                <Text style={s.metaCardValue}>{recipe.cook_time}</Text>
              </View>
            )}
            {recipe.servings && (
              <View style={s.metaCard}>
                <Text style={s.metaCardLabel}>Servings</Text>
                <Text style={s.metaCardValue}>{recipe.servings}</Text>
              </View>
            )}
            <View style={s.metaCard}>
              <Text style={s.metaCardLabel}>Ingredients</Text>
              <Text style={s.metaCardValue}>{recipe.ingredients.length}</Text>
            </View>
          </View>
        )}

        {/* Tags */}
        <View style={s.tagsSection}>
          {recipe.tags.length > 0 && (
            <View style={s.tagsRow}>
              {recipe.tags.map((tag) => (
                <Pressable
                  key={tag}
                  onPress={() => handleRemoveTag(tag)}
                  disabled={tagsMutation.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove tag ${tag}`}
                  style={[
                    s.tagChip,
                    tagsMutation.isPending && s.tagChipDisabled,
                  ]}
                >
                  <Text style={s.tagText}>{tag}</Text>
                  <Text style={s.tagRemove}>{"\u00d7"}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={s.tagInputRow}>
            <TextInput
              style={s.tagInput}
              placeholder="Add tag…"
              placeholderTextColor={palette.text4}
              value={newTag}
              onChangeText={setNewTag}
              onSubmitEditing={() => {
                if (newTag.trim()) hapticTap();
                handleAddTag();
              }}
              returnKeyType="done"
              maxLength={50}
              autoCorrect={false}
              autoCapitalize="none"
              editable={!tagsMutation.isPending}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
            />
            <Button
              title="Add"
              onPress={handleAddTag}
              disabled={tagsMutation.isPending || !newTag.trim()}
              size="sm"
            />
          </View>
        </View>

        {/* Scaling input */}
        {scalingEnabled && (
          <View style={s.scalingRow}>
            <Text style={s.scalingLabel}>Scale to</Text>
            <TextInput
              style={s.scalingInput}
              value={desiredServings}
              onChangeText={setDesiredServings}
              placeholder={String(baseServings)}
              placeholderTextColor={palette.text4}
              keyboardType="number-pad"
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              returnKeyType="done"
              maxLength={4}
            />
            <Text style={s.scalingLabel}>servings</Text>
            {desiredServings.trim() !== "" && (
              <Pressable
                onPress={() => {
                  hapticTap();
                  setDesiredServings("");
                }}
                style={s.scalingReset}
              >
                <Text style={s.scalingResetText}>Reset</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Ingredients card with checkboxes */}
        {scaledIngredients.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Ingredients</Text>
            <View style={s.ingredientCard}>
              {scaledIngredients.map(({ ingredient, formatted }, idx) => {
                const key = ingredient.id ?? `${ingredient.position}-${ingredient.name}`;
                return (
                  <IngredientRow
                    key={key}
                    formatted={formatted}
                    isChecked={checkedIngredients.has(key)}
                    isLast={idx === scaledIngredients.length - 1}
                    onToggle={() => toggleIngredientCheck(key)}
                    reduceMotion={reduceMotion}
                    s={s}
                  />
                );
              })}
            </View>
          </View>
        )}

        {/* Method timeline */}
        {sortedSteps.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Method</Text>
            <View style={s.timelineContainer}>
              <View style={s.timelineLine} />
              {sortedSteps.map((step, idx) => {
                const isActive = activeStep === idx;
                return (
                  <Pressable
                    key={step.id ?? `${step.position}-${idx}`}
                    onPress={() => {
                      hapticTap();
                      setActiveStep(idx);
                    }}
                    style={s.stepRow}
                  >
                    <View style={[s.stepCircle, isActive && s.stepCircleActive]}>
                      <Text style={[s.stepNumber, isActive && s.stepNumberActive]}>
                        {idx + 1}
                      </Text>
                    </View>
                    <Text style={[s.stepText, isActive && s.stepTextActive]}>
                      {step.instruction}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* Your Notes — cook history. "I Made This" moved to the top action
            grid (15.2.4 corrected); the section renders only when there is
            history, so an empty history never leaves a bare header. */}
        {cookEvents && cookEvents.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Your Notes</Text>
            <View style={s.cookHistoryList}>
              {cookEvents.map((event) => (
                <Swipeable
                  key={String(event.id)}
                  renderRightActions={(_progress, _dragX) => (
                    <Pressable
                      onPress={() => handleDeleteCookEvent(event.id)}
                      style={s.swipeDeleteAction}
                    >
                      <Text style={s.swipeDeleteText}>Delete</Text>
                    </Pressable>
                  )}
                  rightThreshold={80}
                >
                  <Pressable
                    onPress={() => handleEditCookEvent(event)}
                    style={s.cookEventRow}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit cook event from ${formatCookDate(event.cooked_at)}`}
                  >
                    <View style={s.cookEventHeader}>
                      <Text style={s.cookEventDate}>
                        {formatCookDate(event.cooked_at)}
                      </Text>
                      {event.rating != null && (
                        <Text style={s.cookEventStars}>
                          {renderStars(event.rating)}
                        </Text>
                      )}
                    </View>
                    {event.notes && (
                      <Text style={s.cookEventNotes} numberOfLines={3}>
                        {"\u201C"}{event.notes}{"\u201D"}
                      </Text>
                    )}
                    {event.scale && (
                      <Text style={s.cookEventScale}>{event.scale}</Text>
                    )}
                  </Pressable>
                </Swipeable>
              ))}
            </View>
          </View>
        )}

        {/* Delete */}
        <View style={s.deleteButton}>
          <Button
            title="Delete Recipe"
            onPress={handleDelete}
            variant="destructive"
            loading={deleteMutation.isPending}
            accessibilityLabel={
              deleteMutation.isPending ? "Deleting recipe" : "Delete recipe"
            }
          />
        </View>
      </ScrollView>

      {/* Success toast */}
      <Toast
        toast={toast}
        opacity={toastOpacity}
        action={{
          label: "View List",
          onPress: () => {
            dismissToast();
            // Build 4 (C3): a stack child pushing the tabs route creates a
            // duplicate (tabs) stack entry per push; guard it.
            navGuard.guard(() => router.push("/(app)/(tabs)/grocery"));
          },
        }}
      />
      </Animated.View>
      {navDiag.enabled && <NavDiagnosticsPill routeKey={navDiag.routeKey} />}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
    },
    deletedTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginBottom: spacing.sm,
      textAlign: "center",
    },
    deletedBody: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
      textAlign: "center",
      marginBottom: spacing.base,
    },
    deletedAction: {
      marginTop: spacing.sm,
    },
    headerEditControl: {
      // Real interaction geometry (Issue 3 ruling 11): actual 44pt
      // minimum frame with centered content.
      minWidth: 44,
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
    },
    headerEditText: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.md,
      color: palette.primary,
    },
    headerEditTextDisabled: {
      opacity: 0.4,
    },
    scrollContent: {
      paddingHorizontal: spacing.screen,
      paddingTop: spacing.base,
      paddingBottom: spacing.xxxl,
    },
    headerBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: palette.pillBg,
      alignSelf: "flex-start",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
      borderRadius: radius.sm,
      marginBottom: spacing.base,
    },
    headerBadgeTag: {
      fontFamily: fonts.bodyBold,
      fontSize: fontSize.sm,
      color: palette.pillText,
      letterSpacing: 0.8,
    },
    headerBadgeDot: {
      width: 3,
      height: 3,
      borderRadius: 1.5,
      backgroundColor: palette.text4,
      opacity: 0.5,
    },
    headerBadgeTime: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text3,
    },
    title: {
      fontFamily: fonts.heading,
      fontSize: fontSize.hero,
      color: palette.text1,
      marginBottom: spacing.base,
      letterSpacing: -0.5,
      lineHeight: fontSize.hero * lineHeight.tight,
    },
    sourceLink: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.accent,
      marginBottom: spacing.base,
    },
    metaCards: {
      flexDirection: "row",
      gap: spacing.md,
      marginBottom: spacing.xl,
    },
    metaCard: {
      flex: 1,
      backgroundColor: palette.card,
      borderRadius: radius.card,
      padding: spacing.base,
      borderWidth: 1,
      borderColor: palette.border,
    },
    metaCardLabel: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text4,
      marginBottom: spacing.xs,
      letterSpacing: 0.2,
    },
    metaCardValue: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.lg,
      color: palette.text1,
    },
    tagsSection: {
      marginBottom: spacing.base,
    },
    tagsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    tagChip: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: palette.card,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
      gap: spacing.xs,
    },
    tagChipDisabled: {
      opacity: 0.5,
    },
    tagText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text2,
    },
    tagRemove: {
      fontSize: fontSize.md,
      color: palette.text3,
      fontFamily: fonts.bodySemiBold,
    },
    tagInputRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    tagInput: {
      flex: 1,
      backgroundColor: palette.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.base,
      fontFamily: fonts.body,
      color: palette.text1,
    },
    scalingRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing.base,
    },
    scalingLabel: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text3,
      marginRight: spacing.sm,
    },
    scalingInput: {
      width: 56,
      backgroundColor: palette.card,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.md,
      fontFamily: fonts.bodySemiBold,
      color: palette.text1,
      textAlign: "center",
      marginRight: spacing.sm,
    },
    scalingReset: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      marginLeft: spacing.xs,
    },
    scalingResetText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      textDecorationLine: "underline",
    },
    section: {
      marginBottom: spacing.xl,
    },
    sectionTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginBottom: spacing.base,
      letterSpacing: -0.2,
    },
    ingredientCard: {
      backgroundColor: palette.card,
      borderRadius: radius.xl,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: palette.border,
    },
    ingredientRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.base,
      paddingVertical: spacing.md,
    },
    ingredientRowBorder: {
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
      justifyContent: "center",
      alignItems: "center",
    },
    checkboxChecked: {
      backgroundColor: palette.accent,
      borderColor: palette.accent,
    },
    checkmark: {
      fontSize: fontSize.sm,
      color: palette.bg,
      fontWeight: "700",
    },
    ingredientContent: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      flex: 1,
    },
    ingredientText: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
    },
    ingredientAnnotation: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      fontStyle: "italic",
    },
    ingredientNotScaled: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.warning,
      fontStyle: "italic",
    },
    timelineContainer: {
      position: "relative",
      paddingLeft: spacing.xs,
    },
    timelineLine: {
      position: "absolute",
      left: 17,
      top: spacing.lg,
      bottom: spacing.lg,
      width: 2,
      backgroundColor: palette.surface,
      borderRadius: 1,
    },
    stepRow: {
      flexDirection: "row",
      gap: spacing.base,
      paddingVertical: spacing.md,
      alignItems: "flex-start",
    },
    stepCircle: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      justifyContent: "center",
      alignItems: "center",
      zIndex: 1,
    },
    stepCircleActive: {
      backgroundColor: palette.accent,
      borderColor: palette.accent,
    },
    stepNumber: {
      fontFamily: fonts.bodyBold,
      fontSize: fontSize.sm,
      color: palette.text3,
    },
    stepNumberActive: {
      color: palette.bg,
    },
    stepText: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
      flex: 1,
      lineHeight: fontSize.base * lineHeight.relaxed,
      paddingTop: spacing.xs,
    },
    stepTextActive: {
      color: palette.text1,
      fontFamily: fonts.bodyMedium,
    },
    deleteButton: {
      marginTop: spacing.xxl,
    },
    actionGrid: {
      marginBottom: spacing.xl,
    },
    actionRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    actionRowSpacing: {
      marginTop: spacing.sm,
    },
    actionCell: {
      // Equal columns via flex:1 (no flexBasis/wrap — the device proved wrap
      // collapses to one row). A lone trailing cell fills its row width. No
      // fixed height, so labels wrap and grow at large Dynamic Type.
      flex: 1,
    },
    actionCellSubtle: {
      // Subtle accent-surface fill behind the outline Button (which supplies
      // the accent border + accent text) — the subordinate action tier.
      backgroundColor: palette.surface,
      borderRadius: radius.md,
    },
    cookHistoryList: {
      marginBottom: spacing.base,
    },
    cookEventRow: {
      backgroundColor: palette.card,
      paddingHorizontal: spacing.base,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: palette.divider,
    },
    cookEventHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    cookEventDate: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text3,
    },
    cookEventStars: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.star,
    },
    cookEventNotes: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text2,
      marginTop: spacing.xs,
      lineHeight: fontSize.base * lineHeight.normal,
    },
    cookEventScale: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text4,
      marginTop: spacing.xs,
      fontStyle: "italic",
    },
    swipeDeleteAction: {
      backgroundColor: palette.error,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.lg,
    },
    swipeDeleteText: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.sm,
      color: palette.text1,
    },
  });
}
