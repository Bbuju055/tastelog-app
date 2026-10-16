// Phase 14.2B/E — k6 JSON aggregator.
//
// Reads the line-stream produced by `k6 run --out json=…`, groups
// http_req_duration points by the `endpoint` tag, and computes per-endpoint
// latency percentiles (p50/p95/p99/max), throughput, status-class
// breakdown, success/error/timeout counts. Totals are computed over the
// pooled duration values across all endpoints.
//
// Stdlib only (node:fs/promises, node:path, node:process). No npm deps.
// Output shape is documented in Phase 14.2E ROADMAP closeout and is
// suitable as evidence in later ROADMAP closeouts.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argv, exit, stdout } from "node:process";

const DURATION_METRIC = "http_req_duration";
const FAILED_METRIC = "http_req_failed";
const VUS_MAX_METRIC = "vus_max";
const VUS_METRIC = "vus";
const ENDPOINT_TAG = "endpoint";
const UNKNOWN_ENDPOINT = "unknown";

export async function aggregate(k6JsonPath) {
  if (typeof k6JsonPath !== "string" || k6JsonPath.trim() === "") {
    throw new Error("aggregate: k6JsonPath is required");
  }

  const absolutePath = resolve(k6JsonPath);

  let raw = "";
  try {
    raw = await readFile(absolutePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return buildEmptyReport({ inputPath: absolutePath, reason: "missing" });
    }
    throw err;
  }

  const parsed = collectPoints(raw);
  if (parsed.totalDurationPoints === 0) {
    return buildEmptyReport({
      inputPath: absolutePath,
      reason: "no-data",
      malformedLines: parsed.malformedLines,
    });
  }

  return buildReport(parsed, absolutePath);
}

// Linear interpolation between adjacent ranks. Index formula:
//   idx = (p/100) * (N-1)
// with result = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo).
// Matches numpy "linear" (default), pandas .quantile() default,
// Excel PERCENTILE.INC. Exported so callers can run percentile math
// directly and so unit tests can verify it in isolation.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  if (typeof p !== "number" || !Number.isFinite(p)) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pct = Math.max(0, Math.min(100, p));
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function collectPoints(raw) {
  const byEndpoint = new Map();
  let earliestMs = null;
  let latestMs = null;
  let totalDurationPoints = 0;
  let malformedLines = 0;
  let maxVus = 0;

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    if (!obj || obj.type !== "Point" || !obj.data) continue;
    const metric = obj.metric;
    const value = Number(obj.data.value);

    if (metric === VUS_MAX_METRIC || metric === VUS_METRIC) {
      if (Number.isFinite(value) && value > maxVus) maxVus = value;
      continue;
    }

    if (metric !== DURATION_METRIC && metric !== FAILED_METRIC) continue;

    const tags = obj.data.tags || {};
    const endpoint = tags[ENDPOINT_TAG] || UNKNOWN_ENDPOINT;
    const bucket = ensureBucket(byEndpoint, endpoint);

    const timeMs = parseIsoTime(obj.data.time);
    if (timeMs !== null) {
      if (earliestMs === null || timeMs < earliestMs) earliestMs = timeMs;
      if (latestMs === null || timeMs > latestMs) latestMs = timeMs;
    }

    if (metric === DURATION_METRIC) {
      if (Number.isFinite(value)) bucket.durations.push(value);
      const cls = classifyStatus(tags.status);
      bucket.statusClasses.set(cls, (bucket.statusClasses.get(cls) || 0) + 1);
      if (cls === "2xx" || cls === "3xx") bucket.success += 1;
      if (cls === "0") bucket.timeouts += 1;
      bucket.total += 1;
      totalDurationPoints += 1;
    } else if (metric === FAILED_METRIC) {
      if (Number.isFinite(value) && value === 1) bucket.failed += 1;
    }
  }

  return {
    byEndpoint,
    earliestMs,
    latestMs,
    totalDurationPoints,
    malformedLines,
    maxVus,
  };
}

function ensureBucket(map, endpoint) {
  let bucket = map.get(endpoint);
  if (!bucket) {
    bucket = {
      durations: [],
      success: 0,
      timeouts: 0,
      failed: 0,
      total: 0,
      statusClasses: new Map(),
    };
    map.set(endpoint, bucket);
  }
  return bucket;
}

