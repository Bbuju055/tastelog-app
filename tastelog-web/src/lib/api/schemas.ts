/**
 * API Contract: Zod schemas matching backend responses.
 * Tolerant where backend behavior may vary.
 *
 * Source of truth: api/models/*.py
 * Last verified: 2026-01-24
 *
 * These schemas serve as runtime validation to prevent silent contract drift.
 * Any mismatch between frontend expectations and backend responses will
 * surface as a parse error rather than undefined behavior.
 */

import { z } from "zod";

// =============================================================================
// Base Types
// =============================================================================

/**
 * ISO 8601 datetime string. Backend returns UTC timestamps.
 * Kept loose to tolerate microseconds and timezone offset variations.
 */
const dateTimeSchema = z.string().min(1);

/**
 * UUID string validation.
 */
const uuidSchema = z.string().uuid();

/**
 * Non-empty string that can be null or undefined.
 * Returns a fresh schema each call to avoid Zod v4 shared instance issues.
 * Accepts: non-empty string, null, undefined
 * Rejects: empty string
 */
const nonEmptyStringNullish = () =>
  z.union([z.string().min(1), z.null()]).optional();

// =============================================================================
// Recipe Schemas (api/models/recipe.py)
// =============================================================================

/**
 * Single ingredient in a recipe.
 * Maps to: IngredientResponse
 */
export const ingredientResponseSchema = z.object({
  id: uuidSchema,
  recipe_id: uuidSchema,
  position: z.number().int().min(1),
  quantity: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  name: z.string().min(1),
  prep: z.string().min(1).nullable(),
  raw_text: z.string().min(1).nullable(),
});

export type IngredientResponse = z.infer<typeof ingredientResponseSchema>;

/**
 * Single step in a recipe.
 * Maps to: StepResponse
 */
export const stepResponseSchema = z.object({
  id: uuidSchema,
  recipe_id: uuidSchema,
  position: z.number().int().min(1),
  instruction: z.string().min(1),
});

export type StepResponse = z.infer<typeof stepResponseSchema>;

/**
 * Full recipe with ingredients and steps.
 * Maps to: RecipeDetailResponse
 *
 * Endpoint: GET /api/recipes/{id}
 * Endpoint: POST /api/recipes/capture
 * Endpoint: POST /api/drafts/{id}/confirm
 */
export const recipeDetailResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  title: z.string().min(1),
  // Backend uses validation_alias="image_path" - allow both for safety
  image_storage_key: nonEmptyStringNullish(),
  image_path: nonEmptyStringNullish(),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  ingredients: z.array(ingredientResponseSchema),
  steps: z.array(stepResponseSchema),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type RecipeDetailResponse = z.infer<typeof recipeDetailResponseSchema>;

/**
 * Recipe summary for search/list results.
 * Maps to: RecipeSearchResult
 *
 * Endpoint: GET /api/recipes
 * Endpoint: GET /api/recipes/search
 */
export const recipeSearchResultSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type RecipeSearchResult = z.infer<typeof recipeSearchResultSchema>;

// =============================================================================
// Draft Schemas (api/models/draft.py)
// =============================================================================

/**
 * Ingredient data in draft JSONB (no ID - assigned during confirm).
 * Maps to: IngredientData
 *
 * Position is optional - UI uses array order by default, position if present.
 */
export const ingredientDataSchema = z.object({
  position: z.number().int().min(1).optional(),
  quantity: nonEmptyStringNullish(),
  unit: nonEmptyStringNullish(),
  name: z.string().min(1),
  prep: nonEmptyStringNullish(),
  raw_text: nonEmptyStringNullish(),
});

export type IngredientData = z.infer<typeof ingredientDataSchema>;

/**
 * Step data in draft JSONB (no ID - assigned during confirm).
 * Maps to: StepData
 *
 * Position is optional - UI uses array order by default, position if present.
 */
export const stepDataSchema = z.object({
  position: z.number().int().min(1).optional(),
  instruction: z.string().min(1),
});

export type StepData = z.infer<typeof stepDataSchema>;

/**
 * Full draft for review.
 * Maps to: DraftResponse
 *
 * Endpoint: POST /api/drafts/capture
 * Endpoint: GET /api/drafts/{id}
 */
export const draftResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  // Backend may alias image_path; allow both, enforce at least one in API layer
  image_storage_key: nonEmptyStringNullish(),
  image_path: nonEmptyStringNullish(),
  title: z.string().min(1),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  ingredients: z.array(ingredientDataSchema),
  steps: z.array(stepDataSchema),
  raw_model_json: z.record(z.string(), z.unknown()).nullable(),
  // Tolerant: may be null on partial/failed parses
  model_version: nonEmptyStringNullish(),
  parser_version: nonEmptyStringNullish(),
  expires_at: dateTimeSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type DraftResponse = z.infer<typeof draftResponseSchema>;

/**
 * Request body for confirming a draft with optional overrides.
 * Maps to: DraftConfirmRequest
 *
 * Endpoint: POST /api/drafts/{id}/confirm
 */
export const draftConfirmRequestSchema = z.object({
  title: z.string().min(1).optional(),
  servings: z.string().min(1).optional(),
  prep_time: z.string().min(1).optional(),
  cook_time: z.string().min(1).optional(),
  ingredients: z.array(ingredientDataSchema).optional(),
  steps: z.array(stepDataSchema).optional(),
});

