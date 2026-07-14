# Production Readiness — Deployment, Observability & Operations

Revalidated against commit `2ba6c09` on 2026-07-14.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## Remaining deployment and operations findings

### D-3 🟡 Source/server-mode logging is unstructured

The packaged runtime writes startup logs and prunes them to ten files, while verbose media logs are configurable. Source/server mode still uses `console.*` without consistent levels, structured fields, request/session correlation, or a general shipping/rotation story.

**Impact.** This is an operations limitation for unattended service deployments, not a blocker for the intended desktop executable.

**Fix.** Introduce a small leveled logger with optional JSON output and correlation fields. Preserve packaged file logging as an adapter.

### D-4 🟢 No Prometheus/OpenMetrics export

`/api/metrics` already provides JSON for the local Status page, including process memory, event-loop delay, room/resource counts, and relay counters. There is no scrape-oriented exporter.

**Impact.** Optional service-deployment feature; not required for the desktop product.

**Fix.** Add a token-gated exporter only if unattended/service deployments need it.

### D-5 🟡 Windows-only binary distribution depends on archived `caxa`

The packaged artifact is Windows-only and uses `caxa`. The [upstream caxa repository](https://github.com/leafac/caxa) is archived and read-only. Node's current [Single Executable Applications documentation](https://nodejs.org/api/single-executable-applications.html) still labels SEA active development, so migration should be evaluated rather than assumed to be a drop-in replacement.

**Fix.** Keep the current reproducible Windows path while evaluating maintained alternatives. Add macOS/Linux artifacts or a container only when those become supported product targets.

### D-7 🟢 CI has no coverage, server/signaling integration, or browser gate

Linux runs `release:prep`; Windows repeats the gate, builds `Nextra.exe`, launches it, and polls `/readyz`. CI does not yet run the suites described in `testing-gaps.md` T-1 through T-6.

**Fix.** Prioritize real server/Socket.IO and browser lifecycle tests, then add coverage reporting as a regression signal.

### D-8 🟢 Existing secrets and workflow hygiene are strong

`.env`, TLS keys, signing material, binaries, and cloudflared executables are ignored. The OSS preflight scans tracked content. GitHub Actions are pinned to commit SHAs. The tagged workflow requires signing secrets, signs and timestamps `Nextra.exe`, verifies Authenticode, and emits a SHA-256 file.

Preserve these controls.

### D-9 🟢 The exact signed artifact is not smoke-tested after signing

Windows CI smoke-tests an unsigned packaged executable. The tagged workflow packages, then signs and verifies the executable, but does not launch that post-signing artifact or exercise its embedded notices/SBOM/runtime behavior.

**Fix.** After signing, launch the same artifact on an ephemeral port, poll readiness, fetch static assets, connect Socket.IO, terminate gracefully, and verify packaged licenses/SBOM and child-process cleanup. Do not rebuild between signing and testing.

---

## External release gates

These cannot be proven from repository contents and must remain explicit before claiming a completed public signed release.

### R-01 — Provision and validate trusted Windows signing

The repository owner must configure `SIGNING_PFX_BASE64` and `SIGNING_PFX_PASSWORD`, then demonstrate a tagged build whose publisher chain and timestamp validate on a clean Windows machine.

### R-02 — Complete distribution legal review

The packaged license, dependency notices, corresponding-source instructions, SBOM, and release wording require approval by a qualified reviewer.

---

## Production-readiness verdict

| Deployment posture | Current assessment |
|---|---|
| Personal desktop/LAN or opt-in public sharing | No code blocker identified by the surviving audit findings. |
| Public signed Windows distribution | Conditional on R-01/R-02; add D-9 for stronger artifact confidence. |
| Unattended service | Add supervisor/configuration policy and operational logging/export as required. |
| Multi-room or higher-load service | Establish the measured load envelope before raising conservative limits or prescribing a worker pool. |

No persistent business state exists to back up by design. A rollback/configuration recipe would be useful deployment documentation, but its absence is not retained as a Medium production defect.

## Recommended order

1. Satisfy the external signing and legal gates for a public distribution.
2. Add server/Socket.IO and browser lifecycle coverage.
3. Measure the supported load envelope.
4. Harden non-loopback WHIP guidance.
5. Improve logging, metrics export, signed-artifact testing, and packaging portability as the deployment model requires.
