# Performance & Scalability Issues

Revalidated against commit `2ba6c09` on 2026-07-14.

Nextra targets one desktop process with conservative defaults: 10 rooms, 10 direct viewers per room, and at most two fallback pipelines. These findings describe unmeasured capacity boundaries, not demonstrated launch blockers.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## P-1 🟡 The supported single-worker capacity is not measured

- **Severity:** Medium at scale; informational for the intended small desktop posture
- **Blocker:** No
- **Location:** `lib/mediasoup.js` creates one worker and one router

**Observation.** All WebRTC rooms share one mediasoup worker. The repository has no load evidence showing which combinations of the 10-room and 10-viewer admission limits meet an explicit CPU, latency, jitter, and packet-loss target.

**Risk.** Sufficient load can saturate the worker's CPU core and affect every room, but the current audit has no evidence that practical capacity is below the configured defaults.

**Action.** Benchmark the supported load envelope using worker CPU and the existing process/event-loop metrics. Add room-affine worker/router pooling only if measurements show the worker is the limiting resource or worker-level failure isolation becomes a product requirement.

**Repository work complete; target-host evidence pending.** `/api/metrics` now includes cumulative process CPU counters and mediasoup worker resource usage alongside event-loop delay, memory, topology, and relay counters. The checked benchmark harness asserts the required room/fallback topology and applies documented thresholds. Establishing a supported load envelope still requires benchmark runs on the target host; no worker-pool architecture change is justified until those results exist.

The runnable procedure is `npm run benchmark:runtime`; `docs/performance-benchmark.md` defines the topology matrix, three-run evidence requirement, and acceptance thresholds.

---

## P-2 🟡 Relay processing shares the signaling event loop

- **Severity:** Medium, measurement-dependent
- **Blocker:** No
- **Location:** RTP delivery/depacketization and relay callbacks in `lib/socket.js`; H.264 and fMP4 helpers in `lib/`

**Observation.** Each active OBS fallback pipeline delivers RTP to JavaScript, depacketizes H.264, feeds FFmpeg, parses fMP4 output, and fans fragments out from the same Node event loop that handles signaling. `MAX_FALLBACK_PIPELINES=2` bounds simultaneous pipelines, but no benchmark demonstrates the signaling-latency margin at the supported 1080p, 1440p, and 4K profiles.

**Action.** Measure event-loop delay and request/acknowledgement latency under the two-pipeline worst case. Move depacketization, parsing, or fanout to worker threads/a relay process only if a defined threshold is exceeded.

**Repository work complete; target-host evidence pending.** The runtime harness measures end-to-end Socket.IO acknowledgement latency and refuses a P-2 run unless the required two rooms and two active fallback pipelines are present. Moving relay work off-thread remains measurement-gated.

The runtime harness supplies that acknowledgement measurement. Its default gate is zero timeouts, at most 100 ms p95 acknowledgement latency, 50 ms event-loop p95, and 200 ms event-loop max during the two-pipeline run.

---

## P-7 🟢 The first fallback relay waits for an NVENC probe

- **Severity:** Low
- **Blocker:** No
- **Location:** `probeNvenc` in `lib/ffmpegRelay.js`

**Problem.** The first fallback relay runs a real one-frame FFmpeg/NVENC encode probe. Its result is cached, but a hung or unusually slow FFmpeg can delay that first relay by up to the five-second probe timeout.

**Fix.** Warm the cached probe during startup or expose its state in readiness/diagnostics so the first fallback viewer does not pay the cold-start cost.

**Remediated.** The cached probe is now started asynchronously after the media worker initializes. Its state and duration are exposed as `fallbackRelay.nvencProbe` in `/readyz` and `/api/metrics`; probe completion is deliberately not a readiness gate because libx264 remains the supported fallback.

---

## Revalidation disposition

- Per-viewer relay fanout and buffer inspection are bounded by current viewer limits and backpressure controls. No defect is established without profiling.
- Frame-rate sampling is a fallback path; the normal host flow supplies a valid frame rate. Its possible three-second ceiling is not a Medium production issue.
- The five-second metrics sweep is negligible at the current bounded room/viewer counts absent contrary measurements.
- Large React view components are primarily a maintainability concern and belong in `nice-to-haves.md`.

## Current priority

Measure first. P-1 and P-2 should trigger architecture work only when data or a new deployment target justifies it. P-7 is a small cold-start optimization.
