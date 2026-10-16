export type ShareCaptureLinkParams = {
  captureId: string;
  recipeId?: string | null;
  status?: string | null;
  viewUrl?: string | null;
};

export function buildShareCaptureDeepLink({
  captureId,
  recipeId,
  status,
  viewUrl,
}: ShareCaptureLinkParams): string {
  const url = new URL(`tastelog://review/${captureId}`);

  if (recipeId) url.searchParams.set("recipe_id", recipeId);
  if (status) url.searchParams.set("status", status);
  if (viewUrl) url.searchParams.set("view_url", viewUrl);

  return url.toString();
}

export function parseShareCaptureDeepLink(raw: string): ShareCaptureLinkParams | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "tastelog:") return null;

  // For custom schemes, URL() sets:
  // - host = "review"
  // - pathname = "/<captureId>"
  if (url.host !== "review") return null;

  const captureId = url.pathname.replace(/^\/+/, "");
  if (!captureId) return null;

  const recipeId = url.searchParams.get("recipe_id");
  const status = url.searchParams.get("status");
  const viewUrl = url.searchParams.get("view_url");

  return {
    captureId,
    recipeId,
    status,
    viewUrl,
  };
}
