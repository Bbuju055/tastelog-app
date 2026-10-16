"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Rational } from "@/lib/ingredients";
import { parseQuantity, cmp, HALF, ONE, TWO } from "@/lib/ingredients";

type Props = {
  factor: Rational;
  onFactorChange: (factor: Rational) => void;
};

type Preset = {
  label: string;
  value: Rational;
};

const PRESETS: Preset[] = [
  { label: "0.5×", value: HALF },
  { label: "1×", value: ONE },
  { label: "2×", value: TWO },
];

export function RecipeScaleControl({ factor, onFactorChange }: Props) {
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  const isActivePreset = useCallback(
    (preset: Rational) => cmp(factor, preset) === 0,
    [factor]
  );

  const handlePresetClick = useCallback(
    (preset: Rational) => {
      setCustomInput("");
      setCustomError(null);
      setShowCustom(false);
      onFactorChange(preset);
    },
    [onFactorChange]
  );

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed) {
      setCustomError("Enter a value");
      return;
    }

    const parsed = parseQuantity(trimmed);
    if (!parsed) {
      setCustomError("Invalid number");
      return;
    }

    // Factor must be > 0
    if (parsed.n <= 0n) {
      setCustomError("Must be > 0");
      return;
    }

    setCustomError(null);
    onFactorChange(parsed);
  }, [customInput, onFactorChange]);

  const handleCustomKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCustomSubmit();
      }
    },
    [handleCustomSubmit]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-500">Scale</span>

        <div className="flex gap-1">
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant={isActivePreset(preset.value) ? "default" : "outline"}
              size="sm"
              onClick={() => handlePresetClick(preset.value)}
            >
              {preset.label}
            </Button>
          ))}

          <Button
            type="button"
            variant={showCustom ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              setShowCustom((v) => !v);
              setCustomError(null);
            }}
          >
            Custom
          </Button>
        </div>
      </div>

      {showCustom && (
        <div className="flex items-center gap-2">
          <Input
            type="text"
            inputMode="decimal"
            placeholder="e.g., 1.5, 3/4"
            value={customInput}
            onChange={(e) => {
              setCustomInput(e.target.value);
              setCustomError(null);
            }}
            onKeyDown={handleCustomKeyDown}
            className="w-32"
            aria-invalid={customError ? true : undefined}
          />
          <Button type="button" size="sm" onClick={handleCustomSubmit}>
            Apply
          </Button>

          {customError && (
            <span className="text-sm text-red-600">{customError}</span>
          )}
        </div>
      )}
    </div>
  );
}
