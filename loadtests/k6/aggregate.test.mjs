// Phase 14.2E-1 — deterministic unit tests for the k6 aggregator.
//
// Uses Node's built-in test runner (`node --test`). Stdlib only — no
// dependency install, no k6 binary, no network, no backend.
//
// Run with:
//   node --test loadtests/k6/aggregate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregate, percentile } from "./aggregate.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers — build k6-shaped JSONL synthetically. No k6 install.
// ---------------------------------------------------------------------------

function durationPoint({
  endpoint,
  value,
  status = "200",
  timeIso = "2026-01-01T00:00:00.000Z",
}) {
  return {
    type: "Point",
    metric: "http_req_duration",
    data: { time: timeIso, value, tags: { endpoint, status } },
  };
}

function failedPoint({
  endpoint,
  value,
  timeIso = "2026-01-01T00:00:00.000Z",
}) {
  return {
    type: "Point",
    metric: "http_req_failed",
    data: { time: timeIso, value, tags: { endpoint } },
  };
}

function vusMaxPoint({ value, timeIso = "2026-01-01T00:00:00.000Z" }) {
  return {
    type: "Point",
    metric: "vus_max",
    data: { time: timeIso, value, tags: {} },
  };
}

async function writeFixture(lines) {
  const dir = await mkdtemp(join(tmpdir(), "aggregate-test-"));
  const file = join(dir, "k6.json");
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  await writeFile(file, text + "\n", "utf-8");
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// percentile() — exposed for direct verification
// ---------------------------------------------------------------------------

test("percentile() lands exactly on rank boundaries when (N-1)*p/100 is integer", () => {
  // N=101 values 0..100. (N-1)*p/100 = p exactly for p in 0..100.
  const values = Array.from({ length: 101 }, (_, i) => i);
  assert.equal(percentile(values, 0), 0);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 99), 99);
  assert.equal(percentile(values, 100), 100);
});

test("percentile() linearly interpolates between adjacent ranks", () => {
  // N=5 [10, 20, 30, 40, 50]; idx = p/100 * 4.
  // p=25 → idx=1.0 → 20.   p=50 → idx=2.0 → 30.   p=75 → idx=3.0 → 40.
  assert.equal(percentile([10, 20, 30, 40, 50], 25), 20);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 75), 40);
  // Interior interpolation: p=12.5 → idx=0.5 → 10 + 0.5*(20-10) = 15.
  assert.equal(percentile([10, 20, 30, 40, 50], 12.5), 15);
});

test("percentile() sorts input internally (caller order irrelevant)", () => {
  assert.equal(percentile([50, 40, 30, 20, 10], 50), 30);
});

test("percentile() handles single-value array, empty array, and clamps p", () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([10, 20], -5), 10); // clamped to 0
  assert.equal(percentile([10, 20], 150), 20); // clamped to 100
});

// ---------------------------------------------------------------------------
// aggregate() — file lifecycle
// ---------------------------------------------------------------------------

test("aggregate() returns empty report with reason='missing' for ENOENT", async () => {
  const report = await aggregate("/nonexistent/path/k6.json");
  assert.equal(report.diagnostics.reason, "missing");
  assert.deepEqual(report.endpoints, []);
  assert.equal(report.totals.requests, 0);
  assert.equal(report.totals.p50_ms, 0);
});

test("aggregate() returns empty report with reason='no-data' for empty file", async () => {
  const { file, cleanup } = await writeFixture([]);
  try {
    const report = await aggregate(file);
    assert.equal(report.diagnostics.reason, "no-data");
    assert.equal(report.totals.requests, 0);
  } finally {
    await cleanup();
  }
});