export type DraftConfirmRequest = z.infer<typeof draftConfirmRequestSchema>;

// =============================================================================
// Grocery Schemas (api/models/grocery.py)
// =============================================================================

/**
 * Single item in a grocery list.
 * Maps to: GroceryItemResponse
 *
 * Endpoint: PATCH /api/grocery/items/{id}
 */
export const groceryItemResponseSchema = z.object({
  id: uuidSchema,
  list_id: uuidSchema,
  recipe_id: uuidSchema.nullable(),
  position: z.number().int().min(1),
  quantity: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  name: z.string().min(1),
  checked: z.boolean(),
  recipe_title: z.string().min(1).nullable(),
});

export type GroceryItemResponse = z.infer<typeof groceryItemResponseSchema>;

/**
 * Grocery list summary (without items).
 * Maps to: GroceryListResponse
 *
 * Endpoint: GET /api/grocery/lists
 */
export const groceryListResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1),
  completed_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type GroceryListResponse = z.infer<typeof groceryListResponseSchema>;

/**
 * Full grocery list with items.
 * Maps to: GroceryListDetailResponse
 *
 * Endpoint: GET /api/grocery/lists/{id}
 * Endpoint: POST /api/grocery/remake
 */
export const groceryListDetailResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1),
  completed_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  items: z.array(groceryItemResponseSchema),
});

export type GroceryListDetailResponse = z.infer<
  typeof groceryListDetailResponseSchema
>;

/**
 * Request body for creating a grocery list from a recipe.
 * Maps to: RemakeRequest
 *
 * Endpoint: POST /api/grocery/remake
 */
export const remakeRequestSchema = z.object({
  recipe_id: uuidSchema,
  list_id: uuidSchema.optional(),
});

export type RemakeRequest = z.infer<typeof remakeRequestSchema>;

/**
 * Request body for toggling item checked status.
 * Maps to: ToggleItemRequest
 *
 * Endpoint: PATCH /api/grocery/items/{id}
 */
export const toggleItemRequestSchema = z.object({
  checked: z.boolean(),
});

export type ToggleItemRequest = z.infer<typeof toggleItemRequestSchema>;

// =============================================================================
// Capture Token Schemas (api/models/capture_token.py)
// =============================================================================

/**
 * Capture token metadata (no secret).
 * Maps to: CaptureTokenResponse
 *
 * Endpoint: GET /api/tokens
 */
export const captureTokenResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1).max(100),
  scope: z.literal("capture"),
  created_at: dateTimeSchema,
  expires_at: dateTimeSchema.nullable(),
  revoked_at: dateTimeSchema.nullable(),
  last_used_at: dateTimeSchema.nullable(),
});

export type CaptureTokenResponse = z.infer<typeof captureTokenResponseSchema>;

/**
 * Response when creating a token - includes the secret (shown once).
 * Maps to: CaptureTokenCreated
 *
 * Endpoint: POST /api/tokens
 */
export const captureTokenCreatedSchema = captureTokenResponseSchema.extend({
  token: z.string().min(20).max(200),
});

export type CaptureTokenCreated = z.infer<typeof captureTokenCreatedSchema>;

/**
 * Request body for creating a capture token.
 * Maps to: CaptureTokenCreate
 */
export const captureTokenCreateSchema = z.object({
  name: z.string().min(1).max(100),
  expires_at: dateTimeSchema.nullable().optional(),
});

export type CaptureTokenCreate = z.infer<typeof captureTokenCreateSchema>;

// =============================================================================
// API Error Schema
// =============================================================================

/**
 * Standard FastAPI error response shape.
 * detail can be string (most errors) or array (422 validation errors).
 */
export const apiErrorResponseSchema = z.object({
  detail: z.union([z.string(), z.array(z.unknown())]),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

// =============================================================================
// Endpoint Contract Summary
// =============================================================================

/**
 * API Endpoint Contract (verified 2026-01-24)
 *
 * DRAFTS:
 * - POST   /api/drafts/capture              -> DraftResponse (201)
 * - GET    /api/drafts/{id}                 -> DraftResponse (200)
 * - POST   /api/drafts/{id}/confirm         -> RecipeDetailResponse (200)
 * - DELETE /api/drafts/{id}                 -> 204 No Content
 *
 * RECIPES:
 * - GET    /api/recipes?limit=&offset=      -> RecipeSearchResult[] (200)
 * - GET    /api/recipes/search?q=&limit=    -> RecipeSearchResult[] (200)
 * - GET    /api/recipes/{id}                -> RecipeDetailResponse (200)
 * - DELETE /api/recipes/{id}                -> 204 No Content
 * - POST   /api/recipes/capture             -> RecipeDetailResponse (200)
 *
 * GROCERY:
 * - GET    /api/grocery/lists?limit=        -> GroceryListResponse[] (200)
 * - GET    /api/grocery/lists/{id}          -> GroceryListDetailResponse (200)
 * - DELETE /api/grocery/lists/{id}          -> 204 No Content
 * - POST   /api/grocery/remake              -> GroceryListDetailResponse (201)
 * - PATCH  /api/grocery/items/{id}          -> GroceryItemResponse (200)
 *
 * ERROR RESPONSES:
 * - 400: Invalid request (file type, validation)
 * - 404: Resource not found
 * - 410: Draft expired
 * - 413: File too large
 * - 422: Unprocessable (parse failed, validation errors)
 * - 500: Internal server error
 * - 502: Upstream service error
 */
