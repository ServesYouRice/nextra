# Remaining Audit Work

Consolidated: 2026-07-17. Supersedes the `audits-codex/` and `audits-fable/` folders.

This is the single backlog for audit work that is **not** complete. Every
launch-blocking correctness and security finding from the original Codex and Fable
audits has been remediated in the current tree and verified against the code:
`npm test` passes **130 tests across 30 files, 0 failures** (2026-07-17), ESLint, the
scoped strict lifecycle type-check, the Vite production build, and the focused
coverage gate all pass.

What remains is (1) external gates that cannot be proven from repository contents,
(2) measurement work that must run on the target host, (3) browser/topology test
coverage that needs a real media runtime, and (4) deliberately deferred architecture
that is not justified without evidence or a new product target.

Codex IDs (R-*, T-*) and Fable IDs (D-*, P-*, T-*, N-*) are cross-referenced where
they describe the same work.

---

## 1. External release gates

These cannot be proven from repository contents. Repository support is complete;
completion requires an external action by the repository owner or a qualified
reviewer.

### R-01 — Provision and validate trusted Windows signing
*(Codex R-01, Fable D-9/R-01)*

The tagged release workflow validates required secrets, signs and timestamps
`Nextra.exe`, verifies Authenticode, and smoke-tests that exact signed artifact
without rebuilding. The repository owner must:

- configure the `SIGNING_PFX_BASE64` and `SIGNING_PFX_PASSWORD` GitHub secrets with a
  trusted publisher certificate,
- run a tagged build and confirm a valid Authenticode signature,
- verify the timestamp and publisher chain validate on a clean Windows machine, and
- confirm the exact signed artifact passes the packaged-artifact smoke suite.

### R-02 — Complete distribution legal review
*(Codex R-02, Fable R-02)*

LICENSE, dependency notices, corresponding-source instructions, and a generated
CycloneDX SBOM are packaged. A qualified reviewer must approve the final
distribution, dependency notices, source-offer process, and release wording.

---

## 2. Target-host measurement (measurement-gated, not defects)

The repository work is complete: `/api/metrics` exposes process CPU, mediasoup worker
resource usage, event-loop delay, memory, topology, and relay counters. A runnable
harness (`npm run benchmark:runtime`) and `docs/performance-benchmark.md` define the
topology matrix, three-run evidence requirement, and acceptance thresholds. What
remains is running the procedure on the target host and retaining its JSON evidence.

### R-03 — Establish the supported load envelope
*(Codex R-03, Fable P-1/N-17)*

Current conservative admission defaults are 10 rooms, 10 direct viewers per room, and
two simultaneous fallback pipelines — not measured capacity guarantees. Measure
concurrent rooms, direct viewers, WHEP sessions, fallback pipelines, total relay
bitrate, worker CPU, event-loop delay, memory, and handle counts under 1080p, 1440p,
and 4K traffic. Use the results to set and document supported limits. Add room-affine
mediasoup worker/router pooling **only if** the worker is shown to be the limiting
resource (threshold: 80% of one core) or worker-level failure isolation becomes a
product requirement.

### R-06 — Move relay work off the signaling event loop only if measured
*(Codex R-06, Fable P-2/N-18)*

RTP depacketization, H.264 parsing, fMP4 fanout, and viewer fanout currently share the
Node event loop with signaling, bounded by `MAX_FALLBACK_PIPELINES=2`. The runtime
harness measures end-to-end Socket.IO acknowledgement latency and refuses a run
without two rooms and two active fallback pipelines. Its default gate is zero
timeouts, ≤100 ms acknowledgement p95, ≤50 ms event-loop p95, and ≤200 ms event-loop
max. Move parsing/fanout to worker threads or a relay process **only if** profiling
attributes a breach of that threshold to relay JavaScript.

*P-7 (first fallback relay waited on an NVENC probe) is remediated: the probe now runs
asynchronously after worker init and its state/duration are exposed via
`fallbackRelay.nvencProbe` in `/readyz` and `/api/metrics`.*

---

