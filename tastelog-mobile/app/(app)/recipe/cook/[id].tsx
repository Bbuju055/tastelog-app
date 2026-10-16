import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  type EdgeInsets,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useKeepAwake } from "expo-keep-awake";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  ErrorState,
  LoadingState,
  Screen,
  SuccessBeat,
} from "../../../../components";
import { useRecipe } from "../../../../lib/hooks";
import { useCookingNavigation } from "../../../../lib/hooks/useCookingNavigation";
// Deep import (15.1.2 precedent): keeps the lib/hooks barrel out of this
// screen's test module graph.
import { useReducedMotion } from "../../../../lib/hooks/useReducedMotion";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../../lib/hooks/useNavigationGuard";
import {
  deriveScaleFactor,
  parseServings,
} from "../../../../lib/ingredients/scaling";
import { scaleIngredient } from "../../../../lib/ingredients/scaleIngredient";
import { formatIngredient } from "../../../../lib/ingredients/formatIngredient";
import { ONE } from "../../../../lib/ingredients/rational";
import { matchIngredientsToStep } from "../../../../lib/cooking/matchIngredientsToStep";
import { buildCookingRiffDraft, useVoiceCommands } from "../../../../lib/cooking";
import { hapticTap } from "../../../../lib/haptics/haptics";
import type { IngredientResponse } from "../../../../lib/api/schemas";
import type { ScaleResult } from "../../../../lib/ingredients/types";
import type { FormattedIngredient } from "../../../../lib/ingredients/formatIngredient";
import type { ThemePalette } from "../../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../../theme/ThemeProvider";
import { fonts, fontSize, lineHeight, radius, spacing } from "../../../../theme";

/**
 * Cooking Mode (Phase 9.A, step 2.5c — motion + interaction)
 *
 * Adds on top of 2.5b:
 * - Opacity-only crossfade on step change (150-200ms, useNativeDriver: true)
 * - Keyed content remount at the fade-out midpoint (no ghosting)
 * - Transition lock acquired synchronously in handlers; released by the
 *   animation effect on natural fade-in completion
 * - hapticTap on successful step change; the completion beat (SuccessBeat)
 *   owns the single success haptic on Done
 * - Close (X) remains a plain exit
 *
 * Still excluded (land in 2.5d):
 * - useKeepAwake
 * - Route registration
 * - Start Cooking entry on recipe detail
 */

const FADE_DURATION_MS = 90; // two phases = 180ms total (within 150-200ms spec)

type ScaledIngredientEntry = {
  ingredient: IngredientResponse;
  result: ScaleResult;
  formatted: FormattedIngredient;
};

// Full semantic label for an ingredient callout / list row: quantity + unit
// + name, plus preparation and qualifier annotations ("(to taste)"). The
// "not scaled" marker renders separately (dimmer nested Text) so it reads
// as status, not content. No cap and no truncation: hiding required
// quantities is the defect this feature exists to fix.
function formatCalloutLabel(formatted: FormattedIngredient): string {
  let label = formatted.main;
  if (formatted.prep) label += `, ${formatted.prep}`;
  if (formatted.annotation) label += ` ${formatted.annotation}`;
  return label;
}

function ProgressIndicator({
  current,
  total,
  s,
}: {
  current: number;
  total: number;
  s: ReturnType<typeof createStyles>;
}) {
  if (total <= 9) {
    return (
      <View style={s.progressDots} testID="progress-dots">
        {Array.from({ length: total }, (_, i) => (
          <View
            key={i}
            style={[
              s.dot,
              i === current ? s.dotActive : s.dotInactive,
            ]}
          />
        ))}
      </View>
    );
  }

  const fillPercent = ((current + 1) / total) * 100;
  return (
    <View style={s.progressBarTrack} testID="progress-bar">
      <View
        style={[s.progressBarFill, { width: `${fillPercent}%` }]}
      />
    </View>
  );
}

