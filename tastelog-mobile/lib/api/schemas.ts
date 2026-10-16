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

const dateTimeSchema = z.string().min(1);

const uuidSchema = z.string().uuid();

const nonEmptyStringNullish = () =>
  z.union([z.string().min(1), z.null()]).optional();

// =============================================================================
// Recipe Schemas (api/models/recipe.py)
// =============================================================================

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

export const stepResponseSchema = z.object({
  id: uuidSchema,
  recipe_id: uuidSchema,
  position: z.number().int().min(1),
  instruction: z.string().min(1),
  // Issue 1 durable step-ingredient mapping, in canonical recipe
  // ingredient (position) order.
  //   null/absent -> mapping unknown/legacy (fall back to text matching)
  //   []          -> authoritative: this step uses no ingredients
  //   ids         -> authoritative ingredient references
  // Optional so pre-mapping backend responses (deploy gap) still parse.
  ingredient_ids: z.array(uuidSchema).nullable().optional(),
});

export type StepResponse = z.infer<typeof stepResponseSchema>;

export const recipeDetailResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  title: z.string().min(1),
  image_storage_key: nonEmptyStringNullish(),
  image_path: nonEmptyStringNullish(),
  source_url: z.string().nullable().optional(),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  // Phase 13.6.4-FU — saved-Riff lineage (migration 018 columns).
  // Nullable on every recipe; non-null only on recipes saved via the
  // /riff/save flow. Optional so 13.1-era backend responses (deploy gap)
  // still parse.
  parent_recipe_id: z.string().uuid().nullable().optional(),
  riff_session_id: z.string().uuid().nullable().optional(),
  riff_label: z.string().min(1).nullable().optional(),
  // Issue 3, monotonic content revision (CAS anchor for saved-recipe
  // editing). Optional so pre-027 backend responses (deploy gap) still
  // parse; the Edit entry gates on its presence.
  content_rev: z.number().int().min(1).optional(),
  ingredients: z.array(ingredientResponseSchema),
  steps: z.array(stepResponseSchema),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type RecipeDetailResponse = z.infer<typeof recipeDetailResponseSchema>;

// =============================================================================
// Recipe Content Edit Request (Issue 3, plan section 6.1)
//
// Explicit operations only: unchanged rows are never transmitted. A key's
// PRESENCE marks an intentional change; null = intentional clear (nullable
// fields only). `order` is the complete post-edit membership (ids +
// temp_ids, each exactly once), required whenever membership changes; an
// empty order array is legal exactly when every row was deleted.
// =============================================================================

const ingredientFieldsPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    quantity: z.string().min(1).nullable().optional(),
    unit: z.string().min(1).nullable().optional(),
    prep: z.string().min(1).nullable().optional(),
  })
  .strict();

const stepFieldsPatchSchema = z
  .object({
    instruction: z.string().min(1),
  })
  .strict();

