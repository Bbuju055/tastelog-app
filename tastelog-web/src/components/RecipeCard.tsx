// src/components/RecipeCard.tsx
"use client";

/**
 * RecipeCard (Draft Review UI)
 *
 * Controlled component:
 * - Parent owns `value`
 * - Card emits `onChange(value)` on edits
 *
 * Critical rule:
 * - This component does NOT persist anything.
 */


// shadcn/ui
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type IngredientLine = {
  id: string;
  text: string;
};

export type StepLine = {
  id: string;
  text: string;
};

export type RecipeCardValue = {
  title: string;
  servings: string; // string to allow partial input
  prep: string;
  cook: string;
  ingredients: IngredientLine[];
  steps: StepLine[];
};

export type RecipeCardProps = {
  heading?: string; // "Review Recipe"
  confidenceLabel?: string; // right-pill label
  imagePreviewUrl?: string | null;

  value: RecipeCardValue;
  onChange: (next: RecipeCardValue) => void;

  onCancel: () => void;
  onResetEdits: () => void;
  onSave: () => void;

  disabled?: boolean;
  saveDisabled?: boolean;
};

function nextId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

export default function RecipeCard({
  heading = "Review Recipe",
  confidenceLabel,
  saveDisabled,
  imagePreviewUrl,
  value,
  onChange,
  onCancel,
  onResetEdits,
  onSave,
  disabled,
}: RecipeCardProps) {
  function setField<K extends keyof RecipeCardValue>(key: K, next: RecipeCardValue[K]) {
    onChange({ ...value, [key]: next });
  }

  function updateIngredient(id: string, text: string) {
    setField(
      "ingredients",
      value.ingredients.map((i) => (i.id === id ? { ...i, text } : i))
    );
  }

  function addIngredient() {
    setField("ingredients", [...value.ingredients, { id: nextId("ing"), text: "" }]);
  }

  function removeIngredient(id: string) {
    setField(
      "ingredients",
      value.ingredients.filter((i) => i.id !== id)
    );
  }

  function updateStep(id: string, text: string) {
    setField(
      "steps",
      value.steps.map((s) => (s.id === id ? { ...s, text } : s))
    );
  }

  function addStep() {
    setField("steps", [...value.steps, { id: nextId("step"), text: "" }]);
  }

  function removeStep(id: string) {
    setField(
      "steps",
      value.steps.filter((s) => s.id !== id)
    );
  }

  return (
    <Card className="page-surface">
      {/* Header */}
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border py-4">
        {/* Micro-pass: apply editorial display font to heading only */}
        <div className="page-title">{heading}</div>

        {confidenceLabel ? (
          <div className="rounded-full border border-neutral-300 bg-background px-2.5 py-1 text-xs text-foreground">
            {confidenceLabel}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground" aria-hidden="true">
            &nbsp;
          </div>
        )}
      </CardHeader>

      {/* Body */}
      <CardContent className="px-5 py-5">
        <div className="space-y-8">
          {imagePreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imagePreviewUrl} alt="Recipe source" className="max-h-64 rounded-lg object-contain" />
          ) : null}
          {/* Main Fields */}
          <div className="space-y-8">
            {/* Title */}
            <div className="grid gap-2">
              <div className="text-sm font-medium text-foreground">Title:</div>
              <Input
                aria-label="Recipe title"
                value={value.title}
                onChange={(e) => setField("title", e.target.value)}
                disabled={disabled}
              />
            </div>

            {/* Meta */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="servings">
                  Servings
                </Label>
                <Input
                  id="servings"
                  inputMode="numeric"
                  value={value.servings}
                  onChange={(e) => setField("servings", e.target.value)}
                  disabled={disabled}
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs" htmlFor="prep">
                  Prep
                </Label>
                <Input
                  id="prep"
                  value={value.prep}
                  onChange={(e) => setField("prep", e.target.value)}
                  disabled={disabled}
                  placeholder="e.g. 10 min"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs" htmlFor="cook">
                  Cook
                </Label>
                <Input
                  id="cook"
                  value={value.cook}
                  onChange={(e) => setField("cook", e.target.value)}
                  disabled={disabled}
                  placeholder="e.g. 25 min"
                />
              </div>
            </div>

            {/* Ingredients */}
            <div className="space-y-3">
              <div className="section-title">Ingredients</div>

              <div className="space-y-2">
                {value.ingredients.length === 0 ? (
                  <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                    No ingredients yet.
                  </div>
                ) : null}

                {value.ingredients.map((ing) => (
                  <div
                    key={ing.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                  >
                    <Input
                      aria-label="Ingredient"
                      value={ing.text}
                      onChange={(e) => updateIngredient(ing.id, e.target.value)}
                      disabled={disabled}
                      placeholder="e.g. 2 cups flour"
                      className="h-12"
                    />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeIngredient(ing.id)}
                      disabled={disabled}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>

              <Button type="button" variant="outline" onClick={addIngredient} disabled={disabled}>
                + Add ingredient
              </Button>
            </div>

            {/* Steps */}
            <div className="space-y-3">
              <div className="section-title">Steps</div>

              <div className="space-y-2">
                {value.steps.length === 0 ? (
                  <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                    No steps yet.
                  </div>
                ) : null}

                {value.steps.map((step, idx) => (
                  <div
                    key={step.id}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3"
                  >
                    <div className="mt-2 w-6 text-right text-xs text-muted-foreground">
                      {idx + 1}.
                    </div>

                    <Input
                      aria-label={`Instruction ${idx + 1}`}
                      value={step.text}
                      onChange={(e) => updateStep(step.id, e.target.value)}
                      disabled={disabled}
                      placeholder="Editable step…"
                      className="h-12"
                    />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => removeStep(step.id)}
                      disabled={disabled}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>

              <Button type="button" variant="outline" onClick={addStep} disabled={disabled}>
                + Add step
              </Button>
            </div>
          </div>
        </div>
      </CardContent>

      {/* Footer */}
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={onResetEdits} disabled={disabled}>
            Reset edits
          </Button>

          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={onSave}
            disabled={disabled || saveDisabled}
          >
            Save recipe
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