## 3. Testing backlog

The current release gate passes ESLint, the Vite build, OSS preflight, both production
dependency audits, and the 130-test Node suite (including a real server/Socket.IO/
mediasoup composition gate). Linux CI runs `release:prep`; Windows CI repeats it,
builds and launches `Nextra.exe`, and polls `/readyz`. `release:prep` enforces focused
lifecycle coverage thresholds (currently 72.86% lines / 63.44% branches / 77.78%
functions; gate 70/60/75). The following coverage requires a browser or real external
topology and remains open.

### T-04 — Browser end-to-end media flow *(Codex T-02/T-05, Fable T-3/T-4)*

No browser-level test proves a host can create a room and a viewer can join and
receive decoded frames. Add Playwright coverage with deterministic fake media devices.
Cover host route unmount, capture-track end, concurrent Stop/unmount, pagehide/reload,
viewer leave/rejoin, producer replacement, stale-track removal, fallback overflow
recovery, and fMP4 generation cleanup. Keep fast UI lifecycle cases separate from
topology-specific real-media tests.

### T-05 — Real media-topology suite *(Codex T-05, Fable T-2/T-5)*

Separately verify LAN direct WebRTC, public direct WebRTC with announced addresses,
public H.264 fallback through a tunnel, disabled AV1 when direct media is unavailable,
TURN/server-candidate reachability, and ICE restart after network changes. Includes
observing actual FFmpeg and mediasoup child-process death/replacement under live media,
plus concurrent fallback-start demand and longer reconnect timing.

### T-01 — Remaining destructive server transitions *(Codex T-01, Fable T-1)*

`tests/serverIntegration.test.js` already covers create/join/retry/leave/disconnect,
delayed/lost acknowledgements, room replacement, origins/forwarded headers, combined
Socket.IO/WHEP caps, oversized-payload disconnect, rate limits, shutdown with active
rooms, and zero-resource cleanup. Still remaining: an authorized Cloudflare TURN mint
against an external provider, and killing a real worker subprocess while observing
readiness/process replacement.

### T-06 — Wire-level OBS validation *(Codex T-06)*

A deterministic in-process fake OBS transport covers delayed requests, protocol
rejection, disconnect cleanup, reordered responses, per-request deadlines, transaction
timeout, and reverse-order auto-configuration rollback with partial-failure reporting.
Still required: run the same scenarios through a **wire-level** fake OBS WebSocket
server and a supported OBS Studio version, including a disconnect during rollback, to
catch protocol/version behavior an in-process double cannot.

### T-07 — Long-running memory and churn suite *(Codex T-07)*

For 30–60 minutes, repeatedly create/destroy rooms, reconnect OBS, start/stop
fallback, and replace playback generations. Define and enforce stable bounds for heap
after GC, handles, child processes, transports, consumers, listeners, object URLs, and
log growth.

### T-08 — Browser media-flow CI gate *(Codex T-08, Fable D-7)*

The normal gate and the packaged/signed-artifact smoke suite are in place; CI still has
no browser lifecycle / decoded-frame media-flow gate. Add browser lifecycle and
decoded-frame coverage when a deterministic browser/media runtime is available in CI.

---

## 4. Deferred architecture and packaging (evidence- or target-gated)

Decision gates and evaluation artifacts are implemented; the larger architectures
remain deliberately unimplemented until evidence or a new product target justifies
them.

### R-05 — Continue lifecycle-controller extraction *(Codex R-05, Fable L-11/N-11/N-12)*

`RoomMediaPipeline` owns fallback startup generation, capacity release, DirectTransport
consumers, FFmpeg, startup/recovery timers, and reverse-order idempotent cleanup.
Client-side host/viewer session-controller hooks and a tested lifecycle controller own
their media resources. Remaining large modules still combine several state machines —
continue extracting controllers with explicit ownership, state transitions, and one
idempotent `close()`:

