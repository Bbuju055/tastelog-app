import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  ErrorState,
  LoadingState,
  Screen,
} from "../../../../components";
import { useRecipe } from "../../../../lib/hooks/useRecipe";
// Deep import (useNavigationGuard precedent): screen suites mock the
// lib/hooks barrel as object literals; the transport hook must stay real.
import { useUpdateRecipe } from "../../../../lib/hooks/useUpdateRecipe";
import { isApiError } from "../../../../lib/errors";
import {
  RECENT_COOKS_QUERY_KEY,
  RECIPES_QUERY_KEY,
  cookEventsQueryKey,
  recipeDetailQueryKey,
} from "../../../../lib/queryKeys";
import { hapticSuccess, hapticTap, hapticWarning } from "../../../../lib/haptics/haptics";
import type {
  RecipeContentUpdateRequest,
  RecipeDetailResponse,
} from "../../../../lib/api/schemas";
import { fonts, fontSize, lineHeight, radius, spacing } from "../../../../theme";
import type { ThemePalette } from "../../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../../theme/ThemeProvider";

/**
 * Recipe Edit screen (Issue 3, saved-recipe editing).
 *
 * Explicit-operation editor: rows carry stable ids and per-field dirty
 * tracking against the SEEDED values; buildOps emits exactly the
 * intentional operations of the plan section 6.1 wire contract. A row the
 * user never touched appears in NO update op, sibling edits and reorders
 * can never dirty it, so untouched legacy raw_text rows stay byte-
 * identical on the server (dirtiness = operation-existence, section 7.5).
 *
 * Save lifecycle ownership (section 7.2): the transport hook is pure; this
 * screen owns success/failure handling under latest-operation GENERATION
 * ownership, each Save/Reload increments a generation and a completion
 * applies only while its generation is current. Cache writes are
 * revision-safe (an older response.content_rev never overwrites a newer
 * cached revision). No grocery cache is ever touched (section 4.6).
 */

