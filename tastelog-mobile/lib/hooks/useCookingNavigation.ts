/**
 * useCookingNavigation
 *
 * Step navigation state for Cooking Mode. Small and mechanical: owns only
 * the current step index, bounds, and an explicit transition lock.
 *
 * Responsibilities (all):
 * - Track current step index (0-based)
 * - Provide bounds flags (isFirstStep, isLastStep, canGoNext, canGoPrev)
 * - goNext / goPrev with bounds and transition-lock guards
 * - beginTransition / endTransition as explicit lock controls
 *
 * Non-responsibilities:
 * - Animation (screen owns crossfade)
 * - Haptics (screen triggers)
 * - Recipe data (screen passes stepCount)
 * - Routing (screen owns modal)
 * - Progress UI / swipe handling
 *
 * Changing stepCount contract (Issue 3):
 * - stepCount may change while the hook is mounted (a saved-recipe edit
 *   can shrink or grow the cached recipe's steps under a mounted cook
 *   screen). The returned `step` is ALWAYS clamped to the current valid
 *   range synchronously, `step > stepCount - 1` reads as
 *   `max(0, stepCount - 1)` in the same render that delivers the new
 *   count, never one render later. Growth never moves the current step.
 *
 * Safe inert states:
 * - stepCount <= 0: step stays at 0, canGoNext/canGoPrev both false,
 *   goNext/goPrev are no-ops. Screen handles 0-step via its own empty
 *   fallback.
 * - stepCount === 1: step stays at 0, canGoNext/canGoPrev both false.
 *   Screen hides nav controls.
 *
 * Transition lock:
 * - Screen calls beginTransition() at crossfade start, endTransition()
 *   at crossfade completion. While the lock is held, goNext and goPrev
 *   are no-ops. This replaces arbitrary debounce with deterministic
 *   animation-tied gating (locked in Phase 9.A spec).
 */

import { useCallback, useEffect, useState } from "react";

export type UseCookingNavigationResult = {
  step: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  canGoNext: boolean;
  canGoPrev: boolean;
  isTransitioning: boolean;
  goNext: () => void;
  goPrev: () => void;
  beginTransition: () => void;
  endTransition: () => void;
};

export function useCookingNavigation(
  stepCount: number,
): UseCookingNavigationResult {
  const [rawStep, setRawStep] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const lastIndex = Math.max(0, stepCount - 1);

  // Synchronous clamp: the stored index may be stale after a shrink; the
  // exposed step is always within the CURRENT bounds.
  const step = Math.min(rawStep, lastIndex);

  // Persist the shrink clamp into state (Issue 3 second-rescue M1): a
  // step index clamped because the recipe shrank must not resurrect if
  // the recipe later grows again. The read-time clamp above covers the
  // same render that delivers the new count; this effect makes the clamp
  // durable. Growth without a prior shrink never changes rawStep.
  useEffect(() => {
    setRawStep((current) => Math.min(current, lastIndex));
  }, [lastIndex]);

  const isFirstStep = step === 0;
  const isLastStep = step >= lastIndex;
  const canGoNext = stepCount > 0 && step < lastIndex && !isTransitioning;
  const canGoPrev = step > 0 && !isTransitioning;

  const goNext = useCallback(() => {
    if (isTransitioning) return;
    setRawStep((current) => {
      const clamped = Math.min(current, lastIndex);
      return clamped < lastIndex ? clamped + 1 : clamped;
    });
  }, [isTransitioning, lastIndex]);

  const goPrev = useCallback(() => {
    if (isTransitioning) return;
    setRawStep((current) => {
      const clamped = Math.min(current, lastIndex);
      return clamped > 0 ? clamped - 1 : clamped;
    });
  }, [isTransitioning, lastIndex]);

  const beginTransition = useCallback(() => {
    setIsTransitioning(true);
  }, []);

  const endTransition = useCallback(() => {
    setIsTransitioning(false);
  }, []);

  return {
    step,
    isFirstStep,
    isLastStep,
    canGoNext,
    canGoPrev,
    isTransitioning,
    goNext,
    goPrev,
    beginTransition,
    endTransition,
  };
}
