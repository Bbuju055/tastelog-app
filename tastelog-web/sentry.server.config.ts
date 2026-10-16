import * as Sentry from "@sentry/nextjs";
import { env } from "@/lib/config";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function deleteIfPresent(obj: unknown, key: string): void {
  if (!isRecord(obj)) return;
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    delete obj[key];
  }
}

function scrubHeaders(headers: unknown): void {
  if (!isRecord(headers)) return;

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (typeof value !== "string") continue;

    const lk = key.toLowerCase();
    if (lk === "authorization" || lk === "cookie" || lk === "x-api-key") {
      headers[key] = "[redacted]";
    }
  }
}

function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  const req = event.request;

  if (isRecord(req)) {
    scrubHeaders(req.headers);
    deleteIfPresent(req, "data");
    deleteIfPresent(req, "cookies");
  }

  deleteIfPresent(event, "cookies");
  return event;
}

const dsn = env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    release: env.NEXT_PUBLIC_SENTRY_RELEASE,

    tracesSampleRate: 0,

    beforeSend: scrubEvent,
  });
}
