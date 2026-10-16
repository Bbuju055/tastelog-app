/**
 * Ingredient Scaling Module
 *
 * Public API for scaling recipe ingredients.
 */

// Types
export type {
  Rational,
  ParsedQuantity,
  ParsedNumeric,
  ParsedContainer,
  ParsedCounted,
  ParsedQualifier,
  ParsedUnparsed,
  ScaleResult,
  ScaledResult,
  UnscaledResult,
} from "./types";

// Rational math
export {
  make,
  mul,
  add,
  cmp,
  isOne,
  isZero,
  roundHalfUp,
  toDisplayString,
  HALF,
  ONE,
  TWO,
} from "./rational";

// Parsing
export { parseQuantity } from "./parseQuantity";

// Classification
export { classifyIngredient } from "./classifyIngredient";

// Scaling
export { scaleIngredient } from "./scaleIngredient";

// Formatting
export { formatIngredient, pluralize } from "./formatIngredient";
export type { FormattedIngredient } from "./formatIngredient";

// Servings
export { parseServings } from "./parseServings";

// Grocery override
export { buildGroceryOverrideItems, shouldBlockScaledAdd } from "./groceryOverride";
export type {
  GroceryOverrideItem,
  ScaledIngredientEntry,
} from "./groceryOverride";
