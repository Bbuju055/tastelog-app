"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { RecipeDetailResponse } from "@/lib/api/schemas";
import { getRecipe, deleteRecipe } from "@/lib/api/endpoints";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Scaling
import { RecipeScaleControl } from "@/components/RecipeScaleControl";
import type { FormattedIngredient, Rational } from "@/lib/ingredients";
import { ONE, formatIngredient, scaleIngredient } from "@/lib/ingredients";

type Props = {
  recipeId: string;
};

type NormalizedRecipe = RecipeDetailResponse & { image_key?: string | null };

export default function RecipeDetailView({ recipeId }: Props) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [recipe, setRecipe] = useState<NormalizedRecipe | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [scaleFactor, setScaleFactor] = useState<Rational>(ONE);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setErrorMsg(null);

      try {
        // getRecipe already validates via schema + normalizes image_key internally
        const data = (await getRecipe(recipeId)) as NormalizedRecipe;
        if (!cancelled) setRecipe(data);
      } catch (err) {
        if (!cancelled) {
          setRecipe(null);
          setErrorMsg(apiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  const title = useMemo(() => {
    const t = recipe?.title;
    return typeof t === "string" && t.trim() ? t : "Untitled recipe";
  }, [recipe]);

  const sortedIngredients = useMemo(() => {
    const items = recipe?.ingredients ?? [];
    return [...items].sort((a, b) => a.position - b.position);
  }, [recipe]);

  const scaledIngredients = useMemo(() => {
    return sortedIngredients.map((ing) => {
      const result = scaleIngredient(ing, scaleFactor);
      const formatted = formatIngredient(result, ing, scaleFactor);
      return { ingredient: ing, formatted };
    });
  }, [sortedIngredients, scaleFactor]);

  const sortedSteps = useMemo(() => {
    const items = recipe?.steps ?? [];
    return [...items].sort((a, b) => a.position - b.position);
  }, [recipe]);

  async function onDelete() {
    if (!recipe) return;
    if (deleting) return;

    const ok = window.confirm("Delete this recipe? This cannot be undone.");
    if (!ok) return;

    setDeleting(true);
    setErrorMsg(null);

    try {
      await deleteRecipe(recipe.id);
      router.push("/");
      router.refresh();
    } catch (err) {
      setErrorMsg(apiErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="font-display text-2xl leading-tight tracking-tight">
                {loading ? "Loading…" : title}
              </CardTitle>

              {!loading && recipe ? (
                <div className="text-sm text-neutral-600">
                  Updated{" "}
                  <span className="font-medium text-neutral-700">
                    {new Date(recipe.updated_at).toLocaleString()}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => router.back()}
                disabled={loading || deleting}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={onDelete}
                disabled={loading || deleting || !recipe}
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>

          {errorMsg ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-800">
              {errorMsg}
            </div>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-8">
          {loading ? (
            <div className="space-y-3">
              <div className="h-4 w-2/3 rounded bg-neutral-200" />
              <div className="h-4 w-1/2 rounded bg-neutral-200" />
              <div className="h-4 w-3/4 rounded bg-neutral-200" />
            </div>
          ) : !recipe ? (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-700">
              Recipe not available.
            </div>
          ) : (
            <>
              {/* Scale control */}
              <section className="space-y-3">
                <RecipeScaleControl
                  factor={scaleFactor}
                  onFactorChange={setScaleFactor}
                />
              </section>

              {/* Ingredients */}
              <section className="space-y-3">
                <h2 className="font-display text-lg leading-snug tracking-tight">
                  Ingredients
                </h2>

                {scaledIngredients.length > 0 ? (
                  <ul className="space-y-2 text-[15px] leading-relaxed text-neutral-800">
                    {scaledIngredients.map(({ ingredient, formatted }) => (
                      <li key={ingredient.id} className="flex gap-2">
                        <span className="text-neutral-400">•</span>
                        <span>
                          <IngredientDisplay formatted={formatted} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                    No ingredients provided.
                  </div>
                )}
              </section>

              {/* Steps */}
              <section className="space-y-3">
                <h2 className="font-display text-lg leading-snug tracking-tight">
                  Steps
                </h2>

                {sortedSteps.length > 0 ? (
                  <ol className="space-y-4 text-[15px] leading-relaxed text-neutral-800">
                    {sortedSteps.map((step, idx) => (
                      <li key={step.id} className="flex gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-700">
                          {idx + 1}
                        </span>
                        <span className="pt-0.5">{step.instruction}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                    No steps provided.
                  </div>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function IngredientDisplay({ formatted }: { formatted: FormattedIngredient }) {
  const { main, prep, annotation, showNotScaled } = formatted;

  return (
    <>
      {main}
      {prep && <span className="text-neutral-600">, {prep}</span>}
      {annotation && (
        <span className="ml-1 text-sm text-neutral-500">{annotation}</span>
      )}
      {showNotScaled && (
        <span className="ml-1 rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600">
          not scaled
        </span>
      )}
    </>
  );
}
