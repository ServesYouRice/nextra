# Nice-to-Haves

Optional improvements revalidated against the current working tree on 2026-07-13.

---

## Product improvements

### N-1 Optional room passphrase or host approval

The room code is intentionally the viewer credential. An optional passphrase or approval lobby would support more sensitive streams without changing the default low-friction flow.

### N-2 Optional host-session recovery across a full reload

Socket reconnect can reclaim a room while the page remains alive, but `pagehide`/unmount intentionally closes the host session. A deliberate “resume after reload” mode would require persisting the room code/token and changing that teardown contract. Treat this as a product decision, not a missing one-line persistence fix.

### N-3 QR sharing and viewer connection-quality detail

The UI now explains waiting states and shows viewer counts. A QR code for the public watch link and per-viewer quality/transport detail would still improve mobile sharing and diagnosis.

### N-4 Graceful server shutdown/restart signal

Before intentional shutdown or worker-restart recovery, emit a short client event so viewers can distinguish a server restart from a generic connection failure.

### N-5 Guided first-run flow

Advanced settings are now disclosed, which reduces initial density. A small “Browser capture or OBS?” first-run flow or contextual links into the How-To page could further reduce onboarding friction.

### N-6 Consistent dismissible notifications

Recovery paths clear stale errors more reliably now, but feedback still uses several inline alert/status patterns. A compact toast/notification primitive would reduce layout shifts and standardize dismissal/timeout behavior.

### N-9 Copy affordances for manual OBS credentials

Room, local, public, and WHEP values already use `CopyField`. The manual OBS WHIP URL and bearer token remain good candidates for the same one-click pattern.

### N-10 Expand host stream-health diagnostics

The host already sees viewer counts, consumer count, relay bytes, codec, TURN/fallback state, and the Status page has broader runtime metrics. Consider surfacing fallback restart/error counts, dropped-chunk counts, and event-loop health when troubleshooting is enabled.

---

## Developer experience and maintainability

### N-11 Break up `HostView.jsx` and `WatchView.jsx`

They are currently about 1,900 and 1,400 lines and own many interdependent state atoms and cleanup paths. Extract lifecycle hooks/controllers and smaller panels around explicit `start`, `recover`, and idempotent `close` operations.

### N-12 Break the media-lifecycle module cycle

Lazy requires between room, socket, WHIP, and WHEP cleanup hide ownership. Extract a room-media lifecycle/controller module shared by route and signaling layers.

### N-13 Remove `registerSocketHandlers._ioRef`

`lib/socket.js` stores the Socket.IO server on a function property for fallback and metrics paths. Pass an explicit dependency/controller instead to improve testability and lifecycle ownership.

### N-14 Structured logging

Replace scattered `console.*` prefixes with a small leveled logger, optional JSON output, and room/session correlation. Preserve the packaged runtime's file rotation.

### N-15 Make the optional media-control backend explicit

`@nut-tree-fork/nut-js` is dynamically required but not declared; PowerShell/xdotool is the fallback. Either declare it as an optional dependency or document the OS fallback as the supported implementation. Remote media control is now correctly disabled server-wide by default.

### N-16 Type checking for JavaScript

The code has useful JSDoc but no `checkJs`/TypeScript gate. Incremental `// @ts-check` on pure modules and lifecycle controllers could catch shape/undefined errors without a full conversion.

---

## Architecture and packaging options

### N-17 Room-affine mediasoup worker pool, if load tests justify it

Measure the supported single-worker envelope first. If one worker is the limiting resource, assign independent rooms to a worker/router pool; rooms do not need cross-router consumption.

### N-18 Move relay work off the main thread, if thresholds are exceeded

Define acceptable signaling latency/event-loop delay, load-test the two-pipeline cap, and move depacketization/parsing/fanout to workers or a relay process only if needed.

### N-19 Persistence for a future multi-instance service

In-memory state is correct for the current desktop product. A hosted horizontally scaled offering would need external session state and sticky/room-aware routing.

### N-20 Evaluate a maintained executable packager

The current Windows packaging path is tested and signed, but [`caxa` is archived](https://github.com/leafac/caxa). Evaluate maintained alternatives without assuming Node SEA is already stable: the Node 20 documentation still marks SEA as [active development](https://nodejs.org/download/release/latest-v20.x/docs/api/single-executable-applications.html).

### N-21 Optional Docker deployment

A Dockerfile/Compose example with explicit UDP, reverse-proxy, and TURN guidance would help operators running Nextra on a server. It is not required for the packaged desktop use case.

---

## Future roadmap ideas

- opt-in recording;
- multiple simultaneous presenters/screens;
- room chat or reactions;
- viewer-selectable latency/quality preferences;
- Prometheus/OpenMetrics export;
- internationalization;
- a formal WCAG AA audit.
