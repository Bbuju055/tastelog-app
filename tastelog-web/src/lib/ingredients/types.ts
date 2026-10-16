/**
 * Ingredient Scaling Types
 *
 * Core type definitions for the ingredient scaling system.
 * Uses BigInt rational arithmetic for exact precision.
 */

// Rational (BigInt — exact arithmetic, no float drift)
export type Rational = {
  readonly n: bigint; // numerator (can be negative)
  readonly d: bigint; // denominator (always > 0, always reduced)
};

// ParsedQuantity (discriminated union)

// Numeric (continuous) units that scale exactly.
export type ParsedNumeric = {
  readonly kind: "numeric";
  readonly value: Rational;
  readonly unit: string; // normalized lowercase unit
};

// Container units that allow fractional output.
export type ParsedContainer = {
  readonly kind: "container";
  readonly value: Rational;
  readonly unitWord: string; // normalized singular form (e.g., "can")
};

// Counted items that must be rounded to whole numbers. v1: eggs only.
export type ParsedCounted = {
  readonly kind: "counted";
  readonly value: Rational;
  readonly item: string; // normalized singular form (e.g., "egg")
};

// Qualifier phrases that are never scaled.
export type ParsedQualifier = {
  readonly kind: "qualifier";
  readonly text: string;
};

// Unparseable quantity - treated as unscalable.
export type ParsedUnparsed = {
  readonly kind: "unparsed";
  readonly text: string;
};

export type ParsedQuantity =
  | ParsedNumeric
  | ParsedContainer
  | ParsedCounted
  | ParsedQualifier
  | ParsedUnparsed;

// ScaleResult
export type ScaledResult = {
  readonly kind: "scaled";
  readonly scaled: ParsedNumeric | ParsedContainer | ParsedCounted;
  readonly meta?: {
    readonly rounded?: true;
  };
};

export type UnscaledResult = {
  readonly kind: "unscaled";
  readonly reason: "qualifier" | "unparsed";
};

export type ScaleResult = ScaledResult | UnscaledResult;
