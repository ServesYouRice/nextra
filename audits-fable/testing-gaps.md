# Testing Gaps

Revalidated against the current working tree on 2026-07-13. This file describes missing confidence, not known production defects.

## Existing coverage

The 15 Node test files currently contain 82 passing tests and provide a solid unit foundation for:

- room, configuration, network, port, and TURN helpers;
- WHIP/WHEP SDP and selected route behavior;
- fMP4/H.264 parsing and depacketization;
- FFmpeg argument construction and basic relay state;
- one viewer transport-recovery branch;
- pure client decision modules for OBS output and playback-mode selection.

The suite runs in the Linux and Windows CI jobs before build/package checks.

---

## Gaps

### T-1 🟠 No integration tests for `server.js`

- **Risk:** High

There is no test that boots the real server composition and exercises HTTP routing, origin/trust composition, Socket.IO admission, metrics authorization, health/readiness transitions, SPA/API 404 behavior, or shutdown. Pure network helpers and individual WHIP routes are tested, but that does not verify how `server.js` wires them together.

**Recommend:** Make startup injectable/exportable, bind an ephemeral port, and add HTTP tests for the public configuration shape, local/remote metrics access, health/readiness, trust/origin cases, payload/rate limits, and unknown API routes.

### T-2 🟠 No Socket.IO signaling integration suite

- **Risk:** High

`lib/socket.js` owns room creation/join/retry/leave, transport creation, production/consumption, relay demand, fallback startup, reclaim, and disconnect cleanup. Only `handleViewerTransportFailure` is directly unit-tested.

**Recommend:** Use a real `socket.io-client` against an ephemeral test server with injectable mediasoup/FFmpeg adapters. Cover duplicate acknowledgements, idempotent join, concurrent fallback starts, transport replacement, reclaim within grace, leave/disconnect, and resource cleanup after injected failures.

### T-3 🟠 No React component, retry-helper, or MSE-player tests

- **Risk:** High

The complex client surfaces remain untested: `HostView`, `WatchView`, `mediasoupClient.socketRequest`, `fmp4RelayPlayer`, and the WebM relay queue/lifecycle.

**Recommend:** Test the retry helper with delayed/lost acknowledgements; test fMP4 generation cleanup with mocked `MediaSource`/`SourceBuffer`; add component tests for join guards, unmount/pagehide cleanup, reconnect, producer replacement, and fallback overflow recovery.

### T-4 🟡 No end-to-end browser test of a media flow

- **Risk:** Medium

There is no browser-level test proving that a host can create a room and a viewer can join and receive media.

**Recommend:** Add a Playwright (or equivalent) suite with deterministic fake media devices. Keep topology-specific real-media tests separate from fast UI lifecycle tests.

### T-5 🟡 Limited failure injection for FFmpeg, mediasoup, WHIP, and WHEP lifecycles

- **Risk:** Medium

Current FFmpeg tests focus on arguments and simple state. They do not inject a failure after each fallback allocation, exercise restart-budget/backpressure behavior, or prove every timer/transport/consumer/process is released. Worker-death restart behavior and concurrent WHIP/WHEP admission/teardown also lack race-focused tests.

**Recommend:** Add deterministic allocation-by-allocation failure tests and parallel admission tests. Assert zero remaining children, transports, consumers, timers, listeners, reservations, and buffered bytes after each case.

### T-6 🟢 No coverage reporting or threshold

- **Risk:** Low

CI runs the tests but does not publish coverage or enforce a floor.

**Recommend:** Add coverage reporting after the higher-value integration tests exist. Use focused thresholds for lifecycle/state-machine modules rather than optimizing a repository-wide percentage first.

---

## Priority

T-1 and T-2 provide the highest value because they verify the real server composition and signaling lifecycle. T-3 and T-5 protect the most stateful cleanup paths. T-4 adds product-level confidence; T-6 should follow meaningful coverage expansion.
