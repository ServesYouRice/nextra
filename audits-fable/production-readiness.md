# Production Readiness — Deployment, Observability & Operations

Revalidated against the current remediation tree on 2026-07-16.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## Remaining deployment and operations findings

### D-3 🟡 Source/server-mode logging is unstructured

**Disposition (2026-07-15): Remediated for the current single-process deployment.** A small leveled logger now supports `LOG_LEVEL`, optional JSON output through `LOG_FORMAT=json`, and request correlation fields through async request context. Existing `console.*` call sites pass through this adapter, so packaged file logging and rotation remain the output adapter. A dedicated external log shipper remains a service-deployment choice.

The original finding was that source/server mode used `console.*` without consistent levels, structured fields, or request correlation. Those calls now pass through the logger adapter described above; external shipping remains deployment-specific.

**Impact.** This is an operations limitation for unattended service deployments, not a blocker for the intended desktop executable.

**Fix.** Introduce a small leveled logger with optional JSON output and correlation fields. Preserve packaged file logging as an adapter.

### D-4 🟢 No Prometheus/OpenMetrics export

**Disposition (2026-07-15): Remediated as an opt-in service feature.** `ENABLE_OPENMETRICS=true` exposes aggregate OpenMetrics at `/metrics`; startup configuration still defaults it off, and the endpoint refuses service unless `METRICS_TOKEN` is configured and supplied as a bearer token. It deliberately omits room codes and host socket identifiers.

`/api/metrics` remains the JSON source for the local Status page, while `/metrics` now provides the scrape-oriented aggregate exporter.

**Impact.** Optional service-deployment feature; not required for the desktop product.

**Fix.** Add a token-gated exporter only if unattended/service deployments need it.

### D-5 🟡 Windows-only binary distribution depends on archived `caxa`

**Disposition (2026-07-15): Evaluated and monitored; migration not currently justified.** Release preparation now runs `npm run evaluate:packaging`, which verifies the pinned packager and required inputs and emits the native/runtime constraints plus acceptance gates for SEA or a container. `docs/packaging-evaluation.md` records why the smoke-tested Windows path remains preferred and when the decision must be revisited.

The packaged artifact is Windows-only and uses `caxa`. The [upstream caxa repository](https://github.com/leafac/caxa) is archived and read-only. Node's current [Single Executable Applications documentation](https://nodejs.org/api/single-executable-applications.html) still labels SEA active development, so migration should be evaluated rather than assumed to be a drop-in replacement.

**Fix.** Keep the current reproducible Windows path while evaluating maintained alternatives. Add macOS/Linux artifacts or a container only when those become supported product targets.

### D-7 🟢 CI still lacks a browser media-flow gate

**Disposition (2026-07-16): Partially remediated.** The normal `npm test` gate boots the real server with a real mediasoup worker and exercises HTTP operations, metrics authorization, routing, Socket.IO admission, room throttling/capacity, transport replacement, production/consumption/resume, zero-resource cleanup, and graceful shutdown. Deterministic fallback allocation failures and client request/fMP4 lifecycles are also covered.

Linux runs `release:prep`; Windows repeats the gate, builds `Nextra.exe`, launches it, and polls `/readyz`. `release:prep` now enforces focused lifecycle coverage thresholds. CI still has no browser lifecycle/decoded-frame media-flow gate.

**Fix.** Add browser lifecycle and decoded-frame coverage when a deterministic browser/media runtime is available in CI.

### D-8 🟢 Existing secrets and workflow hygiene are strong

`.env`, TLS keys, signing material, binaries, and cloudflared executables are ignored. The OSS preflight scans tracked content. GitHub Actions are pinned to commit SHAs. The tagged workflow requires signing secrets, signs and timestamps `Nextra.exe`, verifies Authenticode, and emits a SHA-256 file.

Preserve these controls.

### D-9 🟢 The exact signed artifact is not smoke-tested after signing

**Disposition (2026-07-15): Remediated in workflow; first tagged run remains externally observable evidence.** The tagged workflow now runs the shared packaged-artifact smoke script after Authenticode signing without rebuilding. It checks readiness, the static application shell, a Socket.IO handshake, embedded license/notices/source/SBOM presence, the real graceful-shutdown path, and child-process cleanup. R-01 and R-02 remain external release gates.

Previously, Windows CI smoke-tested only an unsigned packaged executable. The tagged workflow now signs, verifies, and smoke-tests that exact artifact.

**Fix.** After signing, launch the same artifact on an ephemeral port, poll readiness, fetch static assets, connect Socket.IO, terminate gracefully, and verify packaged licenses/SBOM and child-process cleanup. Do not rebuild between signing and testing.

---

## External release gates

These cannot be proven from repository contents and must remain explicit before claiming a completed public signed release.

### R-01 — Provision and validate trusted Windows signing

**External action required; repository support complete.** The workflow validates required secrets, signs and timestamps the artifact, verifies Authenticode, and smoke-tests that exact signed binary. Completion evidence requires the repository owner to provision the credentials and run a tagged release.

The repository owner must configure `SIGNING_PFX_BASE64` and `SIGNING_PFX_PASSWORD`, then demonstrate a tagged build whose publisher chain and timestamp validate on a clean Windows machine.

### R-02 — Complete distribution legal review

**External action required; repository materials prepared.** The package contains the license, dependency notices, corresponding-source instructions, and generated SBOM. Only a qualified reviewer can approve the distribution.

The packaged license, dependency notices, corresponding-source instructions, SBOM, and release wording require approval by a qualified reviewer.

---

## Production-readiness verdict

| Deployment posture | Current assessment |
|---|---|
| Personal desktop/LAN or opt-in public sharing | No code blocker identified by the surviving audit findings. |
| Public signed Windows distribution | Conditional on R-01/R-02 and evidence from the first tagged signed run. |
| Unattended service | A documented single-replica supervisor contract, logging, and token-gated OpenMetrics are available; container distribution is not yet a supported target. |
| Multi-room or higher-load service | Establish the measured load envelope before raising conservative limits or prescribing a worker pool. |

No persistent business state exists to back up by design. A rollback/configuration recipe would be useful deployment documentation, but its absence is not retained as a Medium production defect.

## Recommended order

1. Satisfy the external signing and legal gates for a public distribution.
2. Add browser lifecycle and decoded-frame media-flow coverage.
3. Run the documented target-host load procedure and retain its JSON evidence.
4. Re-run the maintained packaging evaluation on its documented triggers or when another product target is selected.
