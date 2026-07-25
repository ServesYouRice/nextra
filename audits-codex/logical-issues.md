# Logical and Implementation Issues

## Summary

| ID | Severity | Finding | Production blocker |
| --- | --- | --- | --- |
| L-1 | High | Prewarmed public browser relay waits for an event the host never emits | Yes |
| L-2 | High | Restart/recovery behavior promises session continuity that in-memory rooms cannot provide | Yes, unless the claim and UI are corrected |
| L-3 | Medium | Socket.IO viewer transports receive the host-grade initial bitrate | No |
| L-4 | Medium | Passphrase hashing blocks the Node event loop during room creation | No |
| L-5 | Medium | AV1 WebRTC capability is inferred from MSE/MP4 support | No |
| L-6 | Medium | OBS AV1 availability is gated by a WebGL renderer heuristic | No |
| L-7 | Medium | Readiness can be green while the client bundle or enabled OBS ingest is unavailable | Yes for source/service deployments |
| L-8 | Low | Host bandwidth advice points to a nonexistent quality tier | No |
| L-9 | Low | Unexpected unhandled rejections are logged and execution continues in unknown state | No |
| L-10 | Medium | Host and viewer orchestration remain monolithic and duplicate lifecycle state | No |

## L-1 - Prewarmed public browser relay waits for an event the host never emits

- **Severity:** High
- **Location:** `src/HostView.jsx:476`, `src/HostView.jsx:501`, `src/HostView.jsx:1032-1047`; `src/WatchView.jsx:383-385`, `src/WatchView.jsx:545-575`; `lib/socket.js:1820-1846`
- **Description:** For a public tunnel with no TURN server, the browser host prewarms a `MediaRecorder` before any relay viewer arrives. The recorder emits `media-init` once when it starts. When the first relay viewer later joins, the host's demand effect sees that the recorder already exists and does not restart it. The tunnel viewer explicitly ignores the cached initialization path and waits for a *live* `media-init` event. `relay-consume-start` only changes membership and demand; it does not trigger that event. The unused `prevRelayViewerCountRef` strongly suggests the missing zero-to-one transition handling.
- **Why it matters for production:** Packaged Nextra enables a public tunnel by default, and Cloudflare-tunnel viewers without TURN are deliberately routed to relay first. Those viewers queue headerless live chunks while waiting, then hit the queue/7-second initialization timeout and fall back to WebRTC, which the code itself says cannot traverse the HTTP tunnel. This can make the default public browser-capture flow consistently fail while local WebRTC tests remain green.
- **Recommended fix:** Define one recorder-generation contract. On the first relay viewer transition from 0 to 1, restart the recorder and emit a fresh `media-init` before forwarding chunks; alternatively return a fresh, compatible initialization segment plus a bounded current keyframe and remove the live-event requirement. Add a deterministic tunnel-origin regression test that starts the host long before the viewer and asserts decoded relay frames.
- **Blocker before production:** Yes. Public browser sharing is a core advertised flow.
- **Related risks/dependencies:** MediaRecorder/WebM generation boundaries, `room.mediaInit`/`room.initChunk`, slow-viewer queue limits, Socket.IO tunnel transport, T-4.

## L-2 - Restart/recovery behavior promises session continuity that in-memory rooms cannot provide

- **Severity:** High
- **Location:** `server.js:1301-1348`, `server.js:1465-1491`; `src/WatchView.jsx:704-758`, `src/WatchView.jsx:1134-1221`; `src/HostView.jsx:866-882`; `docs/service-deployment.md`
- **Description:** Graceful shutdown tells viewers that playback will resume after restart, and the media-worker death path says viewers and OBS reconnect automatically. A replacement process has an empty in-memory room registry, new media objects, and no host tokens. Viewer rejoin and host reclaim therefore return room-not-found/token-invalid. The host reconnect handler only logs reclaim failure and leaves the UI showing the old room as streaming.
- **Why it matters for production:** Operators and users receive a false recovery signal during upgrades or worker crashes. Viewers wait for a stream that cannot resume, while the host can continue sharing a dead code until manually stopping and creating a new room. This increases outage duration and makes incidents difficult to understand.
- **Recommended fix:** Choose and document one contract. The practical single-node contract is to emit a terminal `server-restarting`/`room-ended` state, clear host/viewer session state after failed reclaim, and tell the host to create and redistribute a new room. If seamless continuity is required, persist a minimal signed room intent and implement an explicit host-led recreation/rekey protocol; mediasoup resources themselves cannot be migrated.
- **Blocker before production:** Yes for any claim of automatic stream recovery. A launch can instead correct the copy and deterministic failure handling.
- **Related risks/dependencies:** In-memory architecture, host reload recovery, OBS reconnection behavior, process supervisor, packaged worker-restart testing.

