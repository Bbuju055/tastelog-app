/**
 * Backend alias normalization.
 *
 * Backend may return image storage key under:
 * - image_storage_key
 * - image_path
 *
 * We normalize to:
 * - image_key: string | null
 *
 * This function returns a shallow-copied object with image_key added.
 * It does not mutate the input.
 */

type HasImageAliases = {
  image_storage_key?: string | null;
  image_path?: string | null;
};

export function normalizeImageKey<T extends Record<string, unknown>>(
  obj: T & HasImageAliases
): T & { image_key: string | null } {
  const imageKey =
    typeof obj.image_storage_key === "string" && obj.image_storage_key.length > 0
      ? obj.image_storage_key
      : typeof obj.image_path === "string" && obj.image_path.length > 0
        ? obj.image_path
        : null;

  return {
    ...(obj as T),
    image_key: imageKey,
  };
}
