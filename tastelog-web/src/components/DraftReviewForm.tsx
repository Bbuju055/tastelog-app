// src/components/DraftReviewForm.tsx
"use client";

/**
 * Draft review UI (wired to RecipeCard).
 *
 * Critical rule: NEVER autosave edits.
 * - We keep edits in local state only.
 * - Confirm sends edited payload once, explicitly.
 */

import { missingRecipeSections } from "@/lib/extractionReview";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { confirmDraft, getDraft } from "@/lib/api/endpoints";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";
import RecipeCard, { RecipeCardValue } from "@/components/RecipeCard";
import { buildConfirmPatch, clearedFields, draftToCardValue } from "@/lib/drafts/reviewPatch";
import type { DraftConfirmRequest, DraftResponse, RecipeDetailResponse } from "@/lib/api/schemas";

type Props = {
  draftId: string;
};

function draftQueryKey(draftId: string) {
  return ["draft", draftId] as const;
}

/** Props for the ready-state form (draft guaranteed to exist) */
type DraftReadyProps = {
  draft: DraftResponse;
  errorMsg: string | null;
  disabled: boolean;
  onResetEdits: () => void;
  onConfirm: (patch?: DraftConfirmRequest) => void;
  onCancel: () => void;
};

/** Form component that mounts only when draft exists (allows clean state initialization) */
function DraftReviewFormReady({ draft, errorMsg, disabled, onResetEdits, onConfirm, onCancel }: DraftReadyProps) {
  const initialCardValue = useMemo<RecipeCardValue>(() => draftToCardValue(draft), [draft]);

  const [cardValue, setCardValue] = useState<RecipeCardValue>(() => initialCardValue);
  // Confirm cannot clear a field the draft had a value for; refuse rather than silently keep it.
  const [clearedMsg, setClearedMsg] = useState<string | null>(null);
  const shownError = clearedMsg ?? errorMsg;
  const missing = missingRecipeSections(cardValue.ingredients.map((row) => row.text), cardValue.steps.map((row) => row.text));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-neutral-200 p-3 text-sm" aria-live="polite">
        <p>Check ingredients and instructions against the source. Extraction can miss or invent content, even when it looks complete.</p>
        {missing.length > 0 ? <p role="alert">Missing {missing.join(" and ")}. Add these from the source before saving. This draft has not been saved as a recipe.</p> : null}
      </div>
      <RecipeCard
        heading="Review Recipe"
        saveDisabled={missing.length > 0}
        imagePreviewUrl={null}
        value={cardValue}
        onChange={(next) => {
          setCardValue(next);
          setClearedMsg(null);
        }}
        disabled={disabled}
        onCancel={onCancel}
        onResetEdits={() => {
          setCardValue(initialCardValue);
          setClearedMsg(null);
          onResetEdits();
        }}
        onSave={() => {
          if (missing.length > 0) return;
          const cleared = clearedFields(draft, cardValue);
          if (cleared.length > 0) {
            setClearedMsg(`Confirm can't clear ${cleared.join(", ")}. Enter a value or restore the original.`);
            return;
          }
          setClearedMsg(null);
          onConfirm(buildConfirmPatch(draft, cardValue));
        }}
      />

      {shownError ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {shownError}
        </div>
      ) : null}


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
    mutationFn: async (patch?: DraftConfirmRequest) => {
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

  const submitting = confirmMutation.isPending;
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
      onResetEdits={() => {
        setManualErrorMsg(null);

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
