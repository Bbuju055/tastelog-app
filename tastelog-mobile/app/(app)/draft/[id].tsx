import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Alert,
  Animated,
  Easing,
  Linking,
  Pressable,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen, LoadingState, ErrorState, Button, SuccessBeat } from "../../../components";
import { useDraft } from "../../../lib/hooks/useDraft";
import { useDraftConfirm, useDraftDelete } from "../../../lib/hooks/useDraftConfirm";
// Deep import (15.1.2 precedent): keeps the lib/hooks barrel out of this
// screen's test module graph.
import { useReducedMotion } from "../../../lib/hooks/useReducedMotion";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
import { apiErrorMessage } from "../../../lib/apiErrorMessage";
import { hapticTap } from "../../../lib/haptics/haptics";
import { fonts, fontSize, motion, spacing, radius } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";
import type {
  DraftResponse,
  DraftConfirmRequest,
  IngredientData,
  StepData,
} from "../../../lib/api/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract display domain from a URL (strip protocol, path, query). */
function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Check if all ingredients have null quantity (unstructured fallback). */
function allIngredientsUnstructured(ingredients: IngredientData[]): boolean {
  return ingredients.length > 0 && ingredients.every((ing) => ing.quantity == null);
}

// ---------------------------------------------------------------------------
// Edit state — initialized from draft, mutated locally
// ---------------------------------------------------------------------------

type EditState = {
  title: string;
  servings: string;
  prep_time: string;
  cook_time: string;
  ingredients: IngredientData[];
  steps: StepData[];
};

function formatIngredientLine(ing: IngredientData): string {
  const parts: string[] = [];
  if (ing.quantity) parts.push(ing.quantity);
  if (ing.unit) parts.push(ing.unit);
  if (ing.name) parts.push(ing.name);
  let line = parts.join(" ");
  if (ing.prep) line += `, ${ing.prep}`;
  return line || "";
}

function initEditState(draft: DraftResponse): EditState {
  return {
    title: draft.title,
    servings: draft.servings ?? "",
    prep_time: draft.prep_time ?? "",
    cook_time: draft.cook_time ?? "",
    ingredients: draft.ingredients.map((ing, idx) => ({
      position: ing.position ?? idx + 1,
      quantity: ing.quantity,
      unit: ing.unit,
      name: ing.name,
      prep: ing.prep,
      raw_text: ing.raw_text ?? formatIngredientLine(ing),
    })),
    steps: draft.steps.map((step, idx) => ({
      position: step.position ?? idx + 1,
      instruction: step.instruction,
    })),
  };
}

// ---------------------------------------------------------------------------
// Patch builder — only sends fields that changed
// ---------------------------------------------------------------------------