// Local UUID v4 (same self-contained pattern as lib/api/capture.ts).
function uuidv4(): string {
  const cryptoAny = (globalThis as { crypto?: unknown }).crypto as
    | { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array }
    | undefined;
  if (cryptoAny?.randomUUID) return cryptoAny.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoAny?.getRandomValues) {
    cryptoAny.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

const CONFLICT_MESSAGE =
  "This recipe changed since you opened it. Reload the latest version before saving.";
const DELETED_MESSAGE =
  "This recipe was deleted and can no longer be edited.";

/**
 * Defense-in-depth generation ownership predicate (plan section 7.2).
 *
 * The REACHABLE serialization invariant is enforced elsewhere: formLocked
 * prevents a second Save/Reload from starting while one is pending, and a
 * TanStack mutation settles exactly once, so no transport-legal sequence
 * delivers a completion after its operation was superseded. This
 * predicate is the DEFENSE-IN-DEPTH layer behind that invariant: every
 * completion handler still refuses to apply unless its generation is the
 * screen's current one, so superseded async work can never write caches,
 * navigate, or buzz even if the serialization assumption were ever
 * violated. Exported for direct unit coverage.
 */
export function completionIsCurrent(
  generation: number,
  currentGeneration: number,
): boolean {
  return generation === currentGeneration;
}

type IngredientRowState = {
  key: string;
  existingId: string | null;
  tempId: string | null;
  name: string;
  quantity: string;
  unit: string;
  prep: string;
  seeded: {
    name: string;
    quantity: string | null;
    unit: string | null;
    prep: string | null;
  } | null;
};

type StepRowState = {
  key: string;
  existingId: string | null;
  tempId: string | null;
  instruction: string;
  seeded: { instruction: string } | null;
};

type ScalarSeeds = {
  title: string;
  servings: string | null;
  prep_time: string | null;
  cook_time: string | null;
};

type OpsBuild = {
  isNoop: boolean;
  request: Omit<RecipeContentUpdateRequest, "expected_content_rev" | "mutation_id">;
};

/** "" and whitespace-only inputs are an intentional clear (null). */
function normalizeOptional(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Stored values may carry noncanonical whitespace (legacy captures).
 * Dirtiness compares BOTH sides on the same normalization, so an
 * untouched field can never become an operation just because its stored
 * bytes were noncanonical (plan 7.5: opening an untouched recipe of ANY
 * vintage produces zero operations).
 */
function normalizeSeeded(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function seedIngredientRows(recipe: RecipeDetailResponse): IngredientRowState[] {
  return [...recipe.ingredients]
    .sort((a, b) => a.position - b.position)
    .map((ing) => ({
      key: ing.id,
      existingId: ing.id,
      tempId: null,
      name: ing.name,
      quantity: ing.quantity ?? "",
      unit: ing.unit ?? "",
      prep: ing.prep ?? "",
      seeded: {
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
        prep: ing.prep,
      },
    }));
}

function seedStepRows(recipe: RecipeDetailResponse): StepRowState[] {
  return [...recipe.steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => ({
      key: step.id,
      existingId: step.id,
      tempId: null,
      instruction: step.instruction,
      seeded: { instruction: step.instruction },
    }));
}

export default function RecipeEditScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);

  const { id } = useLocalSearchParams<{ id?: string }>();
  const recipeId = typeof id === "string" ? id : undefined;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: recipe, error, isLoading, refetch } = useRecipe(recipeId);
  const updateMutation = useUpdateRecipe();

  // ---- Form state (seeded once; Reload Latest reseeds explicitly) ----
  const [seededRev, setSeededRev] = useState<number | null>(null);
  const [scalarSeeds, setScalarSeeds] = useState<ScalarSeeds | null>(null);
  const [title, setTitle] = useState("");
  const [servings, setServings] = useState("");
  const [prepTime, setPrepTime] = useState("");
  const [cookTime, setCookTime] = useState("");
  const [ingredientRows, setIngredientRows] = useState<IngredientRowState[]>([]);
  const [stepRows, setStepRows] = useState<StepRowState[]>([]);
  const [deletedIngredientIds, setDeletedIngredientIds] = useState<string[]>([]);
  const [deletedStepIds, setDeletedStepIds] = useState<string[]>([]);
  const [baselineIngredientOrder, setBaselineIngredientOrder] = useState<string[]>([]);
  const [baselineStepOrder, setBaselineStepOrder] = useState<string[]>([]);

  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  // Form lock (rescue H3/M3): saving AND reloading both freeze every
  // control and input, so a reload completion can never overwrite
  // keystrokes made while it was in flight.
  const formLocked = isSaving || isReloading;
  const [inlineError, setInlineError] = useState<string | null>(null);

  // mutation_id lifecycle (plan section 6.2): generated per Save
  // activation, reused verbatim for retries of that SAME save, regenerated
  // whenever the form content changes.
  const mutationIdRef = useRef<string | null>(null);
  // Latest-operation generation ownership (plan section 7.2): a completion
  // applies only while its generation is current.
  const generationRef = useRef(0);

  const seedForm = (data: RecipeDetailResponse) => {
    setSeededRev(data.content_rev ?? null);
    setScalarSeeds({
      title: data.title,
      servings: data.servings,
      prep_time: data.prep_time,
      cook_time: data.cook_time,
    });
    setTitle(data.title);
    setServings(data.servings ?? "");
    setPrepTime(data.prep_time ?? "");
    setCookTime(data.cook_time ?? "");
    const ingredients = seedIngredientRows(data);
    const steps = seedStepRows(data);
    setIngredientRows(ingredients);
    setStepRows(steps);
    setDeletedIngredientIds([]);
    setDeletedStepIds([]);
    setBaselineIngredientOrder(ingredients.map((row) => row.key));
    setBaselineStepOrder(steps.map((row) => row.key));
    mutationIdRef.current = null;
  };

  // Seed exactly once from the first loaded data; background refetches
  // must never clobber an in-progress form (Reload Latest is the only
  // explicit reseed path).
  useEffect(() => {
    if (recipe && scalarSeeds === null && recipe.content_rev != null) {
      seedForm(recipe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, scalarSeeds]);

  const touchForm = () => {
    mutationIdRef.current = null;
  };

  // ---- Ops construction (plan section 6.1: intentional operations only) ----

  const buildOps = (): OpsBuild => {
    const request: OpsBuild["request"] = {};
    if (scalarSeeds) {
      const fields: NonNullable<RecipeContentUpdateRequest["fields"]> = {};
      const trimmedTitle = title.trim();
      if (trimmedTitle !== "" && trimmedTitle !== scalarSeeds.title.trim()) {
        fields.title = trimmedTitle;
      }
      const scalarPairs = [
        ["servings", servings, scalarSeeds.servings],
        ["prep_time", prepTime, scalarSeeds.prep_time],
        ["cook_time", cookTime, scalarSeeds.cook_time],
      ] as const;
      for (const [fieldName, input, seeded] of scalarPairs) {
        const normalized = normalizeOptional(input);
        if (normalized !== normalizeSeeded(seeded)) {
          fields[fieldName] = normalized;
        }
      }
      if (Object.keys(fields).length > 0) request.fields = fields;
    }

    // Ingredients. All-blank new rows are dropped, never transmitted.
    const survivingIngredients = ingredientRows.filter(
      (row) =>
        row.existingId !== null ||
        row.name.trim() !== "" ||
        row.quantity.trim() !== "" ||
        row.unit.trim() !== "" ||
        row.prep.trim() !== "",
    );
    const ingredientUpdates: NonNullable<
      NonNullable<RecipeContentUpdateRequest["ingredients"]>["update"]
    > = [];
    for (const row of survivingIngredients) {
      if (row.existingId === null || row.seeded === null) continue;
      const fields: Record<string, string | null> = {};
      const trimmedName = row.name.trim();
      if (trimmedName !== "" && trimmedName !== row.seeded.name.trim()) {
        fields.name = trimmedName;
      }
      const optionalPairs = [
        ["quantity", row.quantity, row.seeded.quantity],
        ["unit", row.unit, row.seeded.unit],
        ["prep", row.prep, row.seeded.prep],
      ] as const;
      for (const [fieldName, input, seeded] of optionalPairs) {
        const normalized = normalizeOptional(input);
        if (normalized !== normalizeSeeded(seeded)) {
          fields[fieldName] = normalized;
        }
      }
      if (Object.keys(fields).length > 0) {
        ingredientUpdates.push({ id: row.existingId, fields });
      }
    }
    const ingredientCreates = survivingIngredients
      .filter((row) => row.existingId === null && row.name.trim() !== "")
      .map((row) => ({
        temp_id: row.tempId as string,
        name: row.name.trim(),
        quantity: normalizeOptional(row.quantity),
        unit: normalizeOptional(row.unit),
        prep: normalizeOptional(row.prep),
      }));
    const finalIngredientOrder = survivingIngredients
      .filter((row) => row.existingId !== null || row.name.trim() !== "")
      .map((row) => (row.existingId ?? row.tempId) as string);
    const survivingBaselineIngredientOrder = baselineIngredientOrder.filter(
      (rowId) => !deletedIngredientIds.includes(rowId),
    );
    const ingredientMembershipChanged =
      ingredientCreates.length > 0 || deletedIngredientIds.length > 0;
    const ingredientReordered =
      finalIngredientOrder.join("\n") !==
      survivingBaselineIngredientOrder.join("\n");
    const ingredientSection: NonNullable<
      RecipeContentUpdateRequest["ingredients"]
    > = {};
    if (ingredientUpdates.length > 0) ingredientSection.update = ingredientUpdates;
    if (ingredientCreates.length > 0) ingredientSection.create = ingredientCreates;
    if (deletedIngredientIds.length > 0) {
      ingredientSection.delete = deletedIngredientIds;
    }
    if (ingredientMembershipChanged || ingredientReordered) {
      ingredientSection.order = finalIngredientOrder;
    }
    if (Object.keys(ingredientSection).length > 0) {
      request.ingredients = ingredientSection;
    }

    // Steps.
    const survivingSteps = stepRows.filter(
      (row) => row.existingId !== null || row.instruction.trim() !== "",
    );
    const stepUpdates: NonNullable<
      NonNullable<RecipeContentUpdateRequest["steps"]>["update"]
    > = [];
    for (const row of survivingSteps) {
      if (row.existingId === null || row.seeded === null) continue;
      const trimmed = row.instruction.trim();
      if (trimmed !== "" && trimmed !== row.seeded.instruction.trim()) {
        stepUpdates.push({ id: row.existingId, fields: { instruction: trimmed } });
      }
    }
    const stepCreates = survivingSteps
      .filter((row) => row.existingId === null)
      .map((row) => ({
        temp_id: row.tempId as string,
        instruction: row.instruction.trim(),
      }));
    const finalStepOrder = survivingSteps.map(
      (row) => (row.existingId ?? row.tempId) as string,
    );
    const survivingBaselineStepOrder = baselineStepOrder.filter(
      (rowId) => !deletedStepIds.includes(rowId),
    );
    const stepMembershipChanged =
      stepCreates.length > 0 || deletedStepIds.length > 0;
    const stepReordered =
      finalStepOrder.join("\n") !== survivingBaselineStepOrder.join("\n");
    const stepSection: NonNullable<RecipeContentUpdateRequest["steps"]> = {};
    if (stepUpdates.length > 0) stepSection.update = stepUpdates;
    if (stepCreates.length > 0) stepSection.create = stepCreates;
    if (deletedStepIds.length > 0) stepSection.delete = deletedStepIds;
    if (stepMembershipChanged || stepReordered) {
      stepSection.order = finalStepOrder;
    }
    if (Object.keys(stepSection).length > 0) request.steps = stepSection;

    const isNoop =
      request.fields === undefined &&
      request.ingredients === undefined &&
      request.steps === undefined;
    return { isNoop, request };
  };

  // ---- Validation (Save disabled while invalid, plan section 4.4) ----

  const titleValid = title.trim() !== "";
  const ingredientsValid = ingredientRows.every((row) => {
    if (row.existingId !== null) return row.name.trim() !== "";
    // New rows: all-blank is legal (dropped); content without a name is not.
    const hasContent =
      row.quantity.trim() !== "" || row.unit.trim() !== "" || row.prep.trim() !== "";
    return row.name.trim() !== "" || !hasContent;
  });
  const stepsValid = stepRows.every(
    (row) => row.existingId === null || row.instruction.trim() !== "",
  );
  const formValid = titleValid && ingredientsValid && stepsValid;

  // ---- Outcome handlers (screen-owned, generation-guarded) ----

  const purgeAndReturnToRecipes = () => {
    if (recipeId) {
      queryClient.removeQueries({ queryKey: recipeDetailQueryKey(recipeId) });
      queryClient.removeQueries({ queryKey: cookEventsQueryKey(recipeId) });
    }
    void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: RECENT_COOKS_QUERY_KEY });
    router.navigate("/(app)/(tabs)");
  };

  const showDeletedAlert = () => {
    Alert.alert("Recipe Deleted", DELETED_MESSAGE, [
      { text: "Back to Recipes", onPress: purgeAndReturnToRecipes },
    ]);
  };

  const handleReloadLatest = () => {
    if (isSaving || isReloading) return;
    const generation = ++generationRef.current;
    setIsReloading(true);
    setInlineError(null);
    refetch().then((result) => {
      if (!completionIsCurrent(generation, generationRef.current)) return;
      setIsReloading(false);
      if (result.data && result.data.content_rev != null) {
        seedForm(result.data);
        return;
      }
      if (result.error && isApiError(result.error) && result.error.status === 404) {
        showDeletedAlert();
        return;
      }
      setInlineError("Couldn’t reload the recipe. Check your connection and try again.");
    });
  };

  const showConflictAlert = () => {
    Alert.alert("Recipe Changed", CONFLICT_MESSAGE, [
      { text: "Keep Editing", style: "cancel" },
      { text: "Reload Latest", onPress: handleReloadLatest },
    ]);
  };

  const handleSave = () => {
    if (!recipeId || formLocked || !formValid || seededRev == null) {
      return;
    }
    const { isNoop, request } = buildOps();
    if (isNoop) {
      // Pristine save: dismiss without network.
      router.back();
      return;
    }
    const generation = ++generationRef.current;
    if (mutationIdRef.current === null) {
      mutationIdRef.current = uuidv4();
    }
    const mutationId = mutationIdRef.current;
    setIsSaving(true);
    setInlineError(null);
    updateMutation.mutate(
      {
        recipeId,
        body: {
          expected_content_rev: seededRev,
          mutation_id: mutationId,
          ...request,
        },
      },
      {
        onSuccess: (response) => {
          if (!completionIsCurrent(generation, generationRef.current)) return;
          setIsSaving(false);
          hapticSuccess();
          // Revision-safe cache write: an older response can never
          // overwrite a newer cached revision (missing cached rev =
          // legacy entry, write allowed). No grocery invalidation ever.
          const cached = queryClient.getQueryData<RecipeDetailResponse>(
            recipeDetailQueryKey(recipeId),
          );
          const cachedRev = cached?.content_rev;
          if (
            cachedRev == null ||
            (response.content_rev != null && response.content_rev >= cachedRev)
          ) {
            queryClient.setQueryData(recipeDetailQueryKey(recipeId), response);
          }
          void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
          void queryClient.invalidateQueries({
            queryKey: RECENT_COOKS_QUERY_KEY,
          });
          router.back();
        },
        onError: (saveError) => {
          if (!completionIsCurrent(generation, generationRef.current)) return;
          setIsSaving(false);
          hapticWarning();
          if (isApiError(saveError) && saveError.status === 409) {
            showConflictAlert();
            return;
          }
          if (isApiError(saveError) && saveError.status === 404) {
            showDeletedAlert();
            return;
          }
          if (isApiError(saveError) && saveError.status === 401) {
            setInlineError("Your session has expired. Sign in again to save.");
            return;
          }
          if (
            isApiError(saveError) &&
            (saveError.kind === "network" || saveError.kind === "timeout")
          ) {
            // Manual retry of the SAME save is idempotent: mutationIdRef
            // is preserved until the form content changes.
            setInlineError(
              "Couldn’t save your changes. Check your connection and try again.",
            );
            return;
          }
          setInlineError("Couldn’t save your changes. Try again in a moment.");
        },
      },
    );
  };

  const handleCancel = () => {
    if (formLocked) return;
    const { isNoop } = buildOps();
    if (isNoop) {
      router.back();
      return;
    }
    Alert.alert("Discard Changes?", undefined, [
      { text: "Keep Editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => router.back() },
    ]);
  };

  // ---- Row mutation helpers (every one invalidates the mutation id) ----

  const setIngredientField = (
    key: string,
    fieldName: "name" | "quantity" | "unit" | "prep",
    value: string,
  ) => {
    if (formLocked) return;
    touchForm();
    setIngredientRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, [fieldName]: value } : row)),
    );
  };

  const setStepInstruction = (key: string, value: string) => {
    if (formLocked) return;
    touchForm();
    setStepRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, instruction: value } : row)),
    );
  };

  const addIngredientRow = () => {
    if (formLocked) return;
    hapticTap();
    touchForm();
    const tempId = uuidv4();
    setIngredientRows((rows) => [
      ...rows,
      {
        key: tempId,
        existingId: null,
        tempId,
        name: "",
        quantity: "",
        unit: "",
        prep: "",
        seeded: null,
      },
    ]);
  };

  const addStepRow = () => {
    if (formLocked) return;
    hapticTap();
    touchForm();
    const tempId = uuidv4();
    setStepRows((rows) => [
      ...rows,
      { key: tempId, existingId: null, tempId, instruction: "", seeded: null },
    ]);
  };

  const removeIngredientRow = (key: string) => {
    if (formLocked) return;
    hapticTap();
    touchForm();
    setIngredientRows((rows) => {
      const target = rows.find((row) => row.key === key);
      if (target?.existingId) {
        setDeletedIngredientIds((ids) => [...ids, target.existingId as string]);
      }
      return rows.filter((row) => row.key !== key);
    });
  };

  const removeStepRow = (key: string) => {
    if (formLocked) return;
    hapticTap();
    touchForm();
    setStepRows((rows) => {
      const target = rows.find((row) => row.key === key);
      if (target?.existingId) {
        setDeletedStepIds((ids) => [...ids, target.existingId as string]);
      }
      return rows.filter((row) => row.key !== key);
    });
  };

  // Fail-closed reorder primitive (second-rescue M2): the disabled prop
  // and accessibilityState are presentation; the HANDLER is the safety
  // boundary. An out-of-range source or destination (e.g. a direct
  // assistive activation of "move first row up") is a complete no-op,
  // never a negative-index splice.
  const moveRow = <T,>(rows: T[], index: number, delta: -1 | 1): T[] => {
    const target = index + delta;
    if (
      index < 0 ||
      index >= rows.length ||
      target < 0 ||
      target >= rows.length
    ) {
      return rows;
    }
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
  };

  const moveIsInBounds = (length: number, index: number, delta: -1 | 1) => {
    const target = index + delta;
    return index >= 0 && index < length && target >= 0 && target < length;
  };

  const moveIngredient = (index: number, delta: -1 | 1) => {
    if (formLocked) return;
    if (!moveIsInBounds(ingredientRows.length, index, delta)) return;
    hapticTap();
    touchForm();
    setIngredientRows((rows) => moveRow(rows, index, delta));
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    if (formLocked) return;
    if (!moveIsInBounds(stepRows.length, index, delta)) return;
    hapticTap();
    touchForm();
    setStepRows((rows) => moveRow(rows, index, delta));
  };

  // ---- Render ----

  if (!recipeId) {
    return (
      <Screen style={s.centered}>
        <Text style={s.errorText}>Invalid recipe ID.</Text>
      </Screen>
    );
  }

  if (error && isApiError(error) && error.status === 404 && scalarSeeds === null) {
    return (
      <Screen style={s.centered}>
        <Text style={s.deletedTitle}>Recipe Deleted</Text>
        <Text style={s.deletedBody}>{DELETED_MESSAGE}</Text>
        <View style={s.deletedAction}>
          <Button title="Back to Recipes" onPress={purgeAndReturnToRecipes} />
        </View>
      </Screen>
    );
  }

  if (isLoading && scalarSeeds === null) {
    return (
      <Screen style={s.centered}>
        <LoadingState message="Loading recipe…" />
      </Screen>
    );
  }

  if (scalarSeeds === null) {
    return (
      <Screen style={s.centered}>
        <ErrorState
          message={error?.message ?? "Failed to load recipe."}
          onRetry={refetch}
        />
      </Screen>
    );
  }

  const saveDisabled = formLocked || !formValid;

  return (
    <Screen style={s.container}>
      {/* In-screen header: Cancel / Edit Recipe / Save (44pt controls). */}
      <View style={s.header}>
        <Pressable
          onPress={handleCancel}
          disabled={formLocked}
          accessibilityRole="button"
          accessibilityLabel="Cancel editing"
          accessibilityState={{ disabled: formLocked }}
          style={s.headerControl}
        >
          <Text style={[s.headerControlText, formLocked && s.headerControlDisabled]}>
            Cancel
          </Text>
        </Pressable>
        <Text style={s.headerTitle}>Edit Recipe</Text>
        <Pressable
          onPress={handleSave}
          disabled={saveDisabled}
          accessibilityRole="button"
          accessibilityLabel={isSaving ? "Saving recipe" : "Save recipe"}
          accessibilityState={{ disabled: saveDisabled }}
          style={s.headerControl}
        >
          <Text
            style={[
              s.headerControlText,
              s.headerSaveText,
              saveDisabled && s.headerControlDisabled,
            ]}
          >
            {isSaving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>

      {inlineError !== null && (
        <Text style={s.inlineError} accessibilityLiveRegion="polite">
          {inlineError}
        </Text>
      )}

      <ScrollView
        contentContainerStyle={s.scrollContent}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={true}
        showsVerticalScrollIndicator={false}
      >
        {/* Recipe scalar fields */}
        <Text style={s.fieldLabel}>Title</Text>
        <TextInput
          style={s.input}
          value={title}
          onChangeText={(value) => {
            if (formLocked) return;
            touchForm();
            setTitle(value);
          }}
          editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
          placeholder="Recipe title"
          placeholderTextColor={palette.text4}
          keyboardAppearance={theme === "dark" ? "dark" : "light"}
          accessibilityLabel="Recipe title"
        />
        <View style={s.metaRow}>
          <View style={s.metaField}>
            <Text style={s.fieldLabel}>Servings</Text>
            <TextInput
              style={s.input}
              value={servings}
              onChangeText={(value) => {
                if (formLocked) return;
                touchForm();
                setServings(value);
              }}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="e.g. 4"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              accessibilityLabel="Servings"
            />
          </View>
          <View style={s.metaField}>
            <Text style={s.fieldLabel}>Prep time</Text>
            <TextInput
              style={s.input}
              value={prepTime}
              onChangeText={(value) => {
                if (formLocked) return;
                touchForm();
                setPrepTime(value);
              }}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="e.g. 10 min"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              accessibilityLabel="Prep time"
            />
          </View>
          <View style={s.metaField}>
            <Text style={s.fieldLabel}>Cook time</Text>
            <TextInput
              style={s.input}
              value={cookTime}
              onChangeText={(value) => {
                if (formLocked) return;
                touchForm();
                setCookTime(value);
              }}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="e.g. 30 min"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              accessibilityLabel="Cook time"
            />
          </View>
        </View>

        {/* Ingredients */}
        <Text style={s.sectionTitle}>Ingredients</Text>
        {ingredientRows.map((row, index) => (
          <View key={row.key} style={s.rowCard} testID={`ingredient-row-${index}`}>
            <View style={s.rowFieldsRow}>
              <TextInput
                style={[s.input, s.inputQuantity]}
                value={row.quantity}
                onChangeText={(value) => setIngredientField(row.key, "quantity", value)}
                editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
                placeholder="Qty"
                placeholderTextColor={palette.text4}
                keyboardAppearance={theme === "dark" ? "dark" : "light"}
                accessibilityLabel={`Ingredient ${index + 1} quantity`}
              />
              <TextInput
                style={[s.input, s.inputUnit]}
                value={row.unit}
                onChangeText={(value) => setIngredientField(row.key, "unit", value)}
                editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
                placeholder="Unit"
                placeholderTextColor={palette.text4}
                keyboardAppearance={theme === "dark" ? "dark" : "light"}
                accessibilityLabel={`Ingredient ${index + 1} unit`}
              />
            </View>
            <TextInput
              style={s.input}
              value={row.name}
              onChangeText={(value) => setIngredientField(row.key, "name", value)}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="Ingredient"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              accessibilityLabel={`Ingredient ${index + 1} name`}
            />
            <TextInput
              style={s.input}
              value={row.prep}
              onChangeText={(value) => setIngredientField(row.key, "prep", value)}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="Preparation (optional)"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              accessibilityLabel={`Ingredient ${index + 1} preparation`}
            />
            <View style={s.rowControls}>
              <Pressable
                onPress={() => moveIngredient(index, -1)}
                disabled={formLocked || index === 0}
                accessibilityRole="button"
                accessibilityLabel={`Move ingredient ${index + 1} up`}
                accessibilityState={{ disabled: formLocked || index === 0 }}
                style={s.rowControl}
              >
                <Text
                  style={[
                    s.rowControlText,
                    (formLocked || index === 0) && s.rowControlDisabled,
                  ]}
                >
                  {"↑"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => moveIngredient(index, 1)}
                disabled={formLocked || index === ingredientRows.length - 1}
                accessibilityRole="button"
                accessibilityLabel={`Move ingredient ${index + 1} down`}
                accessibilityState={{
                  disabled: formLocked || index === ingredientRows.length - 1,
                }}
                style={s.rowControl}
              >
                <Text
                  style={[
                    s.rowControlText,
                    (formLocked || index === ingredientRows.length - 1) &&
                      s.rowControlDisabled,
                  ]}
                >
                  {"↓"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => removeIngredientRow(row.key)}
                disabled={formLocked}
                accessibilityRole="button"
                accessibilityLabel={`Remove ingredient ${index + 1}`}
                accessibilityState={{ disabled: formLocked }}
                style={[s.rowControl, s.rowControlRemove]}
              >
                <Text style={[s.rowControlText, formLocked && s.rowControlDisabled]}>
                  Remove
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Pressable
          onPress={addIngredientRow}
          disabled={formLocked}
          accessibilityRole="button"
          accessibilityLabel="Add ingredient"
          accessibilityState={{ disabled: formLocked }}
          style={s.addRowButton}
        >
          <Text style={[s.addRowText, formLocked && s.rowControlDisabled]}>
            + Add Ingredient
          </Text>
        </Pressable>

        {/* Steps */}
        <Text style={s.sectionTitle}>Steps</Text>
        {stepRows.map((row, index) => (
          <View key={row.key} style={s.rowCard} testID={`step-row-${index}`}>
            <Text style={s.stepLabel}>Step {index + 1}</Text>
            <TextInput
              style={[s.input, s.inputMultiline]}
              value={row.instruction}
              onChangeText={(value) => setStepInstruction(row.key, value)}
              editable={!formLocked}
              accessibilityState={{ disabled: formLocked }}
              placeholder="Instruction"
              placeholderTextColor={palette.text4}
              keyboardAppearance={theme === "dark" ? "dark" : "light"}
              multiline
              accessibilityLabel={`Step ${index + 1} instruction`}
            />
            <View style={s.rowControls}>
              <Pressable
                onPress={() => moveStep(index, -1)}
                disabled={formLocked || index === 0}
                accessibilityRole="button"
                accessibilityLabel={`Move step ${index + 1} up`}
                accessibilityState={{ disabled: formLocked || index === 0 }}
                style={s.rowControl}
              >
                <Text
                  style={[
                    s.rowControlText,
                    (formLocked || index === 0) && s.rowControlDisabled,
                  ]}
                >
                  {"↑"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => moveStep(index, 1)}
                disabled={formLocked || index === stepRows.length - 1}
                accessibilityRole="button"
                accessibilityLabel={`Move step ${index + 1} down`}
                accessibilityState={{
                  disabled: formLocked || index === stepRows.length - 1,
                }}
                style={s.rowControl}
              >
                <Text
                  style={[
                    s.rowControlText,
                    (formLocked || index === stepRows.length - 1) &&
                      s.rowControlDisabled,
                  ]}
                >
                  {"↓"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => removeStepRow(row.key)}
                disabled={formLocked}
                accessibilityRole="button"
                accessibilityLabel={`Remove step ${index + 1}`}
                accessibilityState={{ disabled: formLocked }}
                style={[s.rowControl, s.rowControlRemove]}
              >
                <Text style={[s.rowControlText, formLocked && s.rowControlDisabled]}>
                  Remove
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Pressable
          onPress={addStepRow}
          disabled={formLocked}
          accessibilityRole="button"
          accessibilityLabel="Add step"
          accessibilityState={{ disabled: formLocked }}
          style={s.addRowButton}
        >
          <Text style={[s.addRowText, formLocked && s.rowControlDisabled]}>
            + Add Step
          </Text>
        </Pressable>
      </ScrollView>
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
    container: {
      flex: 1,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
    },
    headerControl: {
      // Real interaction geometry (ruling 11): actual 44pt minimum frame,
      // hitSlop is never the mechanism.
      minWidth: 44,
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.sm,
    },
    headerControlText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.md,
      color: palette.text2,
    },
    headerSaveText: {
      fontFamily: fonts.bodySemiBold,
      color: palette.primary,
    },
    headerControlDisabled: {
      opacity: 0.4,
    },
    headerTitle: {
      fontFamily: fonts.headingSemiBold,
      fontSize: fontSize.lg,
      color: palette.text1,
    },
    inlineError: {
      fontFamily: fonts.body,
      fontSize: fontSize.sm,
      color: palette.error,
      marginBottom: spacing.sm,
    },
    scrollContent: {
      paddingBottom: spacing.xxxl,
    },
    fieldLabel: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginBottom: spacing.xs,
      marginTop: spacing.sm,
    },
    input: {
      backgroundColor: palette.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.base,
      fontFamily: fonts.body,
      color: palette.text1,
      minHeight: 44,
      marginBottom: spacing.sm,
    },
    inputMultiline: {
      minHeight: 66,
      textAlignVertical: "top",
      lineHeight: fontSize.base * lineHeight.normal,
    },
    inputQuantity: {
      flex: 1,
    },
    inputUnit: {
      flex: 1,
    },
    metaRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    metaField: {
      flex: 1,
    },
    sectionTitle: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginTop: spacing.lg,
      marginBottom: spacing.sm,
      letterSpacing: -0.2,
    },
    rowCard: {
      backgroundColor: palette.surface,
      borderRadius: radius.card,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    rowFieldsRow: {
      flexDirection: "row",
      gap: spacing.sm,
    },
    stepLabel: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.sm,
      color: palette.text3,
      marginBottom: spacing.xs,
    },
    rowControls: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    rowControl: {
      minWidth: 44,
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: radius.md,
      backgroundColor: palette.card,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: spacing.md,
    },
    rowControlRemove: {
      marginLeft: "auto",
    },
    rowControlText: {
      fontFamily: fonts.bodyMedium,
      fontSize: fontSize.base,
      color: palette.text2,
    },
    rowControlDisabled: {
      opacity: 0.4,
    },
    addRowButton: {
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: palette.border,
      marginBottom: spacing.sm,
    },
    addRowText: {
      fontFamily: fonts.bodySemiBold,
      fontSize: fontSize.base,
      color: palette.primary,
    },
  });
}
