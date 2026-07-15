# Nice-to-Haves

Optional improvements revalidated against commit `2ba6c09` on 2026-07-14. These are product or maintainability choices, not current defects.

The bounded improvements that did not require a new product or deployment posture were implemented on 2026-07-15. N-11 and N-12 now have explicit component and host/viewer session-controller boundaries appropriate to the current architecture. N-17 through N-21 have reproducible decision gates or bounded deployment evaluation documentation; the larger architectures remain deliberately unimplemented without evidence or a new product target.

---

## Product improvements

### N-1 Optional room passphrase or host approval

**Implemented (2026-07-15).** Hosts may opt into a room passphrase without changing the room-code-only default. The server stores only a salted scrypt hash, Socket.IO viewers are prompted when protection is required, and WHEP requires the passphrase as a bearer credential. A host-approval lobby remains a possible alternative workflow rather than a second admission system.

The room code is intentionally the viewer credential. An optional passphrase or approval lobby would support sensitive streams without changing the default low-friction flow.

### N-2 Optional host-session recovery across a full reload

**Implemented (2026-07-15).** Hosts may opt into tab-scoped recovery using the existing cryptographic reclaim token and bounded reconnect grace. Reload no longer emits destructive `host-stopped` for opted-in rooms. OBS ingest remains attached; browser-capture rooms reclaim the code and require an explicit **Resume Sharing** action to reacquire capture and rebuild the send transport. Explicit stop or non-reload unmount still destroys the room.

**Original finding.** Socket reconnect could reclaim a room while the page remained alive, but full pagehide/unmount emitted `host-stopped` and destroyed the room.

The implemented opt-in flow now persists the credential only in tab session storage, preserves the bounded grace period, and defines browser-capture reacquisition and OBS behavior explicitly.

### N-3 QR sharing and viewer connection-quality detail

**Implemented (2026-07-15).** The host can expand a locally generated QR code for the preferred watch link, with no remote QR service involved. WebRTC viewers can expand a five-second connection-quality sample showing the qualitative state, round-trip time, jitter, and cumulative packet loss.

Add a locally generated QR code for the public watch link and optional per-viewer transport/quality diagnostics for mobile sharing and troubleshooting.

### N-4 Graceful server shutdown/restart signal

**Implemented (2026-07-15).** Intentional shutdown emits `server-restarting` before teardown, with a short flush window. The viewer distinguishes this state from a generic connection failure and communicates the expected reconnect delay.

Before intentional shutdown or worker-restart recovery, emit a short client event so viewers can distinguish a server restart from a generic connection failure.

### N-5 Guided first-run flow

**Implemented (2026-07-15).** A dismissible first-run host guide offers Browser capture or OBS, explains the distinction, and links to the full How-To. The choice is remembered locally so established users do not repeatedly see it.

Advanced settings are already disclosed progressively. A small “Browser capture or OBS?” first-run flow or contextual How-To links could reduce onboarding friction further.

### N-6 Consistent dismissible notifications

**Implemented as a reusable primitive (2026-07-15).** A notification provider now owns consistent tone, timeout, dismissal, and live-region behavior. Copy actions use it for success and clipboard-failure feedback; existing persistent operational alerts remain inline where their lifetime is tied to current state.

Feedback currently uses several inline alert/status patterns. A compact toast/notification primitive could standardize timeouts, dismissal, and layout behavior.

### N-9 Copy affordances for manual OBS credentials

**Implemented (2026-07-15).** Manual WHIP URL and bearer-token values now use the existing `CopyField` affordance.

Room, local, public, and WHEP values use `CopyField`; extend the same one-click affordance to the manual WHIP URL and bearer token.

### N-10 Expand host stream-health diagnostics

**Implemented (2026-07-15).** An optional troubleshooting panel surfaces fallback restart/error counts, oversized relay drops, cumulative FFmpeg input drops, and event-loop p95/max health. These are aggregate diagnostics and do not expose viewer identity.

The host already sees viewer/consumer counts, relay bytes, codec, TURN, and fallback state. Surface fallback restart/error counts, dropped-chunk counts, and event-loop health in an optional troubleshooting view.

---

## Developer experience and maintainability

### N-11 Break up `HostView.jsx` and `WatchView.jsx`

**Implemented for the current architecture (2026-07-15).** Room sharing/QR, host diagnostics, first-run guidance, and notifications are isolated components. Dedicated host and viewer session-controller hooks now own the concrete recorder, capture-stream, producer, transport, consumer, relay, player, media-source, queue, and teardown boundaries. `HostView.jsx` and `WatchView.jsx` remain the intentional orchestration layer for their interdependent UI state; further splitting would be a redesign rather than an unresolved bounded extraction.

Both large components own interdependent state atoms and cleanup paths. Extract lifecycle hooks/controllers and smaller settings, OBS, room-link, metrics, and viewer-control panels around explicit `start`, `recover`, `reset`, and idempotent `close` operations.

### N-12 Continue lifecycle-controller extraction

**Implemented for the current architecture (2026-07-15).** The tested lifecycle controller provides keyed ownership, replacement, reverse-order close, and idempotent teardown. Viewer quality sampling and both host/viewer session-controller hooks use it for timers, transports, media resources, relay subscriptions, and state reset. Server room/fallback ownership remains in `RoomMediaPipeline` and the explicit room lifecycle module, giving each current lifecycle domain a defined controller boundary.