export const recipeContentUpdateRequestSchema = z
  .object({
    expected_content_rev: z.number().int().min(1),
    mutation_id: uuidSchema,
    fields: z
      .object({
        title: z.string().min(1).optional(),
        servings: z.string().min(1).nullable().optional(),
        prep_time: z.string().min(1).nullable().optional(),
        cook_time: z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
    ingredients: z
      .object({
        update: z
          .array(
            z.object({ id: uuidSchema, fields: ingredientFieldsPatchSchema }).strict(),
          )
          .min(1)
          .optional(),
        create: z
          .array(
            z
              .object({
                temp_id: uuidSchema,
                name: z.string().min(1),
                quantity: z.string().min(1).nullable().optional(),
                unit: z.string().min(1).nullable().optional(),
                prep: z.string().min(1).nullable().optional(),
              })
              .strict(),
          )
          .min(1)
          .optional(),
        delete: z.array(uuidSchema).min(1).optional(),
        order: z.array(uuidSchema).optional(),
      })
      .strict()
      .optional(),
    steps: z
      .object({
        update: z
          .array(
            z.object({ id: uuidSchema, fields: stepFieldsPatchSchema }).strict(),
          )
          .min(1)
          .optional(),
        create: z
          .array(
            z
              .object({ temp_id: uuidSchema, instruction: z.string().min(1) })
              .strict(),
          )
          .min(1)
          .optional(),
        delete: z.array(uuidSchema).min(1).optional(),
        order: z.array(uuidSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RecipeContentUpdateRequest = z.infer<
  typeof recipeContentUpdateRequestSchema
>;

export const recipeSearchResultSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1),
  source_url: z.string().nullable().optional(),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  // Phase 13.6.4-FU — saved-Riff lineage (mirrors recipeDetailResponseSchema).
  parent_recipe_id: z.string().uuid().nullable().optional(),
  riff_session_id: z.string().uuid().nullable().optional(),
  riff_label: z.string().min(1).nullable().optional(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type RecipeSearchResult = z.infer<typeof recipeSearchResultSchema>;

// =============================================================================
// Draft Schemas (api/models/draft.py)
// =============================================================================

export const ingredientDataSchema = z.object({
  position: z.number().int().min(1).optional(),
  quantity: nonEmptyStringNullish(),
  unit: nonEmptyStringNullish(),
  name: z.string().min(1),
  prep: nonEmptyStringNullish(),
  raw_text: nonEmptyStringNullish(),
});

export type IngredientData = z.infer<typeof ingredientDataSchema>;

export const stepDataSchema = z.object({
  position: z.number().int().min(1).optional(),
  instruction: z.string().min(1),
});

export type StepData = z.infer<typeof stepDataSchema>;

export const draftResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  image_storage_keys: z.array(z.string().min(1)),
  source_url: z.string().nullable().optional(),
  title: z.string().min(1),
  servings: z.string().min(1).nullable(),
  prep_time: z.string().min(1).nullable(),
  cook_time: z.string().min(1).nullable(),
  confidence_score: z.number().min(0).max(1).nullable(),
  ingredients: z.array(ingredientDataSchema),
  steps: z.array(stepDataSchema),
  raw_model_json: z.record(z.string(), z.unknown()).nullable(),
  model_version: nonEmptyStringNullish(),
  parser_version: nonEmptyStringNullish(),
  expires_at: dateTimeSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type DraftResponse = z.infer<typeof draftResponseSchema>;

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

const sourceRecipeSchema = z.object({
  id: z.string(),
  title: z.string(),
});

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
  source_recipes: z.array(sourceRecipeSchema).nullable(),
  // Substitution-provenance label (PROVIDER-S1.1 W2). Nullish so parsing
  // stays valid against an older API that does not return the field.
  note: nonEmptyStringNullish(),
});

export type GroceryItemResponse = z.infer<typeof groceryItemResponseSchema>;

export const groceryListResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1),
  display_name: z.string().min(1),
  completed_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
});

export type GroceryListResponse = z.infer<typeof groceryListResponseSchema>;

export const groceryListDetailResponseSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1),
  display_name: z.string().min(1),
  completed_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  items: z.array(groceryItemResponseSchema),
});

export type GroceryListDetailResponse = z.infer<
  typeof groceryListDetailResponseSchema
>;

export const createGroceryListRequestSchema = z.object({
  name: z.string().min(1).max(200),
});

export type CreateGroceryListRequest = z.infer<
  typeof createGroceryListRequestSchema
>;

export const renameGroceryListRequestSchema = z.object({
  name: z.string().min(1).max(200),
});

export type RenameGroceryListRequest = z.infer<
  typeof renameGroceryListRequestSchema
>;

const remakeItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
});

export type RemakeItem = z.infer<typeof remakeItemSchema>;

export const remakeRequestSchema = z.object({
  recipe_id: uuidSchema,
  items: z.array(remakeItemSchema).min(1).optional(),
  list_id: uuidSchema.optional(),
});

export type RemakeRequest = z.infer<typeof remakeRequestSchema>;

export const groceryRemakeResponseSchema = z.object({
  list: groceryListDetailResponseSchema,
  items_added: z.number().int().min(0),
  items_merged: z.number().int().min(0),
});

export type GroceryRemakeResponse = z.infer<typeof groceryRemakeResponseSchema>;

export const toggleItemRequestSchema = z.object({
  checked: z.boolean(),
});

export type ToggleItemRequest = z.infer<typeof toggleItemRequestSchema>;

export const addManualItemRequestSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  list_id: uuidSchema.optional(),
});

export type AddManualItemRequest = z.infer<typeof addManualItemRequestSchema>;

// =============================================================================
// Capture Token Schemas (api/models/capture_token.py)
// =============================================================================

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

export const captureTokenCreatedSchema = captureTokenResponseSchema.extend({
  token: z.string().min(20).max(200),
});

export type CaptureTokenCreated = z.infer<typeof captureTokenCreatedSchema>;

export const captureTokenCreateSchema = z.object({
  name: z.string().min(1).max(100),
  expires_at: dateTimeSchema.nullable().optional(),
});

export type CaptureTokenCreate = z.infer<typeof captureTokenCreateSchema>;

// =============================================================================
// Capture Endpoint Schemas (POST /api/recipes/capture)
// =============================================================================

