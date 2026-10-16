// src/lib/api/client.ts
/**
 * Typed API fetch wrapper for Tastelog Web.
 *
 * Rules:
 * - Only talks to `/api/*` (Next.js rewrite is the single source of truth)
 * - Attaches `Authorization: Bearer <token>` when available
 * - Supports JSON and FormData bodies
 * - Handles 204 No Content explicitly
 * - Normalizes FastAPI `{ detail }` errors
 * - Enforces runtime response validation with Zod
 * - No retries, no silent fallbacks
 */

import { z } from "zod";
import {
  apiErrorFromHttp,
  apiErrorFromNetwork,
  apiErrorFromTimeout,
  apiErrorFromValidation,
  type FastApiDetail,
} from "@/lib/errors";
import { hasSupabaseEnv } from "@/lib/supabase/env";

async function maybeGetAccessToken(): Promise<string | null> {
  if (!hasSupabaseEnv()) return null;
  const mod = await import("@/lib/supabase/browser");
  return await mod.getAccessToken();
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type ApiFetchOptions<T> = {
  path: string; // must start with /api/
  method?: HttpMethod;
  schema: z.ZodType<T>;
  body?: unknown | FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  auth?: "required" | "optional" | "none";
};

function assertApiPath(path: string): void {
  if (!path.startsWith("/api/")) {
    throw apiErrorFromValidation({
      message: `apiFetch: path must start with "/api/": received "${path}"`,
    });
  }
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

async function readResponsePayload(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractFastApiDetail(payload: unknown): FastApiDetail {
  if (!payload || typeof payload !== "object") return undefined;
  if (!("detail" in payload)) return undefined;
  // Narrowed to object with `detail` property
  const { detail } = payload as { detail: unknown };
  if (detail === null || detail === undefined) return detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail;
  if (typeof detail === "object") return detail as Record<string, unknown>;
  return undefined;
}

export async function apiFetch<T>(opts: ApiFetchOptions<T>): Promise<T> {
  const {
    path,
    method = "GET",
    schema,
    body,
    headers = {},
    signal,
    timeoutMs = 20_000,
    auth = "optional",
  } = opts;

  assertApiPath(path);

  const reqHeaders: Record<string, string> = { ...headers };
  let reqBody: BodyInit | undefined;

  if (body !== undefined && body !== null) {
    if (isFormData(body)) {
      reqBody = body;
      // IMPORTANT: do NOT set Content-Type for FormData
    } else {
      reqHeaders["Content-Type"] =
        reqHeaders["Content-Type"] ?? "application/json";
      reqBody = JSON.stringify(body);
    }
  }

  // Auth handling: only attempt when Supabase env is configured.
  // If env is missing, proceed unauthenticated (no error, no header).
  if (auth !== "none" && hasSupabaseEnv()) {
    let token: string | null = null;
    try {
      token = await maybeGetAccessToken();
    } catch (err) {
      if (auth === "required") {
        throw apiErrorFromValidation({
          message:
            "Authentication required, but access token could not be retrieved.",
          cause: err,
        });
      }
    }

    if (token) {
      reqHeaders["Authorization"] = `Bearer ${token}`;
    } else if (auth === "required") {
      throw apiErrorFromValidation({
        message: "Authentication required, but no active session is available.",
      });
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(path, {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal: controller.signal,
    });

    if (res.status === 204) {
      // Caller must expect void/undefined
      return undefined as T;
    }

    const payload = await readResponsePayload(res);

    if (!res.ok) {
      throw apiErrorFromHttp({
        status: res.status,
        detail: extractFastApiDetail(payload),
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw apiErrorFromValidation({
        message: "Response validation failed (schema mismatch).",
        cause: parsed.error,
      });
    }

    return parsed.data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw apiErrorFromTimeout({ cause: err });
    }

    if (err instanceof Error && err.name === "ApiError") {
      throw err;
    }

    throw apiErrorFromNetwork({
      message:
        err instanceof Error ? err.message : "Network request failed.",
      cause: err,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