`RoomMediaPipeline` now owns a substantial part of fallback startup and cleanup. Continue removing lazy/cyclic ownership across room, socket, WHIP, and WHEP modules, and extend explicit controllers to host, viewer, session-registry, and tunnel lifecycle.

### N-13 Remove `registerSocketHandlers._ioRef`

**Implemented (2026-07-15).** Socket lifecycle ownership now uses an explicit module-scoped active server reference that is cleared during cleanup; fallback callers may still pass the server dependency directly.

`lib/socket.js` stores the Socket.IO server on a function property for fallback and metrics paths. Pass an explicit dependency/controller instead to improve testability and lifecycle ownership.

### N-14 Structured logging

**Implemented (2026-07-15).** Server logs now pass through a leveled adapter with optional JSON output and async HTTP request correlation while preserving packaged file logging/rotation.

Replace ad-hoc `console.*` prefixes with a leveled logger supporting optional JSON and correlation fields. Keep packaged file logging as an output adapter.

### N-15 Clarify the optional `nut-js` dependency

**Implemented as documentation (2026-07-15).** The README identifies native Windows media keys and Linux `xdotool` as the supported defaults and `@nut-tree-fork/nut-js` as an optional dynamically detected integration. It is intentionally not added to the production dependency tree.

`@nut-tree-fork/nut-js` is loaded dynamically but is not declared in `package.json`, so PowerShell/xdotool is the normal fallback. Either declare it as an optional dependency or document the fallback as the supported default.

### N-16 Type-checking/JSDoc enforcement

**Implemented incrementally (2026-07-15).** `src/package.json` establishes an explicit ESM boundary, removing the Node test runner warning for `obsWebSocket.js`. A strict, scoped `checkJs` gate now covers the connection-quality, lifecycle-controller, and OpenMetrics modules and runs in `release:prep`; this creates an enforced expansion path without attempting a whole-application TypeScript migration.

Adopt incremental `// @ts-check`/`checkJs` or TypeScript for lifecycle/state-machine modules where object shape and nullable-resource errors are costly. Resolve the current Node test runner's `MODULE_TYPELESS_PACKAGE_JSON` warning for `src/lib/obsWebSocket.js` through an explicit module boundary; changing the whole CommonJS server package to ESM is not implied.

---

## Architecture and deployment options

### N-17 Measurement-gated mediasoup worker pool

**Disposition (2026-07-15): Decision gate implemented; pool not justified.** `scripts/benchmark-runtime.js` and `docs/performance-benchmark.md` define a repeatable topology procedure and an 80%-of-one-core worker threshold. The default envelope must be measured on target hardware. Room-affine pooling remains deferred unless the worker breaches first or worker-level failure isolation becomes a requirement.

Do not assume pooling is required solely because one worker is used. First establish the supported load envelope. If worker CPU or failure isolation is the constraint, assign each room to a worker/router and keep room media affine.

### N-18 Move relay work off the signaling event loop if measured

**Disposition (2026-07-15): Decision gate implemented; off-thread relay not justified.** The runtime harness measures real Socket.IO acknowledgement latency while `/api/metrics` supplies event-loop and relay topology counters. The two-pipeline test fails above 100 ms acknowledgement p95, 50 ms event-loop p95, or 200 ms event-loop max. Profiling must attribute a breach to relay JavaScript before adding IPC/lifecycle complexity.

Define an acceptable event-loop/signaling-latency threshold and test the two-pipeline worst case. Use worker threads or a relay process only if measurements justify the additional lifecycle and IPC complexity.

### N-19 Optional persistence for a future multi-instance product

**Disposition (2026-07-15): Explicitly deferred with a bounded service contract.** `docs/service-deployment.md` requires one replica and documents ephemeral state, restart, backup, and rollback behavior. Persistence is not added because no current business state needs it; multi-instance ownership and media affinity must be designed together if that product is commissioned.

In-memory state is correct for the current single-host application. A hosted multi-instance offering would require external session state, sticky routing, and a different operational model.

### N-20 Evaluate a maintained packaging path

**Disposition (2026-07-15): Evaluation artifact implemented; current path retained.** `npm run evaluate:packaging` inventories the pinned packager, native runtime dependency, required assets, migration acceptance criteria, and SEA/container dispositions. Release preparation runs it. `docs/packaging-evaluation.md` records the reevaluation triggers.

`caxa` is archived. Keep the verified Windows path while evaluating alternatives; Node SEA remains active development and must be proven with mediasoup/native dependencies, assets, signing, startup logging, and update behavior before migration.

### N-21 Containerized service deployment

**Disposition (2026-07-15): Bounded operator guidance added; container support deferred.** `docs/service-deployment.md` defines the safe single-replica supervisor posture and the networking/TURN/metrics/rollback contract. A Dockerfile/Compose bundle is intentionally withheld until container networking, GPU/FFmpeg, writable paths, and platform ownership become a supported target.

Provide a Dockerfile/Compose example with reverse-proxy and TURN guidance only if “server on a box” becomes an explicitly supported deployment target.

---

## Future roadmap ideas

- Opt-in recording using the existing muxed relay outputs.
- Multiple presenters or screens per room.
- Lightweight chat/reactions.
- Viewer-selectable quality/latency preferences.
- Prometheus/OpenMetrics export for service deployments.
- Internationalized copy.
- A formal WCAG AA accessibility assessment.
