# Deploy Topology (Production) — Record & Guardrail

> **Status:** record / reproducibility guardrail — **not** enforcement.
> The Railway dashboard is the current operational source for replica count; this
> repo doc records the **expected** production topology and rollback so the shape is
> discoverable from the repo and drift is noticeable. It does not set or enforce
> replica count.

## Why this file exists

Load testing confirmed a runtime-concurrency bottleneck and applied a remedy by
increasing the production Railway service from 1 → 2 same-region replicas. Replica count
on Railway is dashboard-owned and is **not** present in `railway.toml` (which sets only the
builder, `startCommand`, and healthcheck). That leaves the production replica topology
unrecoverable from the repo alone. This file closes that gap as a written record.

## Expected production topology (verified Session 73)

| Property              | Value                          |
|-----------------------|--------------------------------|
| Railway service       | `tastelog`                     |
| Plan tier             | Hobby                          |
| Region                | US East / `us-east4-eqdc4a`    |
| Replicas              | **2** (same-region)            |
| Per-replica resources | 8 vCPU / 8 GB (plan ceiling shown) |

Multi-region replicas require Railway Pro; Hobby supports same-region replicas only.

## Rollback

Railway dashboard → service `tastelog` → Replicas → **1**. Instant, no redeploy, no repo
impact. This reverts the remedy.

## Ownership & enforcement

- **Current operational source for the live replica count: the Railway dashboard.**
- This file is the **expected** topology of record. If the dashboard and this file diverge,
  treat that as drift to investigate — change the dashboard or this file deliberately, never
  silently.
- `railway.toml` carries only an **inert pointer comment** to this file. It does **not** set
  `numReplicas`.
- Making replica count **repo-enforced** (adding an active `numReplicas` key to `railway.toml`)
  would be a **behavior-changing config-as-code gate**: it would make the repo authoritative
  for replica count on the next deploy. That is intentionally **NOT** done here and would
  require its own approval plus post-deploy verification.

## Evidence

- Isolated 2-replica calibration artifact (gitignored, local):
  `loadtests/output/tier_a_cal_20260530T193304Z.agg.json` — 2529 req / 0 err / 0 timeout;
  aggregate p50/p95/p99/max = 471.43 / 1125.28 / 1583.80 / 1916.68 ms. Versus the 1-replica
  baseline `loadtests/output/tier_a_cal_20260530T184413Z.agg.json`: p50 −60% / p95 −53% /
  p99 −46%, throughput +125%.
- Production was **not** load-tested (by design); real-load validation moves to
  staged-rollout monitoring with stop/rollback criteria.
