# Production Readiness — Deployment, Observability & Operations

Revalidated against the current working tree on 2026-07-13.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## Remaining deployment and operations findings

### D-3 🟡 Server-mode logging is unstructured

The packaged runtime writes and rotates startup logs, and verbose media logs are configurable. Source/server mode still uses `console.*` without consistent levels, structured fields, request/session correlation, or a general rotation/shipping story.

**Fix:** Introduce a small leveled logger with optional JSON output and correlation fields. Preserve the packaged log sink as an adapter.

### D-4 🟡 No Prometheus/OpenMetrics export

`/api/metrics` provides useful JSON to the local Status page, including process memory, event-loop delay, room counts, consumer counts, and relay counters. There is no scrape-oriented Prometheus/OpenMetrics endpoint for operators running Nextra as a service.

**Fix:** Add an optional token-gated exporter only if service deployments need it. This is not required for the desktop product.

### D-5 🟡 Distribution remains Windows-only and depends on archived `caxa`

The binary distribution is Windows-only and uses `caxa`, whose [upstream repository is archived](https://github.com/leafac/caxa). A migration should be evaluated, but Node 20 Single Executable Applications are still marked [active development](https://nodejs.org/download/release/latest-v20.x/docs/api/single-executable-applications.html).

**Fix:** Keep the current reproducible packaging path while evaluating maintained alternatives. Add macOS/Linux artifacts or a container only if those become supported product targets.

### D-7 🟢 CI has no coverage or browser/integration gate

Linux runs the release gate and Windows builds and launches the packaged executable, polling `/readyz`. CI has no coverage threshold, Socket.IO/server integration suite, or browser end-to-end media test.

**Fix:** Prioritize critical-path integration and browser lifecycle tests, then add coverage reporting as a regression signal. See `testing-gaps.md`.

### D-8 🟢 Existing secrets and release hygiene are strong

`.env`, TLS keys, and binary artifacts are excluded; the OSS preflight scans tracked content; dependencies and GitHub Actions are pinned/updated; the Windows release workflow signs the exact release artifact. Preserve these controls.

---

## Current production-readiness verdict

No unresolved launch blocker from the original Fable audit remains reproducible in the current tree.

| Deployment posture | Current assessment |
|---|---|
| Personal/LAN or opt-in public sharing from one desktop | No blocker identified by the surviving Fable findings. |
| Unattended service | Add operational logging/export as needed and run under the documented supervisor/restart policy. |
| Multi-room/high-load service | Establish the measured load envelope in `performance-issues.md` before raising conservative limits or adding a worker pool. |

The largest residual confidence gap is automated integration/browser/fault-injection coverage, not a known Tier-0 correctness or security defect.

## Recommended remaining order

1. Add server/Socket.IO integration and browser lifecycle coverage (`testing-gaps.md`).
2. Measure the supported load envelope (`performance-issues.md` P-1/P-2).
3. Harden non-loopback WHIP deployment guidance (`security-issues.md` S-2).
4. Address lifecycle/module ownership and Engine.IO compatibility hardening (`logical-issues.md`).
5. Improve structured logging, metrics export, and packaging portability if the deployment model requires them.
