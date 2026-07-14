# Testing Gaps

Revalidated against commit `2ba6c09` on 2026-07-14. Missing tests are confidence gaps, not known production defects.

## Existing coverage

The current suite contains **19 test files and 97 passing tests**. `npm test` completed with 0 failures during this revalidation.

| Test area | Current coverage |
|---|---|
| Rooms/config/network/ports/TURN | Room lifecycle and reclaim, ICE/TURN shaping, trust helpers, free-port resolution |
| WHIP/WHEP | SDP parsing/answer construction, codec selection, origin behavior, selected route/session cleanup |
| Media bytes | fMP4 fragment classification, H.264 RTP depacketization and parameter sets, Ogg/Opus muxing |
| FFmpeg | Argument construction, audio/video input shape, startup backlog calculations, real Ogg/Opus acceptance when FFmpeg is available |
| Fallback ownership | `RoomMediaPipeline` reverse-order idempotent cleanup, generation invalidation, timer replacement |
| OBS client | Request correlation, protocol errors, per-request/transaction deadlines, disconnect handling, rollback order and partial rollback failure |
| Viewer/client decisions | One server-side viewer transport-recovery branch, OBS output-model decisions, playback-mode decisions |

The suite runs through `release:prep` in both Linux CI and the Windows package job. Windows CI also packages and launches `Nextra.exe`, then polls `/readyz`.

---

## Gaps

### T-1 🟠 No integration suite for the real `server.js` composition

- **Risk:** High

No test boots the exported/real server composition on an ephemeral port and exercises HTTP routing, origin/trust composition, Socket.IO admission, metrics authorization/redaction, health/readiness transitions, payload/rate limits, SPA/API 404 behavior, or graceful shutdown with active resources.

**Recommend.** Make startup injectable/exportable and add real HTTP tests for public configuration, local/remote metrics access, TURN-mint authorization, health/readiness, trusted proxy cases, payload limits, and unknown API routes.

### T-2 🟠 No Socket.IO signaling integration suite

- **Risk:** High

`lib/socket.js` owns create/join/retry/leave, transport creation, production/consumption, relay demand, fallback startup, reclaim, and disconnect cleanup. Only a narrow viewer transport-failure helper is directly exercised.

**Recommend.** Run `socket.io-client` against an ephemeral server with injectable mediasoup/FFmpeg adapters. Cover duplicate or delayed acknowledgements, idempotent join, concurrent fallback starts, transport replacement, reclaim within grace, leave/disconnect, room replacement, capacity/rate limits, and zero-resource cleanup after failures.

### T-3 🟠 No React component, retry-helper, or MSE-player lifecycle suite

- **Risk:** High

The OBS WebSocket helper and pure decision modules now have useful tests. The remaining complex client surfaces are still untested: `HostView`, `WatchView`, `mediasoupClient.socketRequest`, `fmp4RelayPlayer`, WebM queue/MediaSource behavior, pagehide/unmount cleanup, and playback generation replacement.

**Recommend.** Test the retry helper with delayed/lost acknowledgements; mock `MediaSource`/`SourceBuffer` for fMP4 and WebM generation cleanup; add component tests for join guards, Stop/unmount concurrency, reconnect, producer replacement, stale-track removal, and fallback overflow recovery.

### T-4 🟡 No browser end-to-end media flow

- **Risk:** Medium

There is no browser-level test proving that a host can create a room and a viewer can join and receive frames.

**Recommend.** Add Playwright coverage with deterministic fake media devices. Keep fast UI lifecycle cases separate from topology-specific real-media tests for LAN WebRTC, tunnel H.264 fallback, TURN reachability, WHEP, and network-change recovery.

### T-5 🟡 Failure injection and concurrent admission remain partial

- **Risk:** Medium

`RoomMediaPipeline` now proves basic ownership, invalidation, and idempotent cleanup, and OBS rollback paths are substantially covered. Tests still do not inject a failure after every fallback allocation, exercise FFmpeg restart-budget/backpressure behavior, simulate worker death/crash-loop decisions, or race WHIP/WHEP reservations and replacement callbacks.

**Recommend.** Add deterministic allocation-by-allocation failures for video/audio transport and consumer creation, Ogg ingress, frame-rate sampling, FFmpeg spawn, and first init. Assert zero children, transports, consumers, timers, listeners, reservations, and buffered bytes. Add parallel WHIP/WHEP admission and teardown cases.

### T-6 🟢 No coverage reporting or threshold

- **Risk:** Low

CI runs the suite but does not publish coverage or enforce a floor.

**Recommend.** Add coverage reporting after the higher-value integration tests exist. Prefer focused thresholds for lifecycle/state-machine modules over optimizing a repository-wide percentage first.

---

## Priority

1. Server and Socket.IO integration (T-1/T-2).
2. Client/browser lifecycle coverage (T-3/T-4).
3. Fallback and concurrent-admission fault injection (T-5).
4. Coverage reporting once meaningful integration coverage exists (T-6).
