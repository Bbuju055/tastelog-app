import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ActionSheetIOS, Alert, Animated, AppState, Easing, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Reanimated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { useRouter, useFocusEffect } from "expo-router";
import { useRecipes, useDrafts, useToggleFavorite, useRemakeGroceryList, useGroceryLists, useGroceryPicker, useStaggeredEntrance, useEnteringRowKeys, useReducedMotion } from "../../../lib/hooks";
import { useRecentCooks } from "../../../lib/hooks/useRecentCooks";
// Deep imports on purpose (NOT the lib/hooks barrel) — the home-screen test
// suites mock the barrel as object literals; see useRecentCooks precedent.
import { useDismissedRecentCooks } from "../../../lib/hooks/useDismissedRecentCooks";
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
// Build 5 Class B diagnostic (section 4.B.11): ui.rowPress record, no-op
// unless EXPO_PUBLIC_NAV_DIAGNOSTICS is "1".
import { navDiagnostics } from "../../../lib/diagnostics/navTrace";
import {
  isDismissedThrough,
  type DismissedRecentCooks,
} from "../../../lib/recentCooks/dismissedRecentCooks";
import {
  Screen,
  Button,
  ErrorState,
  EmptyState,
  RecipeCard,
  SkeletonRecipeCard,
  Toast,
  useToast,
} from "../../../components";
import type { ToastAction } from "../../../components/Toast";
import { hapticTap } from "../../../lib/haptics/haptics";
import { apiErrorMessage } from "../../../lib/apiErrorMessage";
import { getMergeToastMessage } from "../../../lib/grocery/mergeToastMessage";
import { fonts, fontSize, lineHeight, motion, spacing, radius, shadows } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";
import type { DraftResponse, RecentCookResponse, RecipeSearchResult } from "../../../lib/api/schemas";

// ---------------------------------------------------------------------------
// Phase 15.1.3 — list motion, built once from motion tokens. Reflow is for
// stable-key reorder clarity (favorite toggle under Favorites sort, sort
// switches); rowEnter fades in genuinely new rows only. No exiting on this
// list — recipe deletion happens on the detail screen, never on-screen here.
// ---------------------------------------------------------------------------

const listReflow = LinearTransition.springify()
  .damping(motion.spring.settle.damping)
  .stiffness(motion.spring.settle.stiffness)
  .mass(motion.spring.settle.mass);
const rowEnter = FadeIn.duration(motion.duration.base);

type SortOrder = "newest" | "oldest" | "a-z" | "z-a" | "favorites";

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "a-z", label: "A\u2013Z" },
  { value: "z-a", label: "Z\u2013A" },
  { value: "favorites", label: "Favorites" },
];

