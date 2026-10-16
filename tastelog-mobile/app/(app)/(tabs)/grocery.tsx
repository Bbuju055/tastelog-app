import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Reanimated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useRouter } from "expo-router";
import Swipeable from "react-native-gesture-handler/Swipeable";
import {
  useGrocery,
  useDeleteGroceryList,
  useDeleteGroceryItem,
  useCreateGroceryList,
  useRenameGroceryList,
  useAddManualItem,
  useStaggeredEntrance,
  useEnteringRowKeys,
  useReducedMotion,
} from "../../../lib/hooks";
import { hapticTap } from "../../../lib/haptics/haptics";
import {
  Screen,
  Button,
  ErrorState,
  SkeletonLine,
  SkeletonGroceryRow,
} from "../../../components";
import { apiErrorMessage } from "../../../lib/apiErrorMessage";
import { defaultListName } from "../../../lib/grocery/defaultListName";
import { buildSubstituteDraft } from "../../../lib/grocery/buildSubstituteDraft";
import { fonts, fontSize, motion, spacing, radius } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";
import type { GroceryItemResponse } from "../../../lib/api/schemas";

// ---------------------------------------------------------------------------
// List row types — discriminated union for FlatList data
// ---------------------------------------------------------------------------

type ItemRow = { type: "item"; data: GroceryItemResponse };
type SeparatorRow = { type: "separator"; count: number };
type ListRow = ItemRow | SeparatorRow;

// ---------------------------------------------------------------------------
// Phase 15.1.3 — list motion, built once from motion tokens.
// listReflow drives check/uncheck moves across the Completed boundary and
// gap-closes on delete; rowEnter/rowExit drive item add/remove fades.
// ---------------------------------------------------------------------------

const listReflow = LinearTransition.springify()
  .damping(motion.spring.settle.damping)
  .stiffness(motion.spring.settle.stiffness)
  .mass(motion.spring.settle.mass);
const rowEnter = FadeIn.duration(motion.duration.base);
const rowExit = FadeOut.duration(motion.duration.fast);

// ---------------------------------------------------------------------------
// Item row
// ---------------------------------------------------------------------------

function GroceryItemRow({
  item,
  onToggle,
  onDelete,
  onLongPress,
  entranceOpacity,
}: {
  item: GroceryItemResponse;
  onToggle: (itemId: string, checked: boolean) => void;
  onDelete: (itemId: string) => void;
  /** Phase 13.8 — long-press opens the Substitute ActionSheet. */
  onLongPress?: (item: GroceryItemResponse) => void;
  /** Phase 10.G — staggered entrance opacity. Undefined → no animation. */
  entranceOpacity?: Animated.Value;
}) {
  const { palette } = useTheme();
  const s = createStyles(palette);
  const secondaryText = [item.quantity, item.unit]
    .filter(Boolean)
    .join(" ");

  return (
    <Animated.View style={{ opacity: entranceOpacity ?? 1 }}>
    <Swipeable
      renderRightActions={() => (
        <Pressable
          onPress={() => {
            hapticTap();
            onDelete(item.id);
          }}
          style={s.swipeDeleteAction}
        >
          <Text style={s.swipeDeleteText}>Delete</Text>
        </Pressable>
      )}
      rightThreshold={80}
    >
      <Pressable
        onPress={() => onToggle(item.id, !item.checked)}
        onLongPress={onLongPress ? () => onLongPress(item) : undefined}
        style={s.row}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.checked }}
      >
        <View
          style={[
            s.checkbox,
            item.checked ? s.checkboxChecked : s.checkboxUnchecked,
          ]}
        >
          {item.checked ? (
            <Text style={s.checkmark}>{"\u2713"}</Text>
          ) : null}
        </View>

        <View style={s.rowContent}>
          <Text
            style={[
              s.itemName,
              item.checked && s.itemNameChecked,
            ]}
          >
            {item.name}
          </Text>
          {secondaryText ? (
            <Text style={s.itemSecondary}>{secondaryText}</Text>
          ) : null}
          {item.note ? (
            <Text style={s.itemNote}>{item.note}</Text>
          ) : null}
        </View>
      </Pressable>
    </Swipeable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// List switcher
// ---------------------------------------------------------------------------