## L-3 - Socket.IO viewer transports receive the host-grade initial bitrate

- **Severity:** Medium
- **Location:** `lib/mediasoup.js:65-78`; `lib/socket.js:1523-1573`
- **Description:** `createWebRtcTransport()` selects 600 kbps for `purpose: 'viewer'` or `'whep'` and 8 Mbps otherwise. `create-recv-transport` calls it without a purpose, so browser viewers use the 8 Mbps host default. Only WHEP correctly passes its viewer purpose.
- **Why it matters for production:** Starting remote viewers at an aggressive estimate increases initial burst, congestion, packet loss, and time-to-stable playback on ordinary internet connections. It also makes the code's documented viewer-specific congestion policy ineffective.
- **Recommended fix:** Call `createWebRtcTransport(router, { purpose: 'viewer' })` for Socket.IO receive transports. Add a contract test that asserts the transport factory receives the viewer purpose and the conservative initial bitrate.
- **Blocker before production:** No, but fix before load/topology certification.
- **Related risks/dependencies:** mediasoup bandwidth estimation, simulcast layer selection, public-network benchmark results.

## L-4 - Passphrase hashing blocks the Node event loop during room creation

- **Severity:** Medium
- **Location:** `lib/rooms.js:115-120`; `lib/socket.js:1198-1265`
- **Description:** Room creation uses `crypto.scryptSync`, while passphrase verification correctly uses asynchronous `crypto.scrypt`. The synchronous hash runs on the single application event loop.
- **Why it matters for production:** Each protected-room creation pauses signaling, metrics, relay fanout, and every other room. Rate and room caps bound the default impact, but the pause is still user-controlled and becomes material when limits are raised or multiple source IPs create rooms concurrently.
- **Recommended fix:** Make room creation asynchronous and use `crypto.scrypt` (or `scrypt` from `node:crypto/promises`), then reserve capacity before hashing and release the reservation on failure so concurrent creates cannot over-admit.
- **Blocker before production:** No under current conservative limits.
- **Related risks/dependencies:** Atomic room admission, creation rate limits, event-loop benchmark thresholds.

## L-5 - AV1 WebRTC capability is inferred from MSE/MP4 support

- **Severity:** Medium
- **Location:** `src/WatchView.jsx:847-856`; `src/lib/watchPlaybackMode.mjs:5-6`
- **Description:** The viewer labels AV1 unsupported based on `MediaSource.isTypeSupported('video/mp4; codecs="av01..."')`. That checks AV1 in an MP4/MSE playback pipeline, not whether the browser's WebRTC stack advertises AV1 receive capability.
- **Why it matters for production:** A browser can be incorrectly warned that it cannot play the stream, or a browser can pass the MSE test and still fail WebRTC negotiation. The diagnostic sends hosts and viewers toward the wrong remedy.
- **Recommended fix:** After loading the mediasoup device, inspect its receive RTP capabilities (or `RTCRtpReceiver.getCapabilities('video')`) for `video/AV1`; keep MSE checks only for the fMP4 path. Test the four combinations of room codec and WebRTC capability.
- **Blocker before production:** No.
- **Related risks/dependencies:** mediasoup-client capability normalization, browser-specific AV1 profiles, UI issue U-7.

## L-6 - OBS AV1 availability is gated by a WebGL renderer heuristic

- **Severity:** Medium
- **Location:** `src/HostView.jsx:137-208`, `src/HostView.jsx:1672-1689`; `src/lib/obsWebSocket.js`
- **Description:** AV1 mode is disabled unless a renderer string matches a hard-coded GPU family. WebGL renderer strings can be hidden, virtualized, routed through a different adapter, or fail to reflect the encoders installed in OBS. The OBS transaction already has a more authoritative encoder-selection boundary.
- **Why it matters for production:** Supported hardware can be blocked, and detected hardware can still lack the required OBS encoder plugin. Users receive a confident UI decision from weak evidence.
- **Recommended fix:** Treat GPU detection as a hint. Query OBS for available encoder IDs during configuration, show a preflight result, and let that authoritative result enable/deny AV1 with a clear fallback to H.264.
- **Blocker before production:** No.
- **Related risks/dependencies:** OBS WebSocket availability, privacy-masked WebGL, encoder plugin/version matrix.

