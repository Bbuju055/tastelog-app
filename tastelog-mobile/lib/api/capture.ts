import { captureResponseSchema, type CaptureResponse } from "./schemas";
import { apiFetch } from "./client";
import type { UploadFile } from "./uploadTypes";

/** Vision parsing is synchronous; typical 30-60s, tail up to 90s. */
const CAPTURE_TIMEOUT_MS = 120_000;

/** RFC4122 v4 id; used as the Idempotency-Key for capture attempts. */
export function uuidv4(): string {
  const cryptoAny = globalThis.crypto as
    | undefined
    | { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
  if (cryptoAny?.randomUUID) return cryptoAny.randomUUID();

  // Fallback: RFC4122 v4 using getRandomValues if available
  const getRandomValues = cryptoAny?.getRandomValues?.bind(cryptoAny);
  const bytes = new Uint8Array(16);
  if (getRandomValues) getRandomValues(bytes);
  else {
    // last-resort fallback (still v4-shaped; not cryptographically strong)
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export async function captureWithToken(args: {
  image: UploadFile;
  source: "mobile_app" | "share_extension";
  idempotencyKey?: string;
}): Promise<CaptureResponse> {
  const key = args.idempotencyKey ?? uuidv4();

  const form = new FormData();
  // RN FormData polyfill accepts { uri, name, type } file-part objects
  form.append(
    "image",
    {
      uri: args.image.uri,
      name: args.image.name,
      type: args.image.type,
    } as any,
  );
  form.append("source", args.source);

  return apiFetch({
    path: "/api/recipes/capture",
    method: "POST",
    body: form,
    schema: captureResponseSchema,
    authMode: "capture",
    headers: { "Idempotency-Key": key },
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
}
