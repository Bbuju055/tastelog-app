// src/components/DraftReviewForm.tsx
"use client";

/**
 * Draft review UI (wired to RecipeCard).
 *
 * Critical rule: NEVER autosave edits.
 * - We keep edits in local state only.
 * - Confirm sends edited payload once, explicitly.
 *
 * We do NOT assume draft contains ingredients/steps until contract is verified.
 * If present at runtime, we surface them; otherwise render empty lists.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { confirmDraft, deleteDraft, getDraft } from "@/lib/api/endpoints";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";
import RecipeCard, {
  RecipeCardValue,
  IngredientLine,
  StepLine,
} from "@/components/RecipeCard";
import type { DraftResponse, RecipeDetailResponse } from "@/lib/api/schemas";

/** Type guard for objects with a text property */
const hasTextProp = (v: unknown): v is { text: string } =>
  typeof v === "object" && v !== null && "text" in v && typeof (v as { text?: unknown }).text === "string";

type Props = {
  draftId: string;
};

function draftQueryKey(draftId: string) {
  return ["draft", draftId] as const;
}

/**
 * Confirm payload shaping:
 * We only send fields we are confident exist / are accepted.
 *
 * For now, only `title` is in the verified draft schema.
 * If/when ingredients/steps are verified in backend contract, we can extend.
 */
function buildConfirmPatch(args: {
  original: Pick<DraftResponse, "title"> | null;
  edited: RecipeCardValue;
}) {
  const patch: Record<string, unknown> = {};

  const originalTitle = typeof args.original?.title === "string" ? args.original.title : "";
  if (args.edited.title !== originalTitle) patch.title = args.edited.title;

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function toLines(value: unknown, prefix: string): { lines: { id: string; text: string }[] } {
  // Accept either string[] or {text:string}[] or already-normalized lines;
  // This is display-only until schemas are verified. No persistence.
  if (Array.isArray(value)) {
    const lines = value
      .map((v, idx) => {
        if (typeof v === "string") return { id: `${prefix}_${idx}`, text: v };
        if (hasTextProp(v)) return { id: `${prefix}_${idx}`, text: v.text };
        return null;
      })
      .filter((x): x is { id: string; text: string } => x !== null);
    return { lines };
  }
  return { lines: [] };
}

/** Props for the ready-state form (draft guaranteed to exist) */
type DraftReadyProps = {
  draft: DraftResponse;
  errorMsg: string | null;
  disabled: boolean;
  onTryAgain: () => void;
  onConfirm: (patch?: Record<string, unknown>) => void;
  onCancel: () => void;
};

/** Form component that mounts only when draft exists (allows clean state initialization) */
function DraftReviewFormReady({ draft, errorMsg, disabled, onTryAgain, onConfirm, onCancel }: DraftReadyProps) {
  const initialCardValue = useMemo<RecipeCardValue>(() => {
    const { lines: ingredients } = toLines(draft.ingredients, "ing");
    const { lines: steps } = toLines(draft.steps, "step");
    return {
      title: draft.title,
      servings: draft.servings ?? "",
      prep: draft.prep_time ?? "",
      cook: draft.cook_time ?? "",
      ingredients: ingredients as IngredientLine[],
      steps: steps as StepLine[],
    };
  }, [draft]);

  const [cardValue, setCardValue] = useState<RecipeCardValue>(() => initialCardValue);

  return (
    <div className="space-y-4">
      <RecipeCard
        heading="Review Recipe"
        confidenceLabel={typeof draft.confidence_score === "number" ? String(draft.confidence_score) : undefined}
        imagePreviewUrl={null}
        value={cardValue}
        onChange={setCardValue}
        disabled={disabled}
        onCancel={onCancel}
        onTryAgain={() => {
          setCardValue(initialCardValue);
          onTryAgain();
        }}
        onLooksGood={() => onConfirm(buildConfirmPatch({ original: draft, edited: cardValue }))}
      />

      {errorMsg ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {errorMsg}
        </div>
      ) : null}

      <div className="rounded-xl border border-neutral-200 bg-white p-3">
        <div className="text-sm font-medium">Raw draft (debug)</div>
        <pre className="mt-2 max-h-[260px] overflow-auto rounded-lg bg-neutral-50 p-3 text-xs text-neutral-700">
          {JSON.stringify(draft, null, 2)}
        </pre>
      </div>

      <div className="text-xs text-neutral-500">
        Confirm sends edits once. No background saves. &quot;Try Again&quot; refetches the draft (no re-parse
        endpoint exists yet).
      </div>
    </div>
  );
}

export default function DraftReviewForm({ draftId }: Props) {
  const router = useRouter();
  const qc = useQueryClient();

  // Manual error state (for mutation errors, cleared on retry)
  const [manualErrorMsg, setManualErrorMsg] = useState<string | null>(null);

  const draftQuery = useQuery<DraftResponse>({
    queryKey: draftQueryKey(draftId),
    queryFn: () => getDraft(draftId),
  });

  const draft = draftQuery.data ?? null;

  // Derive error from query or manual state (query error takes precedence when present)
  const errorMsg = draftQuery.error
    ? apiErrorMessage(draftQuery.error)
    : manualErrorMsg;

  const busy = draftQuery.isLoading || draftQuery.isFetching || false;

  const confirmMutation = useMutation({
    mutationFn: async (patch?: Record<string, unknown>) => {
      if (!draft) throw new Error("Draft not loaded.");
      return confirmDraft(draftId, patch);
    },
    onSuccess: (recipe: RecipeDetailResponse) => {
      const recipeId = recipe.id;
      qc.removeQueries({ queryKey: draftQueryKey(draftId) });
      router.replace(`/recipes/${encodeURIComponent(recipeId)}`);
      router.refresh();
    },
    onError: (err) => setManualErrorMsg(apiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDraft(draftId),
    onSuccess: () => {
      qc.removeQueries({ queryKey: draftQueryKey(draftId) });
      router.replace("/");
      router.refresh();
    },
    onError: (err) => setManualErrorMsg(apiErrorMessage(err)),
  });

  const submitting = confirmMutation.isPending || deleteMutation.isPending;
  const disabled = busy || submitting;

  if (draftQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        <div className="text-sm text-neutral-700" aria-live="polite">
          Loading draft…
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        <div className="text-sm text-neutral-700">Draft not available.</div>
        {errorMsg ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMsg}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <DraftReviewFormReady
      key={draft.id}
      draft={draft}
      errorMsg={errorMsg}
      disabled={disabled}
      onTryAgain={() => {
        setManualErrorMsg(null);
        draftQuery.refetch();
      }}
      onConfirm={(patch) => {
        setManualErrorMsg(null);
        confirmMutation.mutate(patch);
      }}
      onCancel={() => {
        router.replace("/");
        router.refresh();
      }}
    />
  );
}
