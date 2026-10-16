/**
 * Typed API bindings for Tastelog backend endpoints.
 *
 * Rules:
 * - Do not invent endpoints.
 * - Validate every success response with Zod schemas.
 * - Draft edits are NEVER auto-saved here; callers must explicitly confirm.
 * - Use normalizeImageKey() to tolerate backend aliasing.
 */

import { z } from "zod";
import { apiFetch } from "./client";
import { normalizeImageKey } from "./normalize";
import {
  captureTokenCreatedSchema,
  captureTokenResponseSchema,
  cookEventResponseSchema,
  draftResponseSchema,
  groceryItemResponseSchema,
  groceryListDetailResponseSchema,
  groceryListResponseSchema,
  groceryRemakeResponseSchema,
  recipeDetailResponseSchema,
  recipeSearchResultSchema,
  recentCookResponseSchema,
} from "./schemas";
import type {
  AddManualItemRequest,
  CaptureTokenCreate,
  CreateGroceryListRequest,
  RecipeContentUpdateRequest,
  RenameGroceryListRequest,
} from "./schemas";

// -------------------- Capture Tokens --------------------

export async function listCaptureTokens() {
  return apiFetch({
    path: "/api/tokens",
    method: "GET",
    schema: captureTokenResponseSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function createCaptureToken(input: CaptureTokenCreate) {
  return apiFetch({
    path: "/api/tokens",
    method: "POST",
    body: input,
    schema: captureTokenCreatedSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function revokeCaptureToken(tokenId: string) {
  await apiFetch({
    path: `/api/tokens/${encodeURIComponent(tokenId)}`,
    method: "DELETE",
    schema: captureTokenResponseSchema.optional(),
    authMode: "user",
    auth: "required",
  });
}

// -------------------- Drafts --------------------

export async function listDrafts() {
  return apiFetch({
    path: "/api/drafts",
    method: "GET",
    schema: draftResponseSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

/** Vision parsing is synchronous; 30-60s typical, 90s tail. */
const CAPTURE_TIMEOUT_MS = 120_000;

export async function captureDraft(form: FormData) {
  const draft = await apiFetch({
    path: "/api/drafts/capture",
    method: "POST",
    body: form,
    schema: draftResponseSchema,
    authMode: "user",
    auth: "required",
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
  return draft;
}

export async function captureURL(url: string) {
  return apiFetch({
    path: "/api/drafts/capture-url",
    method: "POST",
    body: { url },
    schema: draftResponseSchema,
    authMode: "user",
    auth: "required",
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
}

export async function getDraft(draftId: string) {
  const draft = await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}`,
    method: "GET",
    schema: draftResponseSchema,
    authMode: "user",
    auth: "required",
  });
  return draft;
}

export async function confirmDraft(draftId: string, body?: unknown) {
  const recipe = await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}/confirm`,
    method: "POST",
    body,
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
  return normalizeImageKey(recipe);
}

export async function deleteDraft(draftId: string) {
  await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}`,
    method: "DELETE",
    schema: draftResponseSchema.optional(),
    authMode: "user",
    auth: "required",
  });
}

// -------------------- Recipes --------------------

export async function listRecipes(params?: { limit?: number; offset?: number }) {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));

  const path = qs.toString() ? `/api/recipes?${qs.toString()}` : "/api/recipes";

  return apiFetch({
    path,
    method: "GET",
    schema: recipeSearchResultSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function searchRecipes(params: { q: string; limit?: number }) {
  const qs = new URLSearchParams();
  qs.set("q", params.q);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));

  return apiFetch({
    path: `/api/recipes/search?${qs.toString()}`,
    method: "GET",
    schema: recipeSearchResultSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function getRecipe(recipeId: string) {
  const recipe = await apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}`,
    method: "GET",
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
  return normalizeImageKey(recipe);
}

/**
 * Issue 3, saved-recipe content edit. Explicit 60s timeout (riff
 * precedent): a save may include a bounded server-side mapping pass; the
 * 20s default is insufficient.
 */
const RECIPE_UPDATE_TIMEOUT_MS = 60_000;

export async function updateRecipeContent(
  recipeId: string,
  body: RecipeContentUpdateRequest,
) {
  const recipe = await apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}`,
    method: "PATCH",
    body,
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
    timeoutMs: RECIPE_UPDATE_TIMEOUT_MS,
  });
  return normalizeImageKey(recipe);
}

export async function patchRecipeFavorite(
  recipeId: string,
  body: { favorite: boolean },
) {
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/favorite`,
    method: "PATCH",
    body,
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function patchRecipeTags(
  recipeId: string,
  body: { tags: string[] },
) {
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/tags`,
    method: "PATCH",
    body,
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function deleteRecipe(recipeId: string) {
  await apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}`,
    method: "DELETE",
    schema: recipeDetailResponseSchema.optional(),
    authMode: "user",
    auth: "required",
  });
}

export async function captureRecipe(form: FormData) {
  const recipe = await apiFetch({
    path: "/api/recipes/capture",
    method: "POST",
    body: form,
    schema: recipeDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
  return normalizeImageKey(recipe);
}

// -------------------- Grocery --------------------

export async function listGroceryLists(params?: { limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));

  const path = qs.toString()
    ? `/api/grocery/lists?${qs.toString()}`
    : "/api/grocery/lists";

  return apiFetch({
    path,
    method: "GET",
    schema: groceryListResponseSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function getGroceryList(listId: string) {
  return apiFetch({
    path: `/api/grocery/lists/${encodeURIComponent(listId)}`,
    method: "GET",
    schema: groceryListDetailResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function createGroceryList(body: CreateGroceryListRequest) {
  return apiFetch({
    path: "/api/grocery/lists",
    method: "POST",
    body,
    schema: groceryListResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function renameGroceryList(
  listId: string,
  body: RenameGroceryListRequest,
) {
  return apiFetch({
    path: `/api/grocery/lists/${encodeURIComponent(listId)}`,
    method: "PATCH",
    body,
    schema: groceryListResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function deleteGroceryList(listId: string) {
  await apiFetch({
    path: `/api/grocery/lists/${encodeURIComponent(listId)}`,
    method: "DELETE",
    schema: groceryListDetailResponseSchema.optional(),
    authMode: "user",
    auth: "required",
  });
}

export async function remakeGroceryList(body: unknown) {
  return apiFetch({
    path: "/api/grocery/remake",
    method: "POST",
    body,
    schema: groceryRemakeResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function patchGroceryItem(itemId: string, body: unknown) {
  return apiFetch({
    path: `/api/grocery/items/${encodeURIComponent(itemId)}`,
    method: "PATCH",
    body,
    schema: groceryItemResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function deleteGroceryItem(itemId: string) {
  await apiFetch({
    path: `/api/grocery/items/${encodeURIComponent(itemId)}`,
    method: "DELETE",
    schema: z.undefined(),
    authMode: "user",
    auth: "required",
  });
}

export async function addManualGroceryItem(body: AddManualItemRequest) {
  return apiFetch({
    path: "/api/grocery/items",
    method: "POST",
    body,
    schema: groceryRemakeResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

// -------------------- Cook Events --------------------

export async function logCookEvent(
  recipeId: string,
  body: { rating?: number; notes?: string; scale?: string; cooked_at?: string },
) {
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/cook`,
    method: "POST",
    body,
    schema: cookEventResponseSchema,
    authMode: "user",
    auth: "required",
  });
}

export async function getCookEvents(
  recipeId: string,
  limit?: number,
) {
  const qs = new URLSearchParams();
  if (limit !== undefined) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}/cooks${suffix}`,
    method: "GET",
    schema: cookEventResponseSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function getRecentCooks(limit?: number) {
  const qs = new URLSearchParams();
  if (limit !== undefined) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch({
    path: `/api/cooks/recent${suffix}`,
    method: "GET",
    schema: recentCookResponseSchema.array(),
    authMode: "user",
    auth: "required",
  });
}

export async function deleteCookEvent(cookEventId: string) {
  await apiFetch({
    path: `/api/cooks/${encodeURIComponent(cookEventId)}`,
    method: "DELETE",
    schema: z.undefined(),
    authMode: "user",
    auth: "required",
  });
}
