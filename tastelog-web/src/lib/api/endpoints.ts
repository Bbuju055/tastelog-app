// src/lib/api/endpoints.ts
/**
 * Typed API bindings for Tastelog backend endpoints.
 *
 * Rules:
 * - Do not invent endpoints.
 * - Validate every success response with Zod schemas.
 * - Draft edits are NEVER auto-saved here; callers must explicitly confirm.
 * - Use normalizeImageKey() to tolerate backend aliasing.
 */

import { apiFetch } from "@/lib/api/client";
import { normalizeImageKey } from "@/lib/api/normalize";
import {
  captureTokenCreatedSchema,
  captureTokenResponseSchema,
  draftResponseSchema,
  groceryItemResponseSchema,
  groceryListDetailResponseSchema,
  groceryListResponseSchema,
  recipeDetailResponseSchema,
  recipeSearchResultSchema,
} from "@/lib/api/schemas";
import type { CaptureTokenCreate } from "@/lib/api/schemas";

// -------------------- Capture Tokens --------------------

export async function listCaptureTokens() {
  return apiFetch({
    path: "/api/tokens",
    method: "GET",
    schema: captureTokenResponseSchema.array(),
    auth: "required",
  });
}

export async function createCaptureToken(input: CaptureTokenCreate) {
  return apiFetch({
    path: "/api/tokens",
    method: "POST",
    body: input,
    schema: captureTokenCreatedSchema,
    auth: "required",
  });
}

export async function revokeCaptureToken(tokenId: string) {
  await apiFetch({
    path: `/api/tokens/${encodeURIComponent(tokenId)}`,
    method: "DELETE",
    schema: captureTokenResponseSchema.optional(),
    auth: "required",
  });
}

// -------------------- Drafts --------------------

export async function captureDraft(form: FormData) {
  const draft = await apiFetch({
    path: "/api/drafts/capture",
    method: "POST",
    body: form,
    schema: draftResponseSchema,
    auth: "required",
  });
  return normalizeImageKey(draft);
}

export async function getDraft(draftId: string) {
  const draft = await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}`,
    method: "GET",
    schema: draftResponseSchema,
    auth: "required",
  });
  return normalizeImageKey(draft);
}

/**
 * Confirm a draft (commit draft -> recipe).
 * If backend supports edits on confirm, pass the edited payload as `body`.
 * This function does not persist edits by itself.
 */
export async function confirmDraft(draftId: string, body?: unknown) {
  const recipe = await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}/confirm`,
    method: "POST",
    body,
    schema: recipeDetailResponseSchema,
    auth: "required",
  });
  return normalizeImageKey(recipe);
}

export async function deleteDraft(draftId: string) {
  await apiFetch({
    path: `/api/drafts/${encodeURIComponent(draftId)}`,
    method: "DELETE",
    // apiFetch requires a schema; 204 returns undefined and skips parse.
    schema: draftResponseSchema.optional(),
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
    auth: "required",
  });
}

export async function getRecipe(recipeId: string) {
  const recipe = await apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}`,
    method: "GET",
    schema: recipeDetailResponseSchema,
    auth: "required",
  });
  return normalizeImageKey(recipe);
}

export async function deleteRecipe(recipeId: string) {
  await apiFetch({
    path: `/api/recipes/${encodeURIComponent(recipeId)}`,
    method: "DELETE",
    schema: recipeDetailResponseSchema.optional(),
    auth: "required",
  });
}

export async function captureRecipe(form: FormData) {
  const recipe = await apiFetch({
    path: "/api/recipes/capture",
    method: "POST",
    body: form,
    schema: recipeDetailResponseSchema,
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
    auth: "required",
  });
}

export async function getGroceryList(listId: string) {
  return apiFetch({
    path: `/api/grocery/lists/${encodeURIComponent(listId)}`,
    method: "GET",
    schema: groceryListDetailResponseSchema,
    auth: "required",
  });
}

export async function deleteGroceryList(listId: string) {
  await apiFetch({
    path: `/api/grocery/lists/${encodeURIComponent(listId)}`,
    method: "DELETE",
    schema: groceryListDetailResponseSchema.optional(),
    auth: "required",
  });
}

export async function remakeGroceryList(body: unknown) {
  return apiFetch({
    path: "/api/grocery/remake",
    method: "POST",
    body,
    schema: groceryListDetailResponseSchema,
    auth: "required",
  });
}

export async function patchGroceryItem(itemId: string, body: unknown) {
  return apiFetch({
    path: `/api/grocery/items/${encodeURIComponent(itemId)}`,
    method: "PATCH",
    body,
    schema: groceryItemResponseSchema,
    auth: "required",
  });
}