- `HostSession`: capture, browser transports/producers, recorder, heartbeat, OBS state
- extend `RoomMediaPipeline` ownership to the WHIP producers and ingest transport
- `ViewerSession`: consumer/track mappings, playback generation, retry/leave cleanup
- `SessionRegistry`: atomic WHIP/WHEP/socket reservations and room mappings
- `TunnelSupervisor`: process health, public URL, restart backoff, termination

This is a maintainability refactor, not a defect.

### D-5 / N-20 — Maintained packaging path

`Nextra.exe` uses the archived `caxa`. `npm run evaluate:packaging` verifies the pinned
packager and inputs and emits SEA/container acceptance gates;
`docs/packaging-evaluation.md` records why the smoke-tested Windows path is retained and
its reevaluation triggers. Re-run on those triggers or when another product target is
selected; Node SEA must be proven with mediasoup/native deps, assets, signing, startup
logging, and update behavior before migration.

### N-19 / N-21 — Multi-instance persistence and container deployment

`docs/service-deployment.md` documents a single-replica supervisor contract with
ephemeral-state, restart, backup, and rollback behavior. External session state, sticky
routing, and a Dockerfile/Compose bundle are withheld until a hosted multi-instance or
"server on a box" offering becomes a supported target (container networking, GPU/FFmpeg,
writable paths, and platform ownership must be designed together).

---

## 5. Conditional-posture and defense-in-depth notes (not blockers)

- **S-2 — Widened WHIP listener is plaintext by design.** The OBS-compatible WHIP side
  listener uses HTTP because OBS does not reliably accept the app's self-signed local
  cert. Default `WHIP_BIND_HOST=127.0.0.1` keeps the bearer token off the network.
  Non-loopback binds are refused unless `WHIP_ALLOW_INSECURE_REMOTE=1` acknowledges the
  risk and log a startup warning; an encrypted VPN/TLS reverse proxy is the documented
  supported remote-OBS posture. Optional future hardening: separate/rotate the WHIP
  credential from the host reclaim token.
- **S-10 — `FFMPEG_PATH` accepts a bare command for desktop convenience.** It is
  resolved to a canonical absolute path, inspected, and pinned once at startup;
  unattended deployments are documented to set an absolute trusted path.
- **L-10 — Relay backpressure reads Engine.IO's private `writeBuffer`.** Guarded by a
  compatibility test against the installed version and a one-time warning if the field
  changes. Prefer an application-owned byte counter or supported transport signal on a
  future Engine.IO upgrade.

---

## 6. Optional / roadmap (not defects)

UI code review found no open defect, but no interactive cross-browser, responsive
regression, screen-reader, keyboard-only, or contrast testing was performed. A formal
WCAG AA accessibility assessment remains a nice-to-have.

Remaining roadmap ideas (all optional): opt-in recording from the muxed relay outputs,
multiple presenters/screens per room, lightweight chat/reactions, viewer-selectable
quality/latency preferences, and internationalized copy.

*Fable N-1 through N-16 (room passphrase, host-session recovery, QR/quality detail,
restart signal, first-run guide, toast primitive, OBS copy affordances, host
diagnostics, component/controller extraction, `_ioRef` removal, structured logging,
`nut-js` documentation, and scoped `checkJs`) are all implemented in the current tree.*

---

## Recommended completion order

1. Satisfy the external signing and legal gates (R-01, R-02) for a public distribution.
2. Add browser lifecycle and decoded-frame media-flow coverage (T-04, T-08).
3. Run the documented target-host load procedure and retain its JSON evidence (R-03, R-06).
4. Add real child-process death/replacement and topology tests under live media (T-05).
5. Cover remaining destructive/external cases (T-01), wire-level OBS (T-06), and churn (T-07).
6. Re-run the packaging evaluation on its documented triggers or when a new product
   target is selected.

### Merge/release gates

- Blocker regression suites are required for merge.
- Source line/branch coverage thresholds exclude generated/vendor output and use higher
  thresholds for state machines and registries.
- Linux integration and the exact signed Windows artifact checks both pass.
- Dependency and cloudflared updates run through the media interoperability suite.
- The churn and load envelopes pass before a production release.
