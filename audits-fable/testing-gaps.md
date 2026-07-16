# Testing Gaps

Revalidated against the current remediation tree on 2026-07-16. Missing tests are confidence gaps, not known production defects.

## Existing coverage

The current suite contains **30 test files and 130 passing tests**. `npm test` completed with 0 failures during this revalidation.

| Test area | Current coverage |
|---|---|
| Rooms/config/network/ports/TURN | Room lifecycle and reclaim, ICE/TURN shaping, trust helpers, free-port resolution |
| WHIP/WHEP | SDP parsing/answer construction, codec selection, origin behavior, selected route/session cleanup, parallel WHIP start ownership, and parallel WHEP capacity reservation |
| Media bytes | fMP4 fragment classification, H.264 RTP depacketization and parameter sets, Ogg/Opus muxing |
| FFmpeg | Argument construction, audio/video input shape, startup backlog calculations, bounded pre-start/stdin backpressure behavior, keyframe recovery signaling, restart-cap enforcement, and real Ogg/Opus acceptance when FFmpeg is available |
| Fallback ownership | `RoomMediaPipeline` reverse-order idempotent cleanup, generation invalidation, timer replacement, and allocation-by-allocation video/audio transport, consumer, and relay-start failure cleanup |
| OBS client | Request correlation, protocol errors, per-request/transaction deadlines, disconnect handling, rollback order and partial rollback failure |
| Viewer/client lifecycle | Socket request timeout/retry/rejection/disconnect/connect behavior; fMP4 generation replacement and listener/SourceBuffer/object-URL/timer cleanup; viewer transport recovery; OBS and playback decisions |
| Real server composition | Child-process startup with a real mediasoup worker; health/readiness, forwarded-client metrics denial, public-config redaction, JSON/OpenMetrics access, SPA/API routing, origin admission, room throttling/capacity, oversized-payload disconnect, transport replacement, production/consumption/resume, zero-resource teardown, and graceful shutdown |
| Worker recovery | Intentional-shutdown ignore, startup crash-loop exit, and stable-runtime restart decisions |
| Coverage gate | Focused lifecycle coverage enforced at 70% lines, 60% branches, and 75% functions through `npm run test:coverage` and `release:prep` |

The suite runs through `release:prep` in both Linux CI and the Windows package job. Windows CI also packages and launches `Nextra.exe`, then polls `/readyz`.

---

## Gaps

### T-1 🟢 Real `server.js` coverage does not exercise every destructive failure transition

- **Risk:** Low

`tests/serverIntegration.test.js` boots the real entry point in a child process with an ephemeral HTTP listener and real mediasoup worker. It covers health/readiness, public configuration redaction, local and forwarded-remote metrics policy, bearer-gated OpenMetrics, the unconfigured TURN-mint response, SPA/API routing, allowed and rejected Socket.IO origins, signaling throttles/admission, cleanup, and the real graceful-shutdown path.

The remaining cases are an authorized Cloudflare TURN mint against an external provider and killing a real worker subprocess while observing readiness/process replacement. Oversized Engine.IO payloads are now proven to disconnect, and the worker-death decision branches are covered as a pure policy module.

### T-2 🟡 Socket.IO media objects are covered without a browser DTLS/media path

- **Risk:** Medium

The real-composition test covers create, idempotent join, room-capacity and rate-limit rejection, send/receive transport creation and replacement, VP8 production, consumption, resume, viewer leave, host teardown, and zero active rooms/producers/consumers. This testing exposed and fixed stale active producer/consumer accounting on local mediasoup close. Separate tests protect Engine.IO backpressure compatibility, reload reclaim, and viewer transport recovery.

An actual browser DTLS connection with packets/decoded frames, concurrent fallback-start demand, and longer reconnect timing still require topology-specific tests. Client delayed/lost acknowledgement behavior is now deterministic at the request-helper boundary.

### T-3 🟡 React views and WebM playback remain without direct lifecycle tests

- **Risk:** Medium

`mediasoupClient.socketRequest` now has delayed/lost acknowledgement, application rejection, disconnect, delayed connect, endpoint-error, and listener-cleanup coverage. `fmp4RelayPlayer` now has a mocked MediaSource/SourceBuffer generation-replacement test that asserts listener, buffer, object-URL, socket-subscription, and timer cleanup.

`HostView`, `WatchView`, WebM queue/MediaSource behavior, pagehide/unmount concurrency, stale-track removal, and fallback overflow recovery remain best covered in a browser-capable environment.

### T-4 🟡 No browser end-to-end media flow

- **Risk:** Medium

There is no browser-level test proving that a host can create a room and a viewer can join and receive frames.

**Recommend.** Add Playwright coverage with deterministic fake media devices. Keep fast UI lifecycle cases separate from topology-specific real-media tests for LAN WebRTC, tunnel H.264 fallback, TURN reachability, WHEP, and network-change recovery.

### T-5 🟢 Real child-process restart behavior remains topology-dependent

- **Risk:** Low

`RoomMediaPipeline` now proves ownership, invalidation, timer replacement, and idempotent cleanup. Fallback tests inject failures at video transport, video consumer, audio transport, audio consumer, and relay start, asserting reverse-order cleanup and release of the global pipeline slot. OBS rollback paths are also substantially covered.

FFmpeg pre-start buffering, stdin backpressure/drop recovery, and restart-cap enforcement are deterministic. Worker death/crash-loop policy is covered. Parallel WHIP startup proves one synchronous owner and claim release after failure; parallel WHEP admission proves pending reservations enforce room capacity and are released on completion.

What remains is observation of actual FFmpeg and mediasoup child-process death/replacement with live media. That belongs with the real topology/browser benchmark rather than another mocked state-machine test.

### T-6 🟢 Focused lifecycle coverage gate

- **Risk:** Low

**Remediated.** `npm run test:coverage` uses Node's built-in coverage runner and enforces 70% line, 60% branch, and 75% function coverage across the selected fallback ownership, lifecycle controller, socket request, and fMP4 player modules. The current result is 72.86% lines, 63.44% branches, and 77.78% functions.

`release:prep` runs the gate in Linux and Windows CI. Expand the selected module set and raise thresholds only alongside meaningful lifecycle tests.

---

## Priority

1. Browser end-to-end frame delivery and view lifecycle (T-3/T-4).
2. Real child-process death/replacement under live media (T-5).
3. External TURN-provider and destructive readiness cases (T-1).
