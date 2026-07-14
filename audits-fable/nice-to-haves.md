# Nice-to-Haves

Optional improvements revalidated against commit `2ba6c09` on 2026-07-14. These are product or maintainability choices, not current defects.

---

## Product improvements

### N-1 Optional room passphrase or host approval

The room code is intentionally the viewer credential. An optional passphrase or approval lobby would support sensitive streams without changing the default low-friction flow.

### N-2 Optional host-session recovery across a full reload

Socket reconnect can reclaim a room while the page remains alive. Full pagehide/unmount currently emits `host-stopped` and intentionally destroys the room, so persisting the room code/token alone is insufficient.

A deliberate resume-after-reload feature would need to persist the credential **and** change teardown to leave the room reclaimable for a bounded grace period. It should also define browser-capture reacquisition and OBS-session behavior. Treat this as a product/lifecycle decision, not a one-line storage fix.

### N-3 QR sharing and viewer connection-quality detail

Add a locally generated QR code for the public watch link and optional per-viewer transport/quality diagnostics for mobile sharing and troubleshooting.

### N-4 Graceful server shutdown/restart signal

Before intentional shutdown or worker-restart recovery, emit a short client event so viewers can distinguish a server restart from a generic connection failure.

### N-5 Guided first-run flow

Advanced settings are already disclosed progressively. A small “Browser capture or OBS?” first-run flow or contextual How-To links could reduce onboarding friction further.

### N-6 Consistent dismissible notifications

Feedback currently uses several inline alert/status patterns. A compact toast/notification primitive could standardize timeouts, dismissal, and layout behavior.

### N-9 Copy affordances for manual OBS credentials

Room, local, public, and WHEP values use `CopyField`; extend the same one-click affordance to the manual WHIP URL and bearer token.

### N-10 Expand host stream-health diagnostics

The host already sees viewer/consumer counts, relay bytes, codec, TURN, and fallback state. Surface fallback restart/error counts, dropped-chunk counts, and event-loop health in an optional troubleshooting view.

---

## Developer experience and maintainability

### N-11 Break up `HostView.jsx` and `WatchView.jsx`

Both large components own interdependent state atoms and cleanup paths. Extract lifecycle hooks/controllers and smaller settings, OBS, room-link, metrics, and viewer-control panels around explicit `start`, `recover`, `reset`, and idempotent `close` operations.

### N-12 Continue lifecycle-controller extraction

`RoomMediaPipeline` now owns a substantial part of fallback startup and cleanup. Continue removing lazy/cyclic ownership across room, socket, WHIP, and WHEP modules, and extend explicit controllers to host, viewer, session-registry, and tunnel lifecycle.

### N-13 Remove `registerSocketHandlers._ioRef`

`lib/socket.js` stores the Socket.IO server on a function property for fallback and metrics paths. Pass an explicit dependency/controller instead to improve testability and lifecycle ownership.

### N-14 Structured logging

Replace ad-hoc `console.*` prefixes with a leveled logger supporting optional JSON and correlation fields. Keep packaged file logging as an output adapter.

### N-15 Clarify the optional `nut-js` dependency

`@nut-tree-fork/nut-js` is loaded dynamically but is not declared in `package.json`, so PowerShell/xdotool is the normal fallback. Either declare it as an optional dependency or document the fallback as the supported default.

### N-16 Type-checking/JSDoc enforcement

Adopt incremental `// @ts-check`/`checkJs` or TypeScript for lifecycle/state-machine modules where object shape and nullable-resource errors are costly. Resolve the current Node test runner's `MODULE_TYPELESS_PACKAGE_JSON` warning for `src/lib/obsWebSocket.js` through an explicit module boundary; changing the whole CommonJS server package to ESM is not implied.

---

## Architecture and deployment options

### N-17 Measurement-gated mediasoup worker pool

Do not assume pooling is required solely because one worker is used. First establish the supported load envelope. If worker CPU or failure isolation is the constraint, assign each room to a worker/router and keep room media affine.

### N-18 Move relay work off the signaling event loop if measured

Define an acceptable event-loop/signaling-latency threshold and test the two-pipeline worst case. Use worker threads or a relay process only if measurements justify the additional lifecycle and IPC complexity.

### N-19 Optional persistence for a future multi-instance product

In-memory state is correct for the current single-host application. A hosted multi-instance offering would require external session state, sticky routing, and a different operational model.

### N-20 Evaluate a maintained packaging path

`caxa` is archived. Keep the verified Windows path while evaluating alternatives; Node SEA remains active development and must be proven with mediasoup/native dependencies, assets, signing, startup logging, and update behavior before migration.

### N-21 Containerized service deployment

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