## L-7 - Readiness can be green while the client bundle or enabled OBS ingest is unavailable

- **Severity:** Medium
- **Location:** `server.js:961-977`, `server.js:980-1063`, `server.js:1188-1234`
- **Description:** `/readyz` checks only `serviceReady`, the mediasoup worker, and Socket.IO. It can return 200 while `dist/index.html` is absent (all SPA routes return a build-required 503), while the enabled WHIP listener is still starting or has failed, or while FFmpeg is absent and the advertised OBS fallback is unavailable.
- **Why it matters for production:** A service manager or load balancer can mark an instance ready even though one or more supported product flows are unusable. This is especially dangerous because the deployment guide tells operators to verify `/readyz` after restart.
- **Recommended fix:** Define readiness profiles. At minimum require the production client bundle in non-development mode. If WHIP/fallback are enabled and part of the declared deployment contract, include their status in the readiness decision or expose explicit component readiness endpoints with documented probe policy.
- **Blocker before production:** Yes for source/service deployment; packaged artifacts always include `dist`, but the release gate must prove that invariant.
- **Related risks/dependencies:** T-2, D-5, optional FFmpeg/WHIP support policy.

## L-8 - Host bandwidth advice points to a nonexistent quality tier

- **Severity:** Low
- **Location:** `src/HostView.jsx:60-84`, `src/HostView.jsx:478-481`
- **Description:** The warning recommends 720p, but selectable profiles are 1080p, 1440p, and 4K.
- **Why it matters for production:** The only remediation offered during congestion cannot be performed, reducing trust in the diagnostics.
- **Recommended fix:** Recommend the next available lower tier and/or 30 fps, calculated from the current selection. If 1080p is still too high, add an actual 720p profile only after bitrate/quality validation.
- **Blocker before production:** No.
- **Related risks/dependencies:** UI priority list, supported quality matrix.

## L-9 - Unexpected unhandled rejections are logged and execution continues in unknown state

- **Severity:** Low
- **Location:** `server.js:62-74`
- **Description:** The process-level `unhandledRejection` handler logs the rejection and continues, regardless of which transaction or resource ownership path failed.
- **Why it matters for production:** An unhandled rejection can indicate a partially applied media/session mutation. Continuing may preserve corrupted state that is harder to diagnose than a supervised restart.
- **Recommended fix:** Eliminate known floating promises and attach ownership-aware error handling. For truly unexpected rejections, adopt a documented fail-fast/restart policy or classify explicitly safe rejection sources before continuing.
- **Blocker before production:** No.
- **Related risks/dependencies:** Single-process blast radius, external supervisor, structured logging.

## L-10 - Host and viewer orchestration remain monolithic and duplicate lifecycle state

- **Severity:** Medium
- **Location:** `src/HostView.jsx` (about 2,000 lines); `src/WatchView.jsx` (about 1,400 lines); `lib/socket.js` (about 2,200 lines)
- **Description:** Large components combine feature detection, credentials, room state, WebRTC, relay generations, OBS control, reconnect policy, and rendering. Multiple state/ref pairs manually mirror the same fact. Server signaling, fallback relay, metrics, admission, and media control also share one module.
- **Why it matters for production:** Changes cross invisible lifecycle boundaries and regressions such as L-1 become easy to introduce. The current focused hooks/pipeline owners are good starts but do not yet establish clear state-machine contracts.
- **Recommended fix:** Extract explicit host/viewer session state machines and protocol adapters, with one owner for each timer/listener/resource. Split server signaling by room admission, WebRTC transport, browser relay, OBS fallback, and media-control domains. Refactor only behind behavioral tests.
- **Blocker before production:** No.
- **Related risks/dependencies:** A-2, T-4, T-6; avoid broad refactors until blockers have regression tests.

## Production Blockers

1. Fix L-1 and prove late-joining tunnel relay playback with decoded frames.
2. Resolve L-2 by implementing real recreation or correcting restart semantics and clearing stale host/viewer state.
3. Fix L-7 for supported source/service deployment readiness.
4. Resolve the dependency/release blockers in `testing-gaps.md` (T-1 and T-2).
5. Add a host authorization boundary for public exposure (S-1 in `security-issues.md`).