function ListSwitcher({
  lists,
  activeListId,
  onSelect,
  onCreateNew,
}: {
  lists: { id: string; display_name: string }[];
  activeListId: string | null;
  onSelect: (listId: string) => void;
  onCreateNew: () => void;
}) {
  const { palette } = useTheme();
  const s = createStyles(palette);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.switcherContainer}
      contentContainerStyle={s.switcherContent}
    >
      {lists.map((list) => {
        const isActive = list.id === activeListId;
        return (
          <Pressable
            key={list.id}
            onPress={() => {
              hapticTap();
              onSelect(list.id);
            }}
            style={[
              s.switcherChip,
              isActive && s.switcherChipActive,
            ]}
          >
            <Text
              style={[
                s.switcherChipText,
                isActive && s.switcherChipTextActive,
              ]}
              numberOfLines={1}
            >
              {list.display_name}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        onPress={() => {
          hapticTap();
          onCreateNew();
        }}
        style={s.switcherChipNew}
      >
        <Text style={s.switcherChipNewText}>+ New</Text>
      </Pressable>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function GroceryScreen() {
  // 15.0.5 (L4): grocery follows the app theme; dark is Cooking Mode only.
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);
  const router = useRouter();
  const {
    lists,
    activeListId,
    selectList,
    activeList,
    items,
    isLoading,
    error,
    refetch,
    toggleItem,
  } = useGrocery();
  const deleteMutation = useDeleteGroceryList();
  const deleteItemMutation = useDeleteGroceryItem();
  const createMutation = useCreateGroceryList();
  const renameMutation = useRenameGroceryList();
  const addItemMutation = useAddManualItem();
  const [addItemText, setAddItemText] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // Content fade-in on first load (10.C) + per-item staggered entrance (10.G)
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const hasAnimatedRef = useRef(false);
  const entrance = useStaggeredEntrance();

  // 15.1.3 — layout transitions. Item ids only: the completed-separator has
  // its own appearance rule in renderRow (it must fade on every cycle, which
  // the seen-once semantics of useEnteringRowKeys would suppress).
  const reduceMotion = useReducedMotion();
  const itemKeys = useMemo(() => items.map((item) => item.id), [items]);
  const enteringKeys = useEnteringRowKeys(itemKeys, !isLoading, activeListId);

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

  const activeDisplayName = activeList?.display_name ?? null;

  const progressText = useMemo(() => {
    if (items.length === 0) return null;
    const checkedCount = items.filter((i) => i.checked).length;
    if (checkedCount === 0) return `${items.length} items`;
    return `${checkedCount} of ${items.length} items`;
  }, [items]);

  // Checked/unchecked separation: unchecked first, then divider, then checked
  const sortedRows = useMemo<ListRow[]>(() => {
    const unchecked = items.filter((i) => !i.checked);
    const checked = items.filter((i) => i.checked);
    const rows: ListRow[] = unchecked.map((data) => ({ type: "item", data }));
    if (checked.length > 0) {
      rows.push({ type: "separator", count: checked.length });
      for (const data of checked) {
        rows.push({ type: "item", data });
      }
    }
    return rows;
  }, [items]);

  function handleAddItem() {
    const name = addItemText.trim();
    if (!name || !activeListId) return;
    if (addItemMutation.isPending) return;

    addItemMutation.mutate(
      { name, list_id: activeListId },
      {
        onSuccess: () => {
          setAddItemText("");
        },
        onError: () => {
          Alert.alert("Error", "Couldn't add item. Please try again.");
        },
      },
    );
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }

  function promptForNewList() {
    const suggestion = defaultListName(
      lists.map((l) => l.display_name),
    );
    Alert.prompt(
      "New Grocery List",
      "Give your list a name",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Create",
          onPress: (value?: string) => {
            const name = (value ?? suggestion).trim();
            if (!name) return;
            createMutation.mutate({ name }, {
              onSuccess: (created) => {
                selectList(created.id);
              },
            });
          },
        },
      ],
      "plain-text",
      suggestion,
    );
  }

  function handleRename() {
    if (!activeListId || !activeDisplayName) return;
    hapticTap();
    Alert.prompt(
      "Rename List",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (value?: string) => {
            const name = (value ?? "").trim();
            if (!name || name === activeDisplayName) return;
            renameMutation.mutate({ listId: activeListId, name });
          },
        },
      ],
      "plain-text",
      activeDisplayName,
    );
  }

  function handleDelete() {
    if (!activeListId || !activeDisplayName) return;
    Alert.alert(
      "Delete Grocery List",
      `"${activeDisplayName}" and all its items will be permanently deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleteMutation.mutate(activeListId);
          },
        },
      ],
    );
  }

  function openListMenu() {
    if (!activeListId || !activeDisplayName) return;
    hapticTap();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Rename List", "Delete List", "Cancel"],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      (buttonIndex) => {
        if (buttonIndex === 0) handleRename();
        if (buttonIndex === 1) handleDelete();
      },
    );
  }

  const handleToggle = useCallback(
    (itemId: string, checked: boolean) => {
      hapticTap();
      toggleItem(itemId, checked);
    },
    [toggleItem],
  );

  const handleDeleteItem = useCallback(
    (itemId: string) => {
      if (!activeListId) return;
      deleteItemMutation.mutate({ itemId, listId: activeListId });
    },
    [activeListId, deleteItemMutation],
  );

  // Phase 13.8 — Grocery Substitute long-press entry. Anchor resolves to
  // item.recipe_id first, else source_recipes[0].id (the originating recipe
  // after 4.1.C consolidation may live only in source_recipes when the legacy
  // column is null). Manual items with neither anchor get no ActionSheet —
  // the Substitute surface requires a recipe to anchor the Riff prompt.
  const handleItemLongPress = useCallback(
    (item: GroceryItemResponse) => {
      const anchorRecipeId =
        item.recipe_id ??
        (item.source_recipes && item.source_recipes.length > 0
          ? item.source_recipes[0].id
          : null);
      if (!anchorRecipeId) return;

      hapticTap();
      Alert.alert(
        item.name,
        "Find a substitute for this ingredient?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Substitute",
            onPress: () => {
              router.push({
                pathname: "/recipe/riff/[id]",
                params: {
                  id: anchorRecipeId,
                  entryPoint: "grocery_substitute",
                  initialDraft: buildSubstituteDraft(item),
                },
              });
            },
          },
        ],
      );
    },
    [router],
  );

  const renderRow = useCallback(
    ({ item, index }: { item: ListRow; index: number }) => {
      if (item.type === "separator") {
        // Section boundary: fades on EVERY appear/disappear cycle. Its
        // list-mount appearances are suppressed natively by the FlatList's
        // skipEnteringExitingAnimations wrapper, so no seen-set gating here.
        return (
          <Reanimated.View
            entering={reduceMotion ? undefined : rowEnter}
            exiting={reduceMotion ? undefined : rowExit}
          >
            <View style={s.separatorRow}>
              <Text style={s.separatorText}>
                Completed ({item.count})
              </Text>
            </View>
          </Reanimated.View>
        );
      }
      const isEntering = enteringKeys.has(item.data.id);
      return (
        <Reanimated.View
          entering={reduceMotion || !isEntering ? undefined : rowEnter}
          exiting={reduceMotion ? undefined : rowExit}
        >
          <GroceryItemRow
            item={item.data}
            onToggle={handleToggle}
            onDelete={handleDeleteItem}
            onLongPress={handleItemLongPress}
            entranceOpacity={entrance.getOpacity(index)}
          />
        </Reanimated.View>
      );
    },
    [
      handleToggle,
      handleDeleteItem,
      handleItemLongPress,
      s,
      entrance,
      enteringKeys,
      reduceMotion,
    ],
  );

  const keyExtractor = useCallback(
    (row: ListRow) =>
      row.type === "separator" ? "completed-separator" : row.data.id,
    [],
  );

  const kbAppearance = theme === "dark" ? "dark" : "light";

  if (isLoading) {
    return (
      <Screen>
        <View style={s.header}>
          <View style={s.headerLeft}>
            <SkeletonLine width="60%" height={20} />
            <SkeletonLine
              width={90}
              height={13}
              style={{ marginTop: 6 }}
            />
          </View>
        </View>
        <SkeletonGroceryRow />
        <SkeletonGroceryRow />
        <SkeletonGroceryRow />
        <SkeletonGroceryRow />
        <SkeletonGroceryRow />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen style={s.centered}>
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Animated.View style={{ opacity: contentOpacity, flex: 1 }}>
      {lists.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyTitle}>Plan your shopping</Text>
          <Text style={s.emptySubtitle}>
            Create a list, then add ingredients from your recipes.
          </Text>
          <Button
            title="Create Your First List"
            onPress={promptForNewList}
          />
        </View>
      ) : (
        <>
          <ListSwitcher
            lists={lists}
            activeListId={activeListId}
            onSelect={selectList}
            onCreateNew={promptForNewList}
          />

          {activeList ? (
            <View style={s.header}>
              <View style={s.headerLeft}>
                <Text style={s.listName} numberOfLines={1}>
                  {activeDisplayName}
                </Text>
                {progressText ? (
                  <Text style={s.progressText}>{progressText}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={openListMenu}
                testID="grocery-more-button"
                style={s.moreButton}
              >
                <Text style={s.moreIcon}>{"\u2026"}</Text>
              </Pressable>
            </View>
          ) : null}

          {items.length > 0 ? (
            <Reanimated.FlatList
              // 15.1.3 — key + skipEnteringExitingAnimations make a list
              // switch an instant swap: the remount suppresses mass row
              // entering, and the outgoing list's rows exit without fade
              // ghosting. In-list add/remove animations are unaffected
              // (the skip applies only at list mount/unmount).
              key={activeListId ?? "grocery-items"}
              skipEnteringExitingAnimations
              itemLayoutAnimation={reduceMotion ? undefined : listReflow}
              data={sortedRows}
              keyExtractor={keyExtractor}
              renderItem={renderRow}
              contentContainerStyle={s.listContent}
              keyboardDismissMode="on-drag"
              onRefresh={handleRefresh}
              refreshing={refreshing}
              ListHeaderComponent={
                <View style={s.addItemRow}>
                  <TextInput
                    testID="grocery-add-input"
                    style={s.addItemInput}
                    placeholder="Add an item…"
                    placeholderTextColor={palette.text4}
                    value={addItemText}
                    onChangeText={setAddItemText}
                    onSubmitEditing={handleAddItem}
                    returnKeyType="done"
                    keyboardAppearance={kbAppearance}
                    editable={!addItemMutation.isPending}
                  />
                </View>
              }
            />
          ) : (
            <View style={s.emptyListContainer}>
              <View style={s.addItemRow}>
                <TextInput
                  testID="grocery-add-input"
                  style={s.addItemInput}
                  placeholder="Add an item…"
                  placeholderTextColor={palette.text4}
                  value={addItemText}
                  onChangeText={setAddItemText}
                  onSubmitEditing={handleAddItem}
                  returnKeyType="done"
                  keyboardAppearance={kbAppearance}
                  editable={!addItemMutation.isPending}
                />
              </View>
              <View style={s.emptyListGuide}>
                <Text style={s.emptyListGuideText}>
                  Add items above, or{" "}
                </Text>
                <Pressable onPress={() => router.push("/(app)/(tabs)")}>
                  <Text style={s.emptyListLink}>
                    browse your recipes
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </>
      )}
      </Animated.View>
    </Screen>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    switcherContainer: {
      flexShrink: 0,
      marginTop: spacing.md,
      marginBottom: spacing.sm,
    },
    switcherContent: {
      paddingHorizontal: spacing.xs,
    },
    switcherChip: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.base,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.border,
      marginRight: spacing.sm,
    },
    switcherChipActive: {
      backgroundColor: palette.accent,
      borderColor: palette.accent,
    },
    switcherChipText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.text3,
    },
    switcherChipTextActive: {
      color: palette.bg,
      fontFamily: fonts.bodySemiBold,
    },
    switcherChipNew: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.base,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: palette.accent,
      borderStyle: "dashed",
    },
    switcherChipNewText: {
      fontSize: fontSize.sm,
      fontFamily: fonts.bodyMedium,
      color: palette.accent,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingTop: spacing.md,
      marginBottom: spacing.md,
    },
    headerLeft: {
      flex: 1,
      marginRight: spacing.md,
    },
    listName: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.lg,
      color: palette.text1,
    },
    progressText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginTop: 2,
    },
    moreButton: {
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
    },
    moreIcon: {
      fontSize: fontSize.md,
      color: palette.text3,
    },
    emptyTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginBottom: spacing.sm,
    },
    emptySubtitle: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text3,
      marginBottom: spacing.xl,
      textAlign: "center",
      paddingHorizontal: spacing.xxl,
    },
    emptyListGuide: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "baseline",
      paddingTop: spacing.xl,
    },
    emptyListGuideText: {
      fontFamily: fonts.body,
      fontSize: fontSize.base,
      color: palette.text3,
    },
    emptyListLink: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.base,
      color: palette.accent,
    },
    listContent: {
      paddingBottom: spacing.xxxl,
    },
    emptyListContainer: {
      flex: 1,
      paddingTop: spacing.sm,
    },
    addItemRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: palette.divider,
    },
    addItemInput: {
      flex: 1,
      fontSize: fontSize.md,
      fontFamily: fonts.body,
      color: palette.text1,
      paddingVertical: spacing.sm,
    },
    swipeDeleteAction: {
      backgroundColor: palette.error,
      justifyContent: "center",
      alignItems: "center",
      width: 80,
    },
    swipeDeleteText: {
      fontFamily: fonts.bodySemiBold,
      color: palette.bg,
      fontSize: fontSize.base,
    },
    separatorRow: {
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      marginTop: spacing.xs,
    },
    separatorText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: palette.divider,
      backgroundColor: palette.bg,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      marginRight: spacing.md,
      justifyContent: "center",
      alignItems: "center",
    },
    checkboxChecked: {
      borderColor: palette.accent,
      backgroundColor: palette.accent,
    },
    checkboxUnchecked: {
      borderColor: palette.border,
      backgroundColor: palette.surface,
    },
    checkmark: {
      color: palette.bg,
      fontSize: fontSize.sm,
      fontWeight: "700",
    },
    rowContent: {
      flex: 1,
    },
    itemName: {
      fontFamily: fonts.body,
      fontSize: fontSize.md,
      color: palette.text1,
    },
    itemNameChecked: {
      color: palette.text4,
      textDecorationLine: "line-through",
      textDecorationColor: palette.text4,
    },
    itemSecondary: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginTop: 2,
    },
    itemNote: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text4,
      marginTop: 2,
    },
  });
}
