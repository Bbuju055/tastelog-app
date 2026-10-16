/**
 * Typed API fetch wrapper for Tastelog Mobile.
 *
 * Key differences from web client:
 * - Uses absolute URLs (no Next.js rewrite proxy)
 * - Explicit dual auth: "user" (JWT) or "capture" (tl_cap_* token)
 * - No hasSupabaseEnv() guard (mobile always has Supabase configured)
 */

import { z } from "zod";
import {
  isApiError,
  apiErrorFromHttp,
  apiErrorFromNetwork,
  apiErrorFromTimeout,
  apiErrorFromValidation,
  type FastApiDetail,
} from "../errors";
import { getAccessToken } from "../auth/supabase";
import { getCaptureToken } from "../auth/storage";
import { env } from "../config";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type AuthMode = "user" | "capture" | "none";

type ApiFetchOptions<T> = {
  path: string; // must start with /api/
  method?: HttpMethod;
  schema: z.ZodType<T>;
  body?: unknown | FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  authMode?: AuthMode;
  auth?: "required" | "optional"; // only meaningful for authMode="user"
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
    authMode = "user",
    auth = "optional",
  } = opts;

  assertApiPath(path);

  const reqHeaders: Record<string, string> = { ...headers };
  let reqBody: BodyInit | undefined;

  if (body !== undefined && body !== null) {
    if (isFormData(body)) {
      reqBody = body;
    } else {
      reqHeaders["Content-Type"] =
        reqHeaders["Content-Type"] ?? "application/json";
      reqBody = JSON.stringify(body);
    }
  }

  // Explicit auth mode: user JWT, capture token, or none
  if (authMode === "user") {
    const token = await getAccessToken();
    if (token) {
      reqHeaders["Authorization"] = `Bearer ${token}`;
    } else if (auth === "required") {
      throw apiErrorFromValidation({
        message: "Authentication required, but no active session is available.",
      });
    }
  } else if (authMode === "capture") {
    const token = await getCaptureToken();
    if (token) {
      reqHeaders["Authorization"] = `Bearer ${token}`;
    } else {
      throw apiErrorFromValidation({
        message: "Capture token required, but none is stored on this device.",
      });
    }
  }
  // authMode === "none": no auth header

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // Absolute URL: mobile has no rewrite proxy
  const url = `${env.EXPO_PUBLIC_API_BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal: controller.signal,
    });

    if (res.status === 204) {
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

    if (isApiError(err)) {
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