function formatTimeAgo(dateStr: string): string {
  const parsed = Date.parse(dateStr);
  if (Number.isNaN(parsed)) return "";
  const diff = Date.now() - parsed;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Spoken variant of formatTimeAgo for accessibility labels — VoiceOver reads
// the compact "2h ago" form poorly, so labels get full units.
function formatTimeAgoSpoken(dateStr: string): string {
  const parsed = Date.parse(dateStr);
  if (Number.isNaN(parsed)) return "date unavailable";
  const diff = Date.now() - parsed;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function PendingDrafts({
  drafts,
  onPress,
}: {
  drafts: DraftResponse[];
  onPress: (draft: DraftResponse) => void;
}) {
  const { palette } = useTheme();
  const s = createStyles(palette);
  return (
    <View style={s.draftsSection}>
      <Text style={s.draftsHeading}>
        Pending Drafts ({drafts.length})
      </Text>
      {drafts.map((draft) => (
        <Pressable
          key={draft.id}
          style={s.draftCard}
          onPress={() => onPress(draft)}
        >
          <Text style={s.draftTitle} numberOfLines={1}>
            {draft.title}
          </Text>
          <Text style={s.draftTime}>
            {formatTimeAgo(draft.created_at)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function RecentlyCookedSection({
  cooks: recentCooks,
  dismissedMarkers,
  onPress,
  onDismiss,
}: {
  cooks: RecentCookResponse[] | undefined;
  dismissedMarkers: DismissedRecentCooks;
  onPress: (recipeId: string) => void;
  onDismiss: (cook: RecentCookResponse) => void;
}) {
  const { palette, theme } = useTheme();
  const s = createStyles(palette);

  const deduped = useMemo(() => {
    if (!recentCooks || recentCooks.length === 0) return [];
    // Newest per recipe by PARSED timestamp — never trust response order
    // for client-side selection (recorded project rule). Card order still
    // follows first appearance in the response.
    const order: string[] = [];
    const newestByRecipe = new Map<string, RecentCookResponse>();
    for (const cook of recentCooks) {
      const existing = newestByRecipe.get(cook.recipe_id);
      if (!existing) {
        order.push(cook.recipe_id);
        newestByRecipe.set(cook.recipe_id, cook);
        continue;
      }
      const candidate = Date.parse(cook.cooked_at);
      const incumbent = Date.parse(existing.cooked_at);
      if (
        !Number.isNaN(candidate) &&
        (Number.isNaN(incumbent) || candidate > incumbent)
      ) {
        newestByRecipe.set(cook.recipe_id, cook);
      }
    }
    // Dismissal filter runs on the deduped (newest-per-recipe) projection:
    // hidden while the newest cook is not newer than the persisted marker.
    return order
      .map((recipeId) => newestByRecipe.get(recipeId))
      .filter((cook): cook is RecentCookResponse => cook != null)
      .filter(
        (cook) =>
          !isDismissedThrough(cook.cooked_at, dismissedMarkers[cook.recipe_id]),
      );
  }, [recentCooks, dismissedMarkers]);

  if (deduped.length === 0) return null;

  return (
    <View style={s.recentSection}>
      <Text style={s.recentHeading}>Recently Cooked</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.recentScroll}
      >
        {deduped.map((cook) => (
          <View
            key={String(cook.id)}
            style={[s.recentCard, theme === "light" && shadows.card]}
          >
            <Pressable
              style={s.recentCardBody}
              onPress={() => onPress(cook.recipe_id)}
              accessibilityRole="button"
              accessibilityLabel={
                cook.rating != null
                  ? `Open ${cook.recipe_title}, cooked ${formatTimeAgoSpoken(cook.cooked_at)}, rated ${cook.rating} out of 5`
                  : `Open ${cook.recipe_title}, cooked ${formatTimeAgoSpoken(cook.cooked_at)}`
              }
            >
              <Text style={s.recentTitle} numberOfLines={2}>
                {cook.recipe_title}
              </Text>
              <View style={s.recentMeta}>
                {cook.rating != null && (
                  <Text style={s.recentStars}>
                    {"\u2605".repeat(cook.rating)}
                  </Text>
                )}
                <Text style={s.recentTime}>
                  {formatTimeAgo(cook.cooked_at)}
                </Text>
              </View>
            </Pressable>
            <Pressable
              style={s.recentDismiss}
              onPress={() => onDismiss(cook)}
              hitSlop={{ top: 4, right: 4, bottom: 16, left: 16 }}
              accessibilityRole="button"
              accessibilityLabel={`Hide ${cook.recipe_title} from Recently Cooked`}
              accessibilityHint="Cooking history is kept."
            >
              <Text style={s.recentDismissText} allowFontScaling={false}>
                {"\u2715"}
              </Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export default function RecipeListScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);
  const router = useRouter();
  const { data: recipes, isLoading, error, refetch: recipesRefetch } = useRecipes();
  const { data: drafts, refetch: draftsRefetch, isFetching: isDraftsFetching } = useDrafts();
  // Single owner of the recent-cooks query (15.2.4-CF-RC1) — the section
  // receives derived data so pull-to-refresh can reach the same refetch.
  const { data: recentCooks, refetch: recentCooksRefetch } = useRecentCooks();
  const { markers: dismissedMarkers, dismissRecentCook, undoDismissRecentCook } =
    useDismissedRecentCooks();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { mutate: toggleFavorite } = useToggleFavorite();
  const remakeMutation = useRemakeGroceryList();
  const { lists: groceryLists, isLoading: isGroceryListsLoading } = useGroceryLists();
  const { pickList } = useGroceryPicker(groceryLists, isGroceryListsLoading);
  const { toast, showToast, dismissToast, toastOpacity } = useToast();
  // Build 4 (C3): ONE shared duplicate-activation guard owns every direct
  // push from this screen (recipe row, pending-draft row, Recently Cooked
  // card), so a double tap or a cross-action pair navigates exactly once.
  // Unlocks on focus regain when the pushed screen pops.
  const navGuard = useNavigationGuard();

  // Single toast surface, per-toast action ownership: every Home toast goes
  // through presentToast, which always sets BOTH message and action
  // (explicit null clears a stale one) — a later toast can never inherit an
  // old Undo or View List action.
  const [toastAction, setToastAction] = useState<ToastAction | null>(null);
  const presentToast = useCallback(
    (message: string, action: ToastAction | null) => {
      setToastAction(action);
      showToast({ message });
    },
    [showToast],
  );
  const viewListToastAction: ToastAction = {
    label: "View List",
    onPress: () => {
      dismissToast();
      router.push("/(app)/(tabs)/grocery");
    },
  };

  const pendingDrafts = drafts ?? [];

  // Content fade-in on first load (10.C) + per-item staggered entrance (10.G)
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const hasAnimatedRef = useRef(false);
  const entrance = useStaggeredEntrance();

  // 15.1.3 — layout transitions (reflow + new-row entrance)
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      // G-15.1: land the entrance instantly — including when the async
      // preference resolves true after a fade already started. Runs ahead
      // of the fire-once guard so it can never block final-state repair.
      // entrance.start() is still called: the hook snaps its pool to the
      // final opacity under Reduce Motion.
      hasAnimatedRef.current = true;
      contentOpacity.stopAnimation();
      contentOpacity.setValue(1);
      entrance.start();
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
      entrance.start();
      return () => fade.stop();
    }
    if (!isLoading) {
      // Build 4 (C2) convergence repair: the one-shot fade above may have
      // been stopped by this effect's cleanup (isLoading flip mid-fade).
      // Renderable content must always converge to fully visible; an
      // interrupted fade becomes a one-frame jump-cut, never a blank screen.
      contentOpacity.setValue(1);
    }
  }, [isLoading, contentOpacity, entrance, reduceMotion]);

  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Batch selection state (local only)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const selectionMode = selectedIds.size > 0;

  const allTags = useMemo(() => {
    if (!recipes) return [];
    const tagSet = new Set<string>();
    for (const recipe of recipes) {
      for (const tag of recipe.tags) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [recipes]);

  // Clear active tag filter when the tag no longer exists in any recipe
  useEffect(() => {
    if (activeTag && !allTags.some((t) => t.toLowerCase() === activeTag.toLowerCase())) {
      setActiveTag(null);
    }
  }, [activeTag, allTags]);

  const displayRecipes = useMemo(() => {
    if (!recipes) return [];

    // 1. Tag filter
    const tagFiltered = activeTag
      ? recipes.filter((recipe) =>
          recipe.tags.some((t) => t.toLowerCase() === activeTag.toLowerCase()),
        )
      : recipes;

    // 2. Search filter
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? tagFiltered.filter((recipe) =>
          recipe.title.toLowerCase().includes(query),
        )
      : tagFiltered;

    // 3. Sort
    return [...filtered].sort((a, b) => {
      switch (sortOrder) {
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "a-z":
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        case "z-a":
          return b.title.localeCompare(a.title, undefined, { sensitivity: "base" });
        case "favorites": {
          if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
      }
    });
  }, [recipes, activeTag, searchQuery, sortOrder]);

  // 15.1.3 — entering fades only for genuinely new recipe ids. A key that
  // was filtered out and restored (search/tag cleared) stays seen and does
  // not re-fade; the initial data set is seeded and never enters.
  const recipeKeys = useMemo(
    () => displayRecipes.map((recipe) => recipe.id),
    [displayRecipes],
  );
  const enteringKeys = useEnteringRowKeys(recipeKeys, !isLoading);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([recipesRefetch(), draftsRefetch(), recentCooksRefetch()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [recipesRefetch, draftsRefetch, recentCooksRefetch]);

  // Refetch drafts when this tab gains focus (e.g. after using the share extension
  // and manually reopening the app, or returning from a draft detail screen).
  const appStateRef = useRef(AppState.currentState);
  const isDraftsFetchingRef = useRef(isDraftsFetching);
  isDraftsFetchingRef.current = isDraftsFetching;

  useFocusEffect(
    useCallback(() => {
      if (!isDraftsFetchingRef.current) void draftsRefetch();

      const subscription = AppState.addEventListener("change", (nextState) => {
        if (appStateRef.current.match(/inactive|background/) && nextState === "active") {
          if (!isDraftsFetchingRef.current) void draftsRefetch();
        }
        appStateRef.current = nextState;
      });

      return () => {
        subscription.remove();
        // Clear selection when leaving this tab
        setSelectedIds(new Set());
        setBatchProgress(null);
      };
    }, [draftsRefetch])
  );

  function handlePress(recipe: RecipeSearchResult) {
    if (selectionMode) {
      handleSelectionToggle(recipe);
      return;
    }
    navDiagnostics.record("ui.rowPress", { recipeId: recipe.id });
    navGuard.guard(() => router.push(`/(app)/recipe/${recipe.id}`));
  }

  function handleToggleFavorite(recipe: RecipeSearchResult) {
    toggleFavorite({ recipeId: recipe.id, favorite: !recipe.favorite });
  }

  function handleQuickAdd(recipe: RecipeSearchResult) {
    if (remakeMutation.isPending || isGroceryListsLoading) return;

    pickList((listId, wasCreated) => {
      remakeMutation.mutate(
        {
          recipe_id: recipe.id,
          ...(listId ? { list_id: listId } : {}),
        },
        {
          onSuccess: (data) => {
            const message = getMergeToastMessage(
              data.list.display_name ?? data.list.name,
              data.items_added,
              data.items_merged,
            );
            presentToast(message, viewListToastAction);
          },
          onError: () => {
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

  function handleDismissRecentCook(cook: RecentCookResponse) {
    // Synchronous duplicate guard lives in the hook (ref mirror): a repeat
    // tap before re-render returns false → no haptic, no toast, no write.
    const didDismiss = dismissRecentCook(cook.recipe_id, cook.cooked_at);
    if (!didDismiss) return;
    hapticTap();
    presentToast("Hidden from Recently Cooked", {
      label: "Undo",
      onPress: () => {
        undoDismissRecentCook(cook.recipe_id);
        // Replace the actionable toast so a stale Undo can't be re-pressed.
        presentToast("Restored to Recently Cooked", null);
      },
    });
  }

  function handleDraftPress(draft: DraftResponse) {
    navGuard.guard(() =>
      router.push({
        pathname: "/(app)/draft/[id]",
        params: { id: draft.id },
      }),
    );
  }

  // --- Batch selection ---

  function handleLongPress(recipe: RecipeSearchResult) {
    if (batchProgress) return;

    if (selectionMode) {
      handleSelectionToggle(recipe);
      return;
    }

    hapticTap();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Log Cook", "Add to Grocery", "Cancel"],
        cancelButtonIndex: 2,
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          router.push({
            pathname: "/recipe/cook-log/[id]",
            params: { id: recipe.id, from: "detail" },
          });
        } else if (buttonIndex === 1) {
          handleQuickAdd(recipe);
        }
      },
    );
  }

  function handleSelectionToggle(recipe: RecipeSearchResult) {
    if (batchProgress) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recipe.id)) {
        next.delete(recipe.id);
      } else {
        next.add(recipe.id);
      }
      return next;
    });
  }

  function cancelSelection() {
    setSelectedIds(new Set());
    setBatchProgress(null);
  }

  function handleBatchAddWithPicker() {
    if (batchProgress || isGroceryListsLoading) return;

    pickList((listId, wasCreated) => {
      void runBatchAdd(listId, wasCreated);
    });
  }

  async function runBatchAdd(listId: string | null, wasCreated: boolean) {
    const ids = displayRecipes
      .filter((r) => selectedIds.has(r.id))
      .map((r) => r.id);
    if (ids.length === 0 || batchProgress) return;

    let totalAdded = 0;
    let totalMerged = 0;
    let lastListName = "";

    for (let i = 0; i < ids.length; i++) {
      setBatchProgress({ current: i + 1, total: ids.length });
      try {
        const data = await remakeMutation.mutateAsync({
          recipe_id: ids[i],
          ...(listId ? { list_id: listId } : {}),
        });
        totalAdded += data.items_added;
        totalMerged += data.items_merged;
        lastListName = data.list.display_name ?? data.list.name;
      } catch {
        const baseMsg = `Failed on recipe ${i + 1} of ${ids.length}.`;
        Alert.alert(
          "Error",
          wasCreated && i === 0
            ? `List created but items couldn't be added. ${baseMsg}`
            : `${baseMsg} Please try again.`,
        );
        setBatchProgress(null);
        return;
      }
    }

    setBatchProgress(null);
    setSelectedIds(new Set());
    presentToast(
      getMergeToastMessage(lastListName, totalAdded, totalMerged),
      viewListToastAction,
    );
  }

  if (isLoading) {
    return (
      <Screen>
        <View style={s.listContent}>
          <SkeletonRecipeCard />
          <SkeletonRecipeCard />
          <SkeletonRecipeCard />
          <SkeletonRecipeCard />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={apiErrorMessage(error)}
          onRetry={() => recipesRefetch()}
        />
      </Screen>
    );
  }

  if (!recipes || recipes.length === 0) {
    return (
      <Screen>
        <Animated.View style={{ opacity: contentOpacity, flex: 1 }}>
          {pendingDrafts.length > 0 ? (
            <PendingDrafts drafts={pendingDrafts} onPress={handleDraftPress} />
          ) : null}
          <View style={s.emptyContainer}>
            <EmptyState
              message="Capture your first recipe from a photo."
              action={{
                title: "Capture Recipe",
                onPress: () => router.push("/(app)/(tabs)/add"),
              }}
            />
          </View>
        </Animated.View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Animated.View style={{ opacity: contentOpacity, flex: 1 }}>
      {selectionMode && (
        <View style={s.selectionBar}>
          <Text style={s.selectionBarText}>
            {batchProgress
              ? `Adding ${batchProgress.current} of ${batchProgress.total}\u2026`
              : `${selectedIds.size} selected`}
          </Text>
          <View style={s.selectionBarActions}>
            <Button
              title="Add to Grocery"
              onPress={handleBatchAddWithPicker}
              disabled={!!batchProgress}
              size="sm"
            />
            <Pressable
              onPress={() => {
                hapticTap();
                cancelSelection();
              }}
              disabled={!!batchProgress}
              style={s.selectionBarCancel}
            >
              <Text style={s.selectionBarCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
      <Reanimated.FlatList
        data={displayRecipes}
        keyExtractor={(item) => item.id}
        itemLayoutAnimation={reduceMotion ? undefined : listReflow}
        contentContainerStyle={s.listContent}
        refreshing={isRefreshing}
        onRefresh={selectionMode ? undefined : handleRefresh}
        refreshControl={undefined}
        scrollIndicatorInsets={{ right: -5 }}
        ListHeaderComponent={
          <>
            {pendingDrafts.length > 0 && !selectionMode && (
              <PendingDrafts drafts={pendingDrafts} onPress={handleDraftPress} />
            )}
            {/* Hydration gate: no Recently Cooked cards until dismissal
                markers have loaded — a previously hidden card must never
                flash before disappearing. */}
            {!selectionMode && dismissedMarkers !== null && (
              <RecentlyCookedSection
                cooks={recentCooks}
                dismissedMarkers={dismissedMarkers}
                onPress={(recipeId) =>
                  navGuard.guard(() => router.push(`/(app)/recipe/${recipeId}`))
                }
                onDismiss={handleDismissRecentCook}
              />
            )}
            {!selectionMode && (
              <View style={s.controls}>
                <Text style={s.screenTitle}>Recipes</Text>
                <TextInput
                  style={s.searchInput}
                  placeholder="Search recipes…"
                  placeholderTextColor={palette.text4}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCorrect={false}
                  returnKeyType="search"
                  keyboardAppearance={theme === "dark" ? "dark" : "light"}
                />
                <View style={s.sortRow}>
                  {SORT_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.value}
                      style={[
                        s.sortChip,
                        sortOrder === opt.value && s.sortChipActive,
                      ]}
                      onPress={() => {
                        hapticTap();
                        setSortOrder(opt.value);
                      }}
                    >
                      <Text
                        style={[
                          s.sortChipText,
                          sortOrder === opt.value && s.sortChipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {allTags.length > 0 && (
                  <View style={s.tagFilterRow}>
                    {allTags.map((tag) => (
                      <Pressable
                        key={tag}
                        style={[
                          s.tagFilterChip,
                          activeTag === tag && s.tagFilterChipActive,
                        ]}
                        onPress={() => {
                          hapticTap();
                          setActiveTag((prev) => (prev === tag ? null : tag));
                        }}
                      >
                        <Text
                          style={[
                            s.tagFilterChipText,
                            activeTag === tag && s.tagFilterChipTextActive,
                          ]}
                        >
                          {tag}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </>
        }
        ListEmptyComponent={
          searchQuery.trim() || activeTag ? (
            <View style={s.emptyContainer}>
              <EmptyState message="No matching recipes." />
            </View>
          ) : undefined
        }
        ListFooterComponent={
          displayRecipes.length > 0 ? (
            <View style={s.footer}>
              <Text style={s.footerText}>
                {displayRecipes.length} {displayRecipes.length === 1 ? "recipe" : "recipes"}
              </Text>
            </View>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <Reanimated.View
            entering={
              reduceMotion || !enteringKeys.has(item.id)
                ? undefined
                : rowEnter
            }
          >
            <RecipeCard
              recipe={item}
              onPress={handlePress}
              onToggleFavorite={handleToggleFavorite}
              onLongPress={handleLongPress}
              selected={selectionMode ? selectedIds.has(item.id) : undefined}
              onAddToGrocery={selectionMode ? undefined : handleQuickAdd}
              groceryPending={selectionMode ? undefined : (remakeMutation.isPending || isGroceryListsLoading)}
              entranceOpacity={entrance.getOpacity(index)}
            />
          </Reanimated.View>
        )}
      />
      </Animated.View>
      <Toast
        toast={toast}
        opacity={toastOpacity}
        action={toastAction ?? undefined}
      />
    </Screen>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    centered: {
      justifyContent: "center",
      alignItems: "center",
    },
    emptyContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    listContent: {
      paddingBottom: spacing.xl,
    },
    screenTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xxl,
      color: palette.text1,
      letterSpacing: -0.5,
      marginBottom: spacing.lg,
    },
    controls: {
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    searchInput: {
      backgroundColor: palette.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.base,
      paddingVertical: spacing.md,
      fontSize: fontSize.base,
      fontFamily: fonts.body,
      color: palette.text1,
      marginBottom: spacing.sm,
      marginRight: spacing.xs,
    },
    sortRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    sortChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
    },
    sortChipActive: {
      backgroundColor: palette.accent,
      borderColor: palette.accent,
    },
    sortChipText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.text3,
    },
    sortChipTextActive: {
      color: palette.bg,
      fontFamily: fonts.bodySemiBold,
    },
    tagFilterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    tagFilterChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
    },
    tagFilterChipActive: {
      backgroundColor: palette.pillBg,
      borderColor: palette.accent,
    },
    tagFilterChipText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.text3,
    },
    tagFilterChipTextActive: {
      color: palette.pillText,
      fontFamily: fonts.bodySemiBold,
    },
    draftsSection: {
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    draftsHeading: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodySemiBold,
      color: palette.warning,
      marginBottom: spacing.sm,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    draftCard: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: palette.warningSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.base,
      paddingVertical: spacing.md,
      marginBottom: spacing.sm,
    },
    draftTitle: {
      fontSize: fontSize.md,
      fontFamily: fonts.bodyMedium,
      color: palette.warning,
      flex: 1,
      marginRight: spacing.md,
    },
    draftTime: {
      fontSize: fontSize.sm,
      fontFamily: fonts.body,
      color: palette.text3,
    },
    selectionBar: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: palette.selected,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: palette.selectedBorder,
    },
    selectionBarText: {
      fontSize: fontSize.base,
      fontFamily: fonts.bodySemiBold,
      color: palette.accent,
    },
    selectionBarActions: {
      flexDirection: "row",
      gap: spacing.md,
      alignItems: "center",
    },
    selectionBarCancel: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    selectionBarCancelText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.text3,
    },
    recentSection: {
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    recentHeading: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodySemiBold,
      color: palette.text3,
      marginBottom: spacing.sm,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    recentScroll: {
      gap: spacing.sm,
    },
    recentCard: {
      width: 148,
      backgroundColor: palette.card,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: palette.border,
    },
    // Card body is a SIBLING of the dismiss control (both inside the plain
    // wrapper above) — nesting an accessible Pressable inside another can
    // hide the inner one from iOS VoiceOver's element traversal.
    recentCardBody: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      justifyContent: "space-between",
      flexGrow: 1,
    },
    recentTitle: {
      fontSize: fontSize.base,
      fontFamily: fonts.bodyMedium,
      color: palette.text1,
      lineHeight: fontSize.base * lineHeight.tight,
      marginBottom: spacing.sm,
      // Clear the dismiss control's full 44pt touch band so neither the
      // title glyphs nor their tap area run under it at any type size.
      paddingRight: spacing.xxl,
    },
    // Visible button treatment (not hitSlop-only): 24pt disc on the card's
    // surface tone with a border for contrast in both palettes. Asymmetric
    // hitSlop {4,4,16,16} extends exactly to the card's top/right edges
    // (RN clips hit areas at parent bounds) for a true 44×44pt target.
    recentDismiss: {
      position: "absolute",
      top: spacing.xs,
      right: spacing.xs,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    recentDismissText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.text2,
    },
    recentMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    recentStars: {
      fontSize: fontSize.sm,
      color: palette.star,
    },
    recentTime: {
      fontSize: fontSize.sm,
      fontFamily: fonts.body,
      color: palette.text4,
    },
    footer: {
      paddingVertical: spacing.base,
      alignItems: "center",
    },
    footerText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text4,
      letterSpacing: 0.3,
    },
  });
}