test("aggregate() returns empty report with reason='no-data' when file has only non-duration points", async () => {
  // vus_max points only — no http_req_duration data → no-data.
  const { file, cleanup } = await writeFixture([vusMaxPoint({ value: 25 })]);
  try {
    const report = await aggregate(file);
    assert.equal(report.diagnostics.reason, "no-data");
    assert.equal(report.totals.requests, 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// aggregate() — grouping + math
// ---------------------------------------------------------------------------

test("aggregate() groups durations by endpoint tag and sorts alphabetically", async () => {
  const lines = [
    durationPoint({ endpoint: "recipesList", value: 100 }),
    durationPoint({ endpoint: "recipesList", value: 200 }),
    durationPoint({ endpoint: "recipesList", value: 300 }),
    durationPoint({ endpoint: "recipesList", value: 400 }),
    durationPoint({ endpoint: "recipesList", value: 500 }),
    durationPoint({ endpoint: "groceryLists", value: 10 }),
    durationPoint({ endpoint: "groceryLists", value: 20 }),
    durationPoint({ endpoint: "groceryLists", value: 30 }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.deepEqual(
      report.endpoints.map((e) => e.name),
      ["groceryLists", "recipesList"],
    );
    const grocery = report.endpoints.find((e) => e.name === "groceryLists");
    const recipes = report.endpoints.find((e) => e.name === "recipesList");
    assert.equal(grocery.requests, 3);
    assert.equal(grocery.max_ms, 30);
    assert.equal(grocery.p50_ms, 20);
    assert.equal(recipes.requests, 5);
    assert.equal(recipes.max_ms, 500);
    assert.equal(recipes.p50_ms, 300); // idx = 2.0 → sorted[2] = 300
    assert.equal(recipes.p95_ms, 480); // idx = 3.8 → 400 + 0.8*100 = 480
  } finally {
    await cleanup();
  }
});

test("aggregate() pools totals across endpoints", async () => {
  const lines = [
    durationPoint({ endpoint: "a", value: 100 }),
    durationPoint({ endpoint: "b", value: 200 }),
    durationPoint({ endpoint: "a", value: 300 }),
    durationPoint({ endpoint: "b", value: 400 }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.totals.requests, 4);
    assert.equal(report.totals.max_ms, 400);
    // Pooled sorted [100, 200, 300, 400], p50 idx=1.5 → 200 + 0.5*100 = 250.
    assert.equal(report.totals.p50_ms, 250);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// aggregate() — error / timeout / status-class classification
// ---------------------------------------------------------------------------

test("aggregate() classifies status codes into 2xx/3xx/4xx/5xx/0 buckets", async () => {
  const lines = [
    durationPoint({ endpoint: "x", value: 100, status: "200" }),
    durationPoint({ endpoint: "x", value: 110, status: "201" }),
    durationPoint({ endpoint: "x", value: 120, status: "301" }),
    durationPoint({ endpoint: "x", value: 130, status: "404" }),
    durationPoint({ endpoint: "x", value: 140, status: "503" }),
    durationPoint({ endpoint: "x", value: 150, status: "0" }), // timeout / connect fail
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    const ep = report.endpoints[0];
    assert.deepEqual(ep.status_classes, {
      "0": 1,
      "2xx": 2,
      "3xx": 1,
      "4xx": 1,
      "5xx": 1,
    });
    assert.equal(ep.requests, 6);
    assert.equal(ep.success, 3); // 2xx + 3xx
    assert.equal(ep.timeouts, 1); // status === 0
    // errors = non-2xx/3xx = 4xx(1) + 5xx(1) + 0(1) = 3
    assert.equal(ep.errors, 3);
  } finally {
    await cleanup();
  }
});

test("aggregate() uses http_req_failed count as a floor on errors", async () => {
  // 2 duration points, both with status 200 → status-derived errors = 0.
  // But http_req_failed reports 2 failures (e.g. DNS-level) → errors must
  // reflect that floor.
  const lines = [
    durationPoint({ endpoint: "x", value: 100, status: "200" }),
    durationPoint({ endpoint: "x", value: 200, status: "200" }),
    failedPoint({ endpoint: "x", value: 1 }),
    failedPoint({ endpoint: "x", value: 1 }),
    failedPoint({ endpoint: "x", value: 0 }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    const ep = report.endpoints[0];
    assert.equal(ep.requests, 2);
    assert.equal(ep.success, 2);
    // failed=2 > non-success=0 → errors=2 (floor).
    assert.equal(ep.errors, 2);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// aggregate() — timing window + throughput + concurrency
// ---------------------------------------------------------------------------

test("aggregate() computes duration_sec + throughput from ISO timestamps", async () => {
  const lines = [
    durationPoint({
      endpoint: "x",
      value: 100,
      timeIso: "2026-01-01T00:00:00.000Z",
    }),
    durationPoint({
      endpoint: "x",
      value: 200,
      timeIso: "2026-01-01T00:00:10.000Z",
    }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.started_at, "2026-01-01T00:00:00.000Z");
    assert.equal(report.finished_at, "2026-01-01T00:00:10.000Z");
    assert.equal(report.duration_sec, 10);
    // 2 requests / 10s = 0.2 rps
    assert.equal(report.endpoints[0].throughput_rps, 0.2);
  } finally {
    await cleanup();
  }
});

test("aggregate() extracts concurrency_vus from vus_max Points", async () => {
  const lines = [
    vusMaxPoint({ value: 10 }),
    vusMaxPoint({ value: 25 }),
    vusMaxPoint({ value: 20 }),
    durationPoint({ endpoint: "x", value: 100 }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.concurrency_vus, 25);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// aggregate() — defensive parsing
// ---------------------------------------------------------------------------

test("aggregate() counts malformed JSONL lines in diagnostics and skips them", async () => {
  const lines = [
    JSON.stringify(durationPoint({ endpoint: "x", value: 100 })),
    "not json at all",
    JSON.stringify(durationPoint({ endpoint: "x", value: 200 })),
    "{broken",
    "",
    "   ",
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.diagnostics.malformed_lines, 2);
    assert.equal(report.totals.requests, 2);
    assert.equal(report.endpoints[0].name, "x");
  } finally {
    await cleanup();
  }
});

test("aggregate() ignores Metric definition lines + other non-Point shapes", async () => {
  const lines = [
    { type: "Metric", metric: "http_req_duration", data: { name: "http_req_duration", type: "trend" } },
    durationPoint({ endpoint: "x", value: 100 }),
    durationPoint({ endpoint: "x", value: 200 }),
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.endpoints[0].requests, 2);
    assert.equal(report.totals.requests, 2);
  } finally {
    await cleanup();
  }
});

test("aggregate() routes untagged durations to 'unknown' endpoint bucket", async () => {
  const lines = [
    {
      type: "Point",
      metric: "http_req_duration",
      data: { time: "2026-01-01T00:00:00.000Z", value: 100, tags: {} },
    },
  ];
  const { file, cleanup } = await writeFixture(lines);
  try {
    const report = await aggregate(file);
    assert.equal(report.endpoints[0].name, "unknown");
    assert.equal(report.endpoints[0].requests, 1);
  } finally {
    await cleanup();
  }
});