function buildPatch(
  original: DraftResponse,
  edited: EditState,
): DraftConfirmRequest | undefined {
  const patch: DraftConfirmRequest = {};

  if (edited.title !== original.title) {
    patch.title = edited.title;
  }
  if (edited.servings !== (original.servings ?? "")) {
    patch.servings = edited.servings || undefined;
  }
  if (edited.prep_time !== (original.prep_time ?? "")) {
    patch.prep_time = edited.prep_time || undefined;
  }
  if (edited.cook_time !== (original.cook_time ?? "")) {
    patch.cook_time = edited.cook_time || undefined;
  }

  const origIngJson = JSON.stringify(original.ingredients);
  const editIngJson = JSON.stringify(edited.ingredients);
  if (editIngJson !== origIngJson) {
    patch.ingredients = edited.ingredients.map(
      ({ position: _, ...rest }) => rest,
    );
  }

  const origStepJson = JSON.stringify(original.steps);
  const editStepJson = JSON.stringify(edited.steps);
  if (editStepJson !== origStepJson) {
    patch.steps = edited.steps;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function DraftReviewScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);

  const { id } = useLocalSearchParams<{ id: string }>();
  const draftId = typeof id === "string" ? id : undefined;
  const router = useRouter();

  const { data: draft, error, isLoading, refetch } = useDraft(draftId);
  const confirmMutation = useDraftConfirm();
  const deleteMutation = useDraftDelete();
  // Issue 2 (C5): duplicate-tap protection for the Riff push. Unlocks on
  // focus regain when the riff modal dismisses.
  const riffGuard = useNavigationGuard();

  // 15.2 Gate A (F1): the confirm-window presentation hold renders from
  // the last loaded draft after the post-confirm invalidation 404s the
  // detail query and removes its cache. Scoped to the active route ID —
  // a draft held for one route can never render after a param change.
  const lastDraftRef = useRef<{ id: string; data: DraftResponse } | null>(null);
  if (draft) {
    lastDraftRef.current = { id: draft.id, data: draft };
  }

  const [editState, setEditState] = useState<EditState | null>(null);

  // Content fade-in on first load (10.C)
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const hasAnimatedRef = useRef(false);
  const reduceMotion = useReducedMotion();

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

  useEffect(() => {
    if (draft && !editState) {
      setEditState(initEditState(draft));
    }
  }, [draft, editState]);

  const updateField = useCallback(
    <K extends keyof EditState>(key: K, value: EditState[K]) => {
      setEditState((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    [],
  );

  const updateIngredientRawText = useCallback((index: number, raw_text: string) => {
    setEditState((prev) => {
      if (!prev) return prev;
      const updated = [...prev.ingredients];
      updated[index] = { ...updated[index], raw_text };
      return { ...prev, ingredients: updated };
    });
  }, []);

  const updateStepInstruction = useCallback((index: number, instruction: string) => {
    setEditState((prev) => {
      if (!prev) return prev;
      const updated = [...prev.steps];
      updated[index] = { ...updated[index], instruction };
      return { ...prev, steps: updated };
    });
  }, []);

  // Success-beat state (15.2.2, compact variant). Set in onSuccess; the
  // exactly-once completion path performs the replace.
  const [pendingBeat, setPendingBeat] = useState<{
    recipeId: string;
    startedAt: number;
  } | null>(null);

  // 15.2 Gate A (F1): the single owner of the confirm-window lifecycle.
  // True from Save-press through route unmount — the mutation stays
  // isPending while its awaited onSuccess invalidations run (the window
  // where the detail query 404s and is removed), isSuccess never resets
  // on this screen, and pendingBeat covers the beat presentation. Held
  // draft selection, pointer locking, action guards, loading/error
  // suppression, and the beat presentation all derive from this one
  // expression.
  const confirmLock =
    confirmMutation.isPending ||
    confirmMutation.isSuccess ||
    pendingBeat !== null;

  const handleSave = useCallback(() => {
    if (!draftId || !draft || !editState) return;
    if (confirmLock) {
      return;
    }

    const patch = buildPatch(draft, editState);
    confirmMutation.mutate(
      { draftId, patch },
      {
        onSuccess: (recipe) => {
          setPendingBeat({ recipeId: recipe.id, startedAt: Date.now() });
        },
      },
    );
  }, [draftId, draft, editState, confirmMutation, confirmLock]);

  const handleBeatComplete = useCallback(() => {
    const beat = pendingBeat;
    if (!beat) return;
    setPendingBeat(null);
    router.replace({
      pathname: "/(app)/recipe/[id]",
      params: { id: beat.recipeId },
    });
  }, [pendingBeat, router]);

  const handleDiscard = useCallback(() => {
    if (!draftId || confirmLock) return;

    Alert.alert("Discard Draft", "This draft will be permanently deleted.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          deleteMutation.mutate(draftId, {
            onSuccess: () => {
              router.replace("/");
            },
          });
        },
      },
    ]);
  }, [draftId, deleteMutation, router, confirmLock]);

  // Phase 13.9 Slice I / Issue 2: Riff entry navigation. Pure route push;
  // does not confirm or save the draft, does not mutate draft state, does
  // not call backend. fullScreenModal overlays the Draft Review; dismiss
  // without saving returns the user to this screen (which unlocks the
  // guard). The haptic fires inside the guard so a discarded second tap
  // never buzzes (C3/C5).
  const handleOpenRiff = useCallback(() => {
    if (!draftId || confirmLock) return;
    riffGuard.guard(() => {
      hapticTap();
      router.push({
        pathname: "/draft/riff/[id]",
        params: { id: draftId },
      });
    });
  }, [draftId, router, confirmLock, riffGuard]);

  // --- Render ---

  if (!draftId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid draft ID.</Text>
      </Screen>
    );
  }

  // 15.2 Gate A (F1): inside the confirm window the detail query 404s
  // (the draft is deleted server-side) and its cache is removed. Render
  // from the held draft and suppress the loading/error branches so the
  // beat lifecycle is never unmounted mid-handoff.
  const renderDraft =
    draft ??
    (confirmLock && lastDraftRef.current?.id === draftId
      ? lastDraftRef.current.data
      : undefined);

  if (isLoading && !renderDraft) {
    return (
      <Screen style={s.centered}>
        <LoadingState message="Loading draft…" />
      </Screen>
    );
  }

  if ((error && !confirmLock) || !renderDraft || !editState) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={error ? apiErrorMessage(error) : "Failed to load draft."}
          onRetry={refetch}
        />
      </Screen>
    );
  }

  const isBusy = confirmLock || deleteMutation.isPending;

  // Issue 2 (C6): the riff entry is ABSENT for a draft already expired at
  // render time. The backend's draft-riff route resolves drafts via
  // get_active_draft and rejects expired ones with DRAFT_EXPIRED, while the
  // review GET happily renders them; advertising a riff that
  // deterministically fails would lie. Device-clock skew is accepted and
  // declared; the server check stays authoritative.
  const draftRiffEligible =
    new Date(renderDraft.expires_at).getTime() > Date.now();

  return (
    <Screen>
      {/* The draft surface is pointer-blocked for the ENTIRE confirm
          window (Save-press through route unmount) — not only while the
          beat Modal is up. AT-hiding stays scoped to the beat so
          VoiceOver focus is not yanked mid-save. */}
      <Animated.View
        style={{ opacity: contentOpacity, flex: 1 }}
        pointerEvents={confirmLock ? "none" : "auto"}
        accessibilityElementsHidden={pendingBeat !== null}
        importantForAccessibility={
          pendingBeat ? "no-hide-descendants" : "auto"
        }
      >
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.heading}>Review Draft</Text>

        {/* Source label */}
        {renderDraft.source_url ? (
          <Pressable
            onPress={() => Linking.openURL(renderDraft.source_url!)}
            // RB-4: pointerEvents="none" blocks touch, not assistive-
            // technology activation — the confirm window must also
            // disable the only unguarded actionable on this surface.
            disabled={confirmLock}
          >
            <Text style={s.sourceLabel}>
              Imported from {extractDomain(renderDraft.source_url)} {"\u2197"}
            </Text>
          </Pressable>
        ) : (
          <Text style={s.sourceLabel}>Imported from photo</Text>
        )}

        {/* Title */}
        <Text style={s.label}>Title</Text>
        <TextInput
          style={s.input}
          value={editState.title}
          onChangeText={(v) => updateField("title", v)}
          placeholder="Recipe title"
          placeholderTextColor={palette.text4}
          keyboardAppearance={theme === "dark" ? "dark" : "light"}
          editable={!isBusy}
        />

        {/* Meta fields */}
        <View style={s.metaRow}>
          <View style={s.metaField}>
            <Text style={s.label}>Servings</Text>
            <TextInput
              style={s.input}
              value={editState.servings}
              onChangeText={(v) => updateField("servings", v)}
              placeholder="e.g. 4"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              editable={!isBusy}
            />
          </View>
          <View style={s.metaField}>
            <Text style={s.label}>Prep Time</Text>
            <TextInput
              style={s.input}
              value={editState.prep_time}
              onChangeText={(v) => updateField("prep_time", v)}
              placeholder="e.g. 15 min"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              editable={!isBusy}
            />
          </View>
          <View style={s.metaField}>
            <Text style={s.label}>Cook Time</Text>
            <TextInput
              style={s.input}
              value={editState.cook_time}
              onChangeText={(v) => updateField("cook_time", v)}
              placeholder="e.g. 30 min"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              editable={!isBusy}
            />
          </View>
        </View>

        {/* Ingredients */}
        <Text style={s.sectionTitle}>Ingredients</Text>
        {editState.ingredients.map((ing, idx) => (
          <View key={`ing-${idx}`} style={s.editableRow}>
            <Text style={s.rowNumber}>{idx + 1}.</Text>
            <TextInput
              style={[s.input, s.rowInput]}
              value={ing.raw_text ?? formatIngredientLine(ing)}
              onChangeText={(v) => updateIngredientRawText(idx, v)}
              placeholder="Ingredient"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              editable={!isBusy}
            />
          </View>
        ))}

        {/* Steps */}
        <Text style={s.sectionTitle}>Steps</Text>
        {editState.steps.map((step, idx) => (
          <View key={`step-${idx}`} style={s.editableRow}>
            <Text style={s.rowNumber}>{idx + 1}.</Text>
            <TextInput
              style={[s.input, s.rowInput, s.multiline]}
              value={step.instruction}
              onChangeText={(v) => updateStepInstruction(idx, v)}
              placeholder="Step instruction"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              multiline
              editable={!isBusy}
            />
          </View>
        ))}

        {/* Confidence / status */}
        {renderDraft.source_url && allIngredientsUnstructured(editState.ingredients) ? (
          <View style={s.fallbackNotice}>
            <Text style={s.fallbackNoticeText}>
              Ingredients imported as text — scaling and grocery structure unavailable for this recipe.
            </Text>
          </View>
        ) : renderDraft.source_url ? (
          <Text style={s.confidence}>Fully structured recipe</Text>
        ) : renderDraft.confidence_score != null ? (
          <Text style={s.confidence}>
            AI confidence: {Math.round(renderDraft.confidence_score * 100)}%
          </Text>
        ) : null}

        {/* Mutation error */}
        {confirmMutation.error ? (
          <Text style={s.errorText}>
            {apiErrorMessage(confirmMutation.error)}
          </Text>
        ) : null}
        {deleteMutation.error ? (
          <Text style={s.errorText}>
            {apiErrorMessage(deleteMutation.error)}
          </Text>
        ) : null}

        {/* Issue 2 (C1): the Riff entry renders via the shared outline
            Button, matching the recipe-detail action grid (the Session 51
            entry row this section once mirrored was replaced by the 15.2.4
            grid). The wrapper preserves the old row's vertical rhythm;
            Button has no style prop by design. */}
        {draftRiffEligible ? (
          <View style={s.riffEntryContainer}>
            <Button
              title="Riff on this draft"
              variant="outline"
              fullWidth
              haptic={false}
              onPress={handleOpenRiff}
              disabled={isBusy || riffGuard.locked}
              accessibilityLabel="Riff on this draft"
            />
          </View>
        ) : null}

        {/* Actions */}
        <View style={s.actions}>
          <Button
            title="Save Recipe"
            onPress={handleSave}
            variant="outline"
            loading={confirmMutation.isPending}
            disabled={isBusy || !editState.title.trim()}
          />
          <Button
            title="Discard"
            onPress={handleDiscard}
            variant="outline"
            loading={deleteMutation.isPending}
            disabled={isBusy}
          />
        </View>
      </ScrollView>
      </Animated.View>
      {pendingBeat ? (
        <SuccessBeat
          title="Saved to your cookbook"
          accessibilityHint="Opens your saved recipe."
          variant="compact"
          startedAt={pendingBeat.startedAt}
          onComplete={handleBeatComplete}
        />
      ) : null}
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
    scrollContent: {
      paddingTop: spacing.base,
      paddingBottom: spacing.xxxl,
    },
    heading: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xxl,
      color: palette.text1,
      marginBottom: spacing.lg,
      letterSpacing: -0.5,
    },
    label: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginBottom: spacing.xs,
    },
    input: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      fontSize: fontSize.md,
      fontFamily: fonts.body,
      color: palette.text1,
      backgroundColor: palette.card,
      marginBottom: spacing.md,
    },
    metaRow: {
      flexDirection: "row",
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    metaField: {
      flex: 1,
    },
    sectionTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginTop: spacing.sm,
      marginBottom: spacing.md,
      letterSpacing: -0.2,
    },
    editableRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      marginBottom: spacing.xs,
    },
    rowNumber: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.md,
      color: palette.text3,
      width: 28,
      paddingTop: spacing.md,
    },
    rowInput: {
      flex: 1,
    },
    multiline: {
      minHeight: 60,
      textAlignVertical: "top",
    },
    sourceLabel: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.accent,
      marginBottom: spacing.md,
    },
    confidence: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text4,
      textAlign: "center",
      marginTop: spacing.sm,
      marginBottom: spacing.base,
    },
    fallbackNotice: {
      backgroundColor: palette.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      marginTop: spacing.sm,
      marginBottom: spacing.base,
    },
    fallbackNoticeText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.warning,
      textAlign: "center",
    },
    errorText: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
      marginBottom: spacing.md,
    },
    actions: {
      gap: spacing.md,
      marginTop: spacing.sm,
    },
    // Issue 2: spacing wrapper for the shared-Button riff entry (keeps the
    // old entry row's 24pt top separation from the content above).
    riffEntryContainer: {
      marginTop: spacing.xl,
    },
  });
}