export default function CookingModeScreen() {
  const { id, desiredServings: desiredServingsParam } = useLocalSearchParams<{
    id?: string;
    desiredServings?: string;
  }>();
  const recipeId = typeof id === "string" ? id : undefined;
  const desiredServingsText =
    typeof desiredServingsParam === "string" ? desiredServingsParam : "";
  const router = useRouter();

  // ---- Theme ----
  useScreenTheme("dark");
  const { palette } = useTheme();
  // useSafeAreaInsets is the canonical fix for fullScreenModal headers — the
  // native SafeAreaView path inside <Screen> does not propagate the top inset
  // reliably here. Same pattern shipped for Riff in commit 570012a.
  const insets = useSafeAreaInsets();
  const s = createStyles(palette, insets);

  // ---- Hooks (must run unconditionally, stable order) ----

  const { data: recipe, error, isLoading, refetch } = useRecipe(recipeId);

  // Keep the screen awake for the entire lifetime of Cooking Mode.
  // Hook activates on mount, releases on unmount. No imperative wiring.
  useKeepAwake();

  // Animation state — created once, persists across renders.
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const [displayedStep, setDisplayedStep] = useState(0);
  const isFirstStepRenderRef = useRef(true);
  // Issue 3 (section 9): transition generation. Every new transition AND
  // every step-count shrink/reset bumps it; async animation completions
  // from a superseded generation are ignored, so a stale callback can
  // never restore an invalid index or lock state.
  const transitionGenRef = useRef(0);

  // G-15.1 — crossfade/re-flash gate.
  const reduceMotion = useReducedMotion();

  // Voice control toggle state. Lazy permission flow per Phase 9.C spec §3:
  // permissions are requested only on first toggle, never on screen mount.
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  // Completion beat state machine (15.2.3-C): idle → beat → handoff.
  // `beat` renders the reward SuccessBeat over the still-mounted cook screen;
  // `handoff` unmounts it and navigates to the cook log. `completedAt` seeds
  // the beat's dwell deadline (a suspended timer can never stretch it).
  const [completionPhase, setCompletionPhase] = useState<
    "idle" | "beat" | "handoff"
  >("idle");
  const [completedAt, setCompletedAt] = useState<number | null>(null);

  // All Ingredients sheet (Issue 1, D2): pure local state driving a native
  // page-sheet Modal. No route change, so displayedStep / nav /
  // completionPhase are untouched: closing the sheet returns to the exact
  // step the cook was on.
  const [allIngredientsOpen, setAllIngredientsOpen] = useState(false);

  // Issue 2 (C5): duplicate-tap protection for the Ask Riff push. Unlocks
  // on focus regain when the riff modal dismisses (this screen stays
  // mounted underneath).
  const riffGuard = useNavigationGuard();

  // Screen focus gate for voice. When the Riff full-screen modal is pushed
  // over Cooking Mode, this screen blurs (stays mounted) — mirrors the
  // useScreenTheme/useFocusEffect precedent that drives the dark↔light
  // theme switch across these same two fullScreenModal routes. The user's
  // voiceEnabled intent is preserved; only the derived `enabled` passed to
  // useVoiceCommands flips, so listening stops on blur and resumes on
  // return iff voice is still toggled on. Initial true: mount = focused.
  const [screenFocused, setScreenFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      // Returning to a still-mounted cook screen (back from the cook log, or
      // native dismissal) clears any prior completion so voice + nav resume.
      setCompletionPhase("idle");
      return () => setScreenFocused(false);
    }, []),
  );

  const sortedSteps = useMemo(() => {
    if (!recipe) return [];
    return [...recipe.steps].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );
  }, [recipe]);

  const baseServings = useMemo(
    () => (recipe ? parseServings(recipe.servings) : null),
    [recipe],
  );
  const scaleFactor = useMemo(
    () => deriveScaleFactor(baseServings, desiredServingsText),
    [baseServings, desiredServingsText],
  );
  const effectiveFactor = scaleFactor ?? ONE;

  const sortedIngredients = useMemo(() => {
    if (!recipe) return [];
    return [...recipe.ingredients].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );
  }, [recipe]);

  const scaledIngredients = useMemo<ScaledIngredientEntry[]>(() => {
    return sortedIngredients.map((ing) => {
      const result = scaleIngredient(ing, effectiveFactor);
      const formatted = formatIngredient(result, ing, effectiveFactor);
      return { ingredient: ing, result, formatted };
    });
  }, [sortedIngredients, effectiveFactor]);

  const scaledById = useMemo(() => {
    const map = new Map<string, ScaledIngredientEntry>();
    for (const entry of scaledIngredients) {
      map.set(entry.ingredient.id, entry);
    }
    return map;
  }, [scaledIngredients]);

  const nav = useCookingNavigation(sortedSteps.length);

  // Issue 3 (section 9): a saved-recipe edit can shrink the cached step
  // array under this mounted screen. Derive a safe index SYNCHRONOUSLY
  // before every render-time access (never one render later); the effect
  // below reconciles the stored state and supersedes any in-flight
  // transition.
  const lastStepIndex = Math.max(0, sortedSteps.length - 1);
  const safeDisplayedStep = Math.min(displayedStep, lastStepIndex);

  useEffect(() => {
    if (displayedStep > lastStepIndex) {
      // Shrink while mounted: supersede any in-flight transition, snap
      // fully visible at the clamped step, and free the lock.
      transitionGenRef.current += 1;
      fadeAnim.stopAnimation();
      fadeAnim.setValue(1);
      setDisplayedStep(lastStepIndex);
      nav.endTransition();
    }
  }, [displayedStep, lastStepIndex, fadeAnim, nav.endTransition]);

  // Callouts follow displayedStep (what's on screen), not nav.step (what was
  // requested). This keeps callouts synced with the visible instruction
  // during the crossfade.
  //
  // Issue 1 authority branch: a persisted step mapping (ingredient_ids,
  // already in canonical ingredient order) is the truth. An authoritative
  // empty array means the step genuinely uses no ingredients and must NOT
  // invoke the text matcher. Only an unknown mapping (null/absent: legacy
  // recipes, degraded captures) falls back to matchIngredientsToStep.
  const currentStepCallouts = useMemo<ScaledIngredientEntry[]>(() => {
    const step = sortedSteps[safeDisplayedStep];
    if (!step) return [];
    const entries: ScaledIngredientEntry[] = [];
    const mappedIds = step.ingredient_ids;
    if (mappedIds !== undefined && mappedIds !== null) {
      // Authority is all-or-nothing: if ANY persisted id fails to resolve
      // against the current ingredient set, the mapping no longer
      // describes this recipe. Treat the whole step as unknown and fall
      // through to the matcher instead of showing a sanitized subset.
      const mapped = mappedIds.map((id) => scaledById.get(id));
      if (mapped.every((entry): entry is ScaledIngredientEntry => !!entry)) {
        for (const entry of mapped) {
          if (!entry.formatted.main || entry.formatted.main.trim() === "")
            continue;
          entries.push(entry);
        }
        return entries;
      }
    }
    const matched = matchIngredientsToStep(
      sortedIngredients,
      step.instruction,
    );
    for (const ing of matched) {
      const entry = scaledById.get(ing.id);
      if (!entry) continue;
      if (!entry.formatted.main || entry.formatted.main.trim() === "") continue;
      entries.push(entry);
    }
    return entries;
  }, [sortedSteps, safeDisplayedStep, sortedIngredients, scaledById]);

  // Step transition animation.
  //
  // Handlers own the lock acquisition (beginTransition) to keep the
  // imperative "advance and lock" commands co-located in the user-action
  // path. This effect is a pure reaction to nav.step changes: animate the
  // visual transition, swap content at the invisible midpoint, release the
  // lock on natural fade-in completion. Cancelled animations
  // (finished === false) skip endTransition because the component is
  // unmounting and the stale lock is unobservable.
  useEffect(() => {
    if (isFirstStepRenderRef.current) {
      isFirstStepRenderRef.current = false;
      return;
    }
    // Issue 3 (section 9): this transition supersedes any older one. Its
    // async completions apply only while its generation is current, a
    // stale callback (superseded by a shrink/reset or a newer transition)
    // must never restore an invalid index or touch the lock.
    transitionGenRef.current += 1;
    const generation = transitionGenRef.current;
    if (reduceMotion) {
      // G-15.1: no crossfade. Cancel any in-flight fade first — its
      // callbacks bail on finished === false, so the endTransition below
      // is the only lock release — then snap fully visible (never assume
      // fadeAnim is already 1), swap the content, and free the lock.
      fadeAnim.stopAnimation();
      fadeAnim.setValue(1);
      setDisplayedStep(nav.step);
      nav.endTransition();
      return;
    }
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: FADE_DURATION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      if (generation !== transitionGenRef.current) return;
      setDisplayedStep(nav.step);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: FADE_DURATION_MS,
        useNativeDriver: true,
      }).start(({ finished: finished2 }) => {
        if (!finished2) return;
        if (generation !== transitionGenRef.current) return;
        nav.endTransition();
      });
    });
  }, [nav.step, nav.endTransition, fadeAnim, reduceMotion]);

  // ---- Handlers ----

  const handleNext = () => {
    if (completionPhase !== "idle") return;
    if (!nav.canGoNext) return;
    nav.beginTransition();
    hapticTap();
    nav.goNext();
  };

  const handlePrev = () => {
    if (completionPhase !== "idle") return;
    if (!nav.canGoPrev) return;
    nav.beginTransition();
    hapticTap();
    nav.goPrev();
  };

  // Start the completion beat. Guarded so it can only fire from a settled
  // final step: not mid-crossfade (displayedStep === nav.step), the shown
  // step is last, and no beat is already in flight. The beat owns the single
  // success haptic; navigation is deferred to handleCompletionBeatDone.
  const handleDone = () => {
    if (completionPhase !== "idle") return;
    if (nav.isTransitioning) return;
    if (safeDisplayedStep !== nav.step) return;
    if (!nav.isLastStep) return;
    setCompletedAt(Date.now());
    setCompletionPhase("beat");
  };

  // Post-dismiss handoff (15.2.3-CF). SuccessBeat runs with waitForDismiss, so
  // this fires as its single onComplete — on iOS only AFTER the beat's
  // full-screen Modal has finished its native UIKit dismissal (directly on
  // Android). The beat's view controller is therefore already gone, so
  // presenting the cook-log modal here cannot race that dismissal — the exact
  // overlap that intermittently stranded the cook on the last step. Exactly-
  // once is enforced inside SuccessBeat; the phase guard makes any stray
  // re-entry a no-op. Cook-log destination and params are unchanged: scale is
  // present only when the cook was scaled.
  const handleCompletionBeatDone = () => {
    if (completionPhase !== "beat") return;
    setCompletionPhase("handoff");
    const scaleStr =
      scaleFactor !== null ? `${desiredServingsText} servings` : undefined;
    router.push({
      pathname: "/recipe/cook-log/[id]",
      params: {
        id: recipeId!,
        from: "cooking",
        ...(scaleStr ? { scale: scaleStr } : {}),
      },
    });
  };

  const handleClose = () => {
    router.back();
  };

  // Re-flash current step content (Phase 9.C spec §4.3, §5.4). Reuses the
  // existing fadeAnim. Does NOT acquire the transition lock and does NOT
  // change displayedStep/nav.step — pure visual re-emphasis. The hook's
  // isTransitioning gate prevents this from racing an in-flight step
  // transition.
  const handleRepeat = () => {
    if (completionPhase !== "idle") return;
    hapticTap();
    if (reduceMotion) {
      // G-15.1: keep the haptic, skip the visual re-flash. Also cancel a
      // re-flash already running from before the preference resolved so
      // opacity cannot stick below 1.
      fadeAnim.stopAnimation();
      fadeAnim.setValue(1);
      return;
    }
    Animated.sequence([
      Animated.timing(fadeAnim, {
        toValue: 0.3,
        duration: FADE_DURATION_MS,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: FADE_DURATION_MS,
        useNativeDriver: true,
      }),
    ]).start();
  };

  // Voice command runtime. Hook stays callback-pure: it dispatches to the
  // existing handleNext/handlePrev/handleRepeat (which already wire haptics)
  // and respects the transition lock + nav bounds via the gates below.
  const voice = useVoiceCommands({
    // The All Ingredients sheet gates voice like a blur does: listening
    // stops while it is open and resumes on close iff still toggled on.
    enabled:
      voiceEnabled &&
      screenFocused &&
      completionPhase === "idle" &&
      !allIngredientsOpen,
    onNext: handleNext,
    onBack: handlePrev,
    onRepeat: handleRepeat,
    canGoNext: nav.canGoNext,
    canGoPrev: nav.canGoPrev,
    isTransitioning: nav.isTransitioning,
  });

  const handleToggleVoice = async () => {
    if (voiceEnabled) {
      setVoiceEnabled(false);
      return;
    }
    if (voice.permissionStatus === "granted") {
      setVoiceEnabled(true);
      return;
    }
    const ok = await voice.requestPermissions();
    if (ok) setVoiceEnabled(true);
  };

  // Cooking Mode Riff entry (cross-screen-riff-decisions.md §2.1). Pushes
  // the existing recipe Riff full-screen modal — Cooking Mode stays mounted
  // underneath, so dismiss returns to this exact step. The visible step
  // (sortedSteps[displayedStep], same as the rendered instruction) rides in
  // an editable initialDraft prefill; no auto-send, no backend payload field.
  const handleOpenRiff = () => {
    const step = sortedSteps[safeDisplayedStep];
    if (!step) return;
    // Issue 2 (C3/C5): haptic fires inside the guard so a discarded second
    // tap never buzzes.
    riffGuard.guard(() => {
      hapticTap();
      router.push({
        pathname: "/recipe/riff/[id]",
        params: {
          id: recipeId!,
          entryPoint: "cooking_mode",
          initialDraft: buildCookingRiffDraft(step),
        },
      });
    });
  };

  // All Ingredients sheet (Issue 1, D2): local state only, never navigation.
  const handleOpenAllIngredients = () => {
    hapticTap();
    setAllIngredientsOpen(true);
  };

  const handleCloseAllIngredients = () => {
    setAllIngredientsOpen(false);
  };

  // Horizontal swipe — secondary nav per spec. activeOffsetX ensures vertical
  // scroll (long instructions) is never hijacked. failOffsetY bails early when
  // the user is clearly scrolling vertically.
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-30, 30])
    .failOffsetY([-20, 20])
    .runOnJS(true)
    .onEnd((event) => {
      if (event.translationX < -50 && nav.canGoNext) {
        nav.beginTransition();
        hapticTap();
        nav.goNext();
      } else if (event.translationX > 50 && nav.canGoPrev) {
        nav.beginTransition();
        hapticTap();
        nav.goPrev();
      }
    })
    .withTestId("cook-swipe");

  // ---- Early returns (all hooks already called) ----

  if (!recipeId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid recipe ID.</Text>
      </Screen>
    );
  }

  if (isLoading) {
    return (
      <Screen style={s.centered}>
        <LoadingState message="Loading recipe…" />
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

  const stepCount = sortedSteps.length;

  // ---- 0-step fallback ----

  if (stepCount === 0) {
    return (
      <Screen style={s.container}>
        <View style={s.header}>
          <Pressable
            onPress={handleClose}
            hitSlop={16}
            style={s.closeButton}
            accessibilityRole="button"
            accessibilityLabel="Close cooking mode"
          >
            <Text style={s.closeText}>{"\u2715"}</Text>
          </Pressable>
        </View>
        <View style={s.emptyContent}>
          <Text style={s.emptyText}>
            No steps available for this recipe.
          </Text>
        </View>
      </Screen>
    );
  }

  // ---- Main render (1-step and multi-step) ----

  const currentStep = sortedSteps[safeDisplayedStep];

  return (
    <Screen style={s.container}>
      {/* Header: Close (X) — outside the animation, always interactive */}
      <View style={s.header}>
        <Pressable
          onPress={handleClose}
          hitSlop={16}
          style={s.closeButton}
          accessibilityRole="button"
          accessibilityLabel="Close cooking mode"
        >
          <Text style={s.closeText}>{"\u2715"}</Text>
        </Pressable>
        {stepCount > 0 && (
          <Pressable
            onPress={handleToggleVoice}
            hitSlop={16}
            style={s.micButton}
            accessibilityRole="button"
            accessibilityState={{ selected: voiceEnabled }}
            accessibilityLabel={
              voiceEnabled ? "Voice control on" : "Voice control off"
            }
            accessibilityHint={
              voiceEnabled
                ? "Tap to disable voice commands"
                : "Tap to enable voice commands during cooking"
            }
          >
            <Ionicons
              name={voiceEnabled ? "mic" : "mic-off"}
              size={22}
              color={voice.isListening ? palette.primary : palette.text3}
            />
          </Pressable>
        )}
      </View>

      {voice.error !== null && (
        <Text style={s.voiceErrorText} accessibilityLiveRegion="polite">
          {voice.error}
        </Text>
      )}

      {/* Visible listening status — additive visual aid only. Not an
          accessibility live region: the mic button's accessibilityState /
          label already conveys listening to VoiceOver, so announcing this
          too would double-speak. Derived from real voice + focus state. */}
      {voiceEnabled && screenFocused && completionPhase === "idle" && voice.isListening && (
        <Text
          style={s.listeningLabel}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          Listening…
        </Text>
      )}

      {/* Animated step content: crossfades as a unit, keyed for clean
          remount. Issue 1 (D1): the counter, ALL ingredient callouts, and
          the instruction share ONE vertical ScrollView inside the existing
          pan gesture, so long ingredient sets wrap and scroll naturally
          with no cap, no clipping, and no reveal action, while the
          navigation footer below stays fixed. The gesture thresholds
          (activeOffsetX / failOffsetY) keep vertical scrolling and
          horizontal step swipes from fighting. */}
      <Animated.View
        key={safeDisplayedStep}
        style={[s.animatedContent, { opacity: fadeAnim }]}
      >
        <GestureDetector gesture={swipeGesture}>
          <ScrollView
            style={s.body}
            contentContainerStyle={s.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={s.stepCounter}>
              Step {safeDisplayedStep + 1} of {stepCount}
            </Text>

            {currentStepCallouts.length > 0 && (
              <View style={s.calloutRow}>
                {currentStepCallouts.map((entry) => (
                  <View key={entry.ingredient.id} style={s.calloutPill}>
                    <Text style={s.calloutText}>
                      {formatCalloutLabel(entry.formatted)}
                      {entry.formatted.showNotScaled && (
                        <Text style={s.calloutNotScaled}> not scaled</Text>
                      )}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={s.instruction}>{currentStep.instruction}</Text>
          </ScrollView>
        </GestureDetector>
      </Animated.View>

      {/* Utility row: content-area affordances (not header, not step-nav
          row). Stable across step transitions (outside the keyed
          Animated.View). Only reachable here (stepCount >= 1); the 0-step
          fallback returns earlier and never renders this. All ingredients
          (Issue 1, D2) opens the in-mode sheet; Ask Riff pushes the Riff
          modal. Issue 2 (C1/C7): both are shared outline Buttons at the
          default md size (44pt+ touch targets); haptic={false} because
          both handlers own their haptic. All ingredients keeps its exact
          prior behavior (sheet open, one haptic per press): its conversion
          is presentation/touch-target consistency only (F13 KEEP ruling). */}
      <View style={s.utilityRow}>
        <Button
          title="All ingredients"
          onPress={handleOpenAllIngredients}
          variant="outline"
          size="md"
          haptic={false}
          accessibilityLabel="All ingredients"
        />
        <Button
          title="Ask Riff"
          onPress={handleOpenRiff}
          variant="outline"
          size="md"
          haptic={false}
          disabled={riffGuard.locked}
          accessibilityLabel="Ask Riff about this step"
        />
      </View>

      {/* Single-step: Done is the only action, spans full width */}
      {stepCount === 1 && (
        <View style={s.navRow}>
          <View style={s.navButtonSlot}>
            <Button
              title="Done"
              onPress={handleDone}
              size="lg"
              fullWidth
              haptic={false}
              accessibilityLabel="Done cooking"
            />
          </View>
        </View>
      )}

      {/* Multi-step: Back + (Next or Done) */}
      {stepCount > 1 && (
        <View style={s.navRow}>
          <View style={s.navButtonSlot}>
            <Button
              title="Back"
              onPress={handlePrev}
              disabled={!nav.canGoPrev}
              size="lg"
              fullWidth
              haptic={false}
              accessibilityLabel="Previous step"
            />
          </View>
          <View style={s.navButtonSlot}>
            {nav.isLastStep ? (
              <Button
                title="Done"
                onPress={handleDone}
                size="lg"
                fullWidth
                haptic={false}
                accessibilityLabel="Done cooking"
              />
            ) : (
              <Button
                title="Next"
                onPress={handleNext}
                disabled={!nav.canGoNext}
                size="lg"
                fullWidth
                haptic={false}
                accessibilityLabel="Next step"
              />
            )}
          </View>
        </View>
      )}

      {/* Progress indicator — dots (≤9 steps) or bar (≥10 steps) */}
      {stepCount > 1 && (
        <ProgressIndicator current={safeDisplayedStep} total={stepCount} s={s} />
      )}

      {/* Completion beat (15.2.3-C) — reward-tone SuccessBeat over the still-
          mounted cook screen. Owns the single success haptic. waitForDismiss
          (15.2.3-CF) defers onComplete until the beat's native Modal dismissal
          finishes, so the cook-log push in handleCompletionBeatDone cannot race
          it. Exactly-once completion (tap / dwell / resume / Android back). */}
      {completionPhase === "beat" && completedAt !== null && (
        <SuccessBeat
          tone="reward"
          variant="full"
          waitForDismiss
          title="Nicely done"
          accessibilityHint="Continue to log your cook."
          startedAt={completedAt}
          onComplete={handleCompletionBeatDone}
        />
      )}

      {/* All Ingredients sheet (Issue 1, D2): native page-sheet over the
          still-mounted cook screen. Local state only: the current step and
          completion state survive open/close untouched. Shows the complete
          recipe ingredient list on the SAME scaling basis as the step
          callouts (the shared scaledIngredients array). Voice is gated off
          while open via the useVoiceCommands enabled derivation. */}
      {allIngredientsOpen && (
      <Modal
        visible
        presentationStyle="pageSheet"
        animationType={reduceMotion ? "none" : "slide"}
        onRequestClose={handleCloseAllIngredients}
      >
        <View style={s.sheetContainer}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>Ingredients</Text>
            <Pressable
              onPress={handleCloseAllIngredients}
              hitSlop={16}
              accessibilityRole="button"
              accessibilityLabel="Close ingredients"
            >
              <Text style={s.closeText}>{"✕"}</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={s.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            {scaledIngredients.map((entry) => (
              <View key={entry.ingredient.id} style={s.sheetRow}>
                <Text style={s.sheetRowText}>
                  {formatCalloutLabel(entry.formatted)}
                  {entry.formatted.showNotScaled && (
                    <Text style={s.calloutNotScaled}> not scaled</Text>
                  )}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Styles — Phase 15.2.3 cooking-mode presentation.
// ---------------------------------------------------------------------------

function createStyles(palette: ThemePalette, insets: EdgeInsets) {
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
    container: {
      flex: 1,
      paddingHorizontal: spacing.lg,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: insets.top + spacing.base,
      paddingBottom: spacing.base,
    },
    closeButton: {
      padding: spacing.xs,
    },
    micButton: {
      padding: spacing.xs,
    },
    voiceErrorText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginTop: spacing.xs,
      marginBottom: spacing.sm,
    },
    listeningLabel: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.primary,
      marginTop: spacing.xs,
      marginBottom: spacing.sm,
    },
    closeText: {
      fontFamily: fonts.body,
      fontSize: fontSize.xl,
      color: palette.text3,
    },
    animatedContent: {
      flex: 1,
    },
    stepCounter: {
      // Serif display step label. `title` (22) keeps a clear display tier above
      // the old 17 while protecting the instruction viewport on short screens /
      // large Dynamic Type (font scaling stays enabled). Device-confirmable.
      fontFamily: fonts.headingMedium,
      fontSize: fontSize.title,
      lineHeight: fontSize.title * lineHeight.tight,
      color: palette.text2,
      marginBottom: spacing.base,
    },
    calloutRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      marginBottom: spacing.base,
    },
    calloutPill: {
      backgroundColor: palette.pillBg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
      borderRadius: radius.sm,
    },
    calloutText: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.pillText,
    },
    body: {
      flex: 1,
    },
    bodyContent: {
      flexGrow: 1,
      justifyContent: "center",
    },
    instruction: {
      fontFamily: fonts.body,
      fontSize: fontSize.xl,
      color: palette.text1,
      lineHeight: fontSize.xl * lineHeight.relaxed,
      width: "100%",
      maxWidth: 560,
      alignSelf: "center",
      textAlign: "center",
    },
    emptyContent: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    emptyText: {
      fontFamily: fonts.body,
      fontSize: fontSize.md,
      color: palette.text3,
      textAlign: "center",
    },
    utilityRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      // Issue 2: wrap + gap so large Dynamic Type / SE-class widths stack
      // the two utility Buttons instead of colliding.
      flexWrap: "wrap",
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    calloutNotScaled: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.text4,
    },
    sheetContainer: {
      flex: 1,
      backgroundColor: palette.bg,
      paddingHorizontal: spacing.lg,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: spacing.lg,
      paddingBottom: spacing.base,
    },
    sheetTitle: {
      fontFamily: fonts.headingMedium,
      fontSize: fontSize.title,
      color: palette.text1,
    },
    sheetContent: {
      paddingBottom: spacing.xl,
    },
    sheetRow: {
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.divider,
    },
    sheetRowText: {
      fontFamily: fonts.body,
      fontSize: fontSize.md,
      color: palette.text1,
      lineHeight: fontSize.md * lineHeight.relaxed,
    },
    navRow: {
      flexDirection: "row",
      gap: spacing.md,
      paddingVertical: spacing.lg,
    },
    // Equal-width slot so migrated <Button fullWidth /> controls stretch to
    // fill each half of the row (Button's own wrapper does not flex).
    navButtonSlot: {
      flex: 1,
    },
    progressDots: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: spacing.sm,
      paddingBottom: spacing.md,
    },
    dot: {
      borderRadius: 999,
    },
    dotActive: {
      width: 10,
      height: 10,
      backgroundColor: palette.reward,
    },
    dotInactive: {
      width: 6,
      height: 6,
      backgroundColor: palette.text4,
    },
    progressBarTrack: {
      height: 3,
      backgroundColor: palette.elevated,
      borderRadius: 1.5,
      marginBottom: spacing.md,
      overflow: "hidden",
    },
    progressBarFill: {
      height: "100%",
      backgroundColor: palette.reward,
      borderRadius: 1.5,
    },
  });
}