export const captureResponseSchema = z.object({
  capture_id: uuidSchema,
  recipe_id: uuidSchema.nullable(),
  status: z.enum(["queued", "processing", "complete", "failed"]),
  view_url: z.string().min(1),
});

export type CaptureResponse = z.infer<typeof captureResponseSchema>;

// =============================================================================
// Cook Event Schemas (api/models/cook_event.py)
// =============================================================================

export const cookEventResponseSchema = z.object({
  id: uuidSchema,
  recipe_id: uuidSchema,
  user_id: uuidSchema,
  cooked_at: dateTimeSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  notes: z.string().nullable(),
  scale: z.string().nullable(),
  created_at: dateTimeSchema,
});

export type CookEventResponse = z.infer<typeof cookEventResponseSchema>;

export const recentCookResponseSchema = z.object({
  id: uuidSchema,
  recipe_id: uuidSchema,
  recipe_title: z.string().min(1),
  cooked_at: dateTimeSchema,
  rating: z.number().int().min(1).max(5).nullable(),
});

export type RecentCookResponse = z.infer<typeof recentCookResponseSchema>;

// =============================================================================
// Riff Schemas (api/models/riff.py)
// =============================================================================

export const riffTurnResponseSchema = z.object({
  session_id: uuidSchema,
  assistant_message: z.string().min(1),
  // 13.2 additive fields. Marked .optional().nullable() so this schema
  // also parses 13.1-era backend responses (deploy gap) without breaking.
  // The 13.2 backend always populates assistant_message_id; generated_recipe
  // is null when no recipe block was extracted.
  assistant_message_id: uuidSchema.optional().nullable(),
  generated_recipe: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type RiffTurnResponse = z.infer<typeof riffTurnResponseSchema>;

export const riffSaveResponseSchema = z.object({
  recipe_id: uuidSchema,
});

export type RiffSaveResponse = z.infer<typeof riffSaveResponseSchema>;

// =============================================================================
// Riff Streaming Event Schemas (Phase 13.5 — SSE wire shapes)
//
// Each schema corresponds to one named event emitted by the backend
// streaming endpoint POST /api/recipes/{id}/riff/stream. See
// docs/phase13-4-B-streaming-contract.md §4 for the contract; matches
// the actual server emission in api/routes/riff.py:_stream_events.
//
// These schemas are additive to the sync-path schemas above. The sync
// /riff endpoint and its riffTurnResponseSchema are unchanged.
// =============================================================================

export const sessionResolvedEventSchema = z.object({
  session_id: uuidSchema,
});
export type SessionResolvedEvent = z.infer<typeof sessionResolvedEventSchema>;

export const userMessageCommittedEventSchema = z.object({
  user_message_id: uuidSchema,
});
export type UserMessageCommittedEvent = z.infer<
  typeof userMessageCommittedEventSchema
>;

// `seq` is monotonic from 0; client-side gap detection compares against
// the next expected value (per contract §5).
export const assistantDeltaEventSchema = z.object({
  text: z.string(),
  seq: z.number().int().nonnegative(),
});
export type AssistantDeltaEvent = z.infer<typeof assistantDeltaEventSchema>;

export const assistantCompleteEventSchema = z.object({
  assistant_message_id: uuidSchema,
});
export type AssistantCompleteEvent = z.infer<
  typeof assistantCompleteEventSchema
>;

// `generated_recipe` payload is the validated server-side
// ParsedRecipe.model_dump() shape. Kept loose (record of unknown) on the
// client because canonical validation lives server-side at /riff/save;
// mobile UI only needs presence/non-null to gate the Save CTA. Mirrors
// the riffTurnResponseSchema.generated_recipe treatment used by the
// sync path.
export const generatedRecipeReadyEventSchema = z.object({
  generated_recipe: z.record(z.string(), z.unknown()),
});
export type GeneratedRecipeReadyEvent = z.infer<
  typeof generatedRecipeReadyEventSchema
>;

// `code` is from the V1 §16-G catalog (RATE_LIMIT / MODEL_TIMEOUT /
// MODEL_ERROR / NETWORK_ERROR / INTERNAL_ERROR). Kept as bounded string
// rather than z.enum() so server-added codes don't break the client at
// the boundary; client only branches on `retryable`.
export const riffStreamErrorEventSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type RiffStreamErrorEvent = z.infer<typeof riffStreamErrorEventSchema>;

// Server emits `data: {}` for `done`. Empty object accepted; non-strict
// to preserve forward-compat if the contract ever attaches metadata.
export const doneEventSchema = z.object({}).passthrough();
export type DoneEvent = z.infer<typeof doneEventSchema>;

// =============================================================================
// API Error Schema
// =============================================================================

export const apiErrorResponseSchema = z.object({
  detail: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