function parseIsoTime(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function classifyStatus(status) {
  if (status === undefined || status === null || status === "") return "unknown";
  const n = Number(status);
  if (!Number.isFinite(n)) return "unknown";
  if (n === 0) return "0";
  if (n >= 200 && n < 300) return "2xx";
  if (n >= 300 && n < 400) return "3xx";
  if (n >= 400 && n < 500) return "4xx";
  if (n >= 500 && n < 600) return "5xx";
  return "other";
}

function buildReport(parsed, inputPath) {
  const {
    byEndpoint,
    earliestMs,
    latestMs,
    totalDurationPoints,
    malformedLines,
    maxVus,
  } = parsed;

  const startedIso = earliestMs !== null ? new Date(earliestMs).toISOString() : null;
  const finishedIso = latestMs !== null ? new Date(latestMs).toISOString() : null;
  const durationSec =
    earliestMs !== null && latestMs !== null
      ? Math.max(0, (latestMs - earliestMs) / 1000)
      : 0;

  const endpointNames = [...byEndpoint.keys()].sort();
  const endpoints = endpointNames.map((name) => {
    const b = byEndpoint.get(name);
    const errors = computeEndpointErrors(b);
    const throughput = durationSec > 0 ? b.total / durationSec : 0;
    return {
      name,
      requests: b.total,
      success: b.success,
      errors,
      timeouts: b.timeouts,
      p50_ms: round2(percentile(b.durations, 50)),
      p95_ms: round2(percentile(b.durations, 95)),
      p99_ms: round2(percentile(b.durations, 99)),
      max_ms: round2(maxOf(b.durations)),
      status_classes: sortedRecord(b.statusClasses),
      throughput_rps: round2(throughput),
    };
  });

  const pooledDurations = endpointNames.flatMap(
    (n) => byEndpoint.get(n).durations,
  );
  const totalSuccess = endpoints.reduce((s, e) => s + e.success, 0);
  const totalErrors = endpoints.reduce((s, e) => s + e.errors, 0);
  const totalTimeouts = endpoints.reduce((s, e) => s + e.timeouts, 0);

  return {
    run_id: null,
    started_at: startedIso,
    finished_at: finishedIso,
    target_env_name: null,
    scenario: null,
    concurrency_vus: maxVus,
    duration_sec: round2(durationSec),
    endpoints,
    totals: {
      requests: totalDurationPoints,
      success: totalSuccess,
      errors: totalErrors,
      timeouts: totalTimeouts,
      p50_ms: round2(percentile(pooledDurations, 50)),
      p95_ms: round2(percentile(pooledDurations, 95)),
      p99_ms: round2(percentile(pooledDurations, 99)),
      max_ms: round2(maxOf(pooledDurations)),
    },
    diagnostics: {
      reason: "computed",
      input_path: inputPath,
      malformed_lines: malformedLines,
    },
  };
}

// errors = max(non-2xx/3xx count, http_req_failed count). The floor
// semantics protect against undercounting when k6's failure detection
// surfaces something the status-class scan didn't (e.g. DNS resolution
// failures where tags.status is empty).
function computeEndpointErrors(bucket) {
  let nonSuccess = 0;
  for (const [cls, count] of bucket.statusClasses) {
    if (cls !== "2xx" && cls !== "3xx") nonSuccess += count;
  }
  return Math.max(nonSuccess, bucket.failed);
}

function sortedRecord(map) {
  const out = {};
  for (const key of [...map.keys()].sort()) {
    out[key] = map.get(key);
  }
  return out;
}

function maxOf(values) {
  let m = 0;
  for (const v of values) {
    if (v > m) m = v;
  }
  return m;
}

function round2(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function buildEmptyReport({ inputPath, reason, malformedLines = 0 }) {
  return {
    run_id: null,
    started_at: null,
    finished_at: null,
    target_env_name: null,
    scenario: null,
    concurrency_vus: 0,
    duration_sec: 0,
    endpoints: [],
    totals: {
      requests: 0,
      success: 0,
      errors: 0,
      timeouts: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      max_ms: 0,
    },
    diagnostics: {
      reason,
      input_path: inputPath,
      malformed_lines: malformedLines,
    },
  };
}

const isMain =
  typeof argv[1] === "string" && argv[1].endsWith("aggregate.mjs");

if (isMain) {
  const inputPath = argv[2];
  if (!inputPath) {
    stdout.write("usage: node loadtests/k6/aggregate.mjs <path-to-k6-json>\n");
    exit(1);
  }
  aggregate(inputPath)
    .then((report) => {
      stdout.write(JSON.stringify(report, null, 2) + "\n");
    })
    .catch((err) => {
      stdout.write(`aggregate failed: ${err.message}\n`);
      exit(1);
    });
}
