// lib/sentry.ts
import * as Sentry from "@sentry/react-native";
import { env } from "./config";

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function scrubHeaders(
  headers: unknown
): Record<string, unknown> | undefined {
  if (!isPlainObject(headers)) return undefined;

  // clone to avoid mutating shared references
  const out: Record<string, unknown> = { ...headers };

  for (const key of Object.keys(out)) {
    const lowered = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lowered)) {
      out[key] = "[Filtered]";
    }
  }

  return out;
}

function scrubEvent(event: Sentry.Event): Sentry.Event {
  const req = event.request;
  if (req && typeof req === "object") {
    // scrub headers (preserve key casing as stored)
    const scrubbed = scrubHeaders((req as any).headers);
    if (scrubbed) (req as any).headers = scrubbed;

    // remove cookies + body/data
    if ("cookies" in (req as any)) delete (req as any).cookies;
    if ("data" in (req as any)) delete (req as any).data;
  }

  return event;
}

function scrubBreadcrumb(bc: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const category = (bc.category ?? "").toLowerCase();

  // Sentry RN categories vary; treat common network categories as in-scope.
  const isNetwork =
    category.includes("fetch") ||
    category.includes("xhr") ||
    category.includes("http");

  if (!isNetwork) return bc;

  const data = bc.data;
  if (data && isPlainObject(data)) {
    const scrubbed = scrubHeaders(data.headers);
    if (scrubbed) {
      bc.data = { ...data, headers: scrubbed };
    }
  }

  return bc;
}

export function initSentry(): void {
  const dsn = (env.EXPO_PUBLIC_SENTRY_DSN ?? "").trim();
  if (!dsn) return; // DSN-gated fail-closed

  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    beforeSend(event) {
      // scrubEvent preserves event shape; cast satisfies beforeSend's narrower return type
      return scrubEvent(event) as typeof event;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
  });
}
