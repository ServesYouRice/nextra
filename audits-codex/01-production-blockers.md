# Production Blockers

## B-01 — Host route unmount can leave sharing active

Severity: Blocker

Area: privacy, lifecycle, resource ownership

### Evidence

The application router swaps HostView in and out while SocketProvider lives outside the router:

- src/App.jsx:28-50
- src/App.jsx:195-200

HostView defines media cleanup around src/HostView.jsx:740-777, but no component-unmount effect calls it. Cleanup is currently reached through selected explicit paths:

- transport failure around src/HostView.jsx:819
- capture track ended around src/HostView.jsx:996-999
- failed startup around src/HostView.jsx:1120-1121
- explicit Stop around src/HostView.jsx:1239-1246

### Impact

Navigating away from the Host route, or unmounting it through a rendering failure, can leave the capture track, mediasoup producer, MediaRecorder, room, or OBS-backed publication alive without a visible host control surface.

The socket remains mounted. The normal browser-host heartbeat stops, so a browser-only room may eventually expire, but that does not eliminate the immediate privacy window. An OBS-backed room can remain alive because WHIP activity refreshes liveness.

### Required fix

Introduce one HostSession owner for:

- capture stream and tracks
- mediasoup send transport
- video and audio producers
- MediaRecorder and fallback generation
- host heartbeat
- OBS/WHIP state

Its close operation must be idempotent and called by explicit Stop, route unmount, pagehide, fatal error handling, failed startup, and capture-track termination. If intentional background publishing is desired, it needs an explicit product mode and persistent indicator rather than occurring accidentally.

### Required tests

- Start browser sharing, navigate Home, and assert every track, producer, transport, recorder, and room is closed.
- Trigger ErrorBoundary while sharing and assert the same cleanup.
- Repeat Stop and unmount concurrently to prove shutdown is idempotent.

## B-02 — Public AV1 through the packaged Quick Tunnel is unreachable by default

Severity: Blocker for public AV1

Area: network architecture, product claims

### Evidence

- config.js:53-55 defaults RTC_LISTEN_IP to loopback when the HTTP server is loopback-bound.
- lib/mediasoup.js:22-35 and :92-97 bind the media plane to that address.
- lib/tunnel.js:165 creates a tunnel only to the local HTTP endpoint.
- lib/rooms.js:71-76 disables fallback relay for AV1.
- README.md describes TURN as the public-connectivity solution.

Mediasoup WebRtcTransport is ICE Lite and exposes the configured candidates. The Cloudflare command forwards the HTTP service used for pages, signaling, and WebSocket fallback; it does not turn a loopback mediasoup UDP endpoint into a public ICE candidate.

References:

- https://mediasoup.org/documentation/v3/mediasoup/api/
- https://developers.cloudflare.com/tunnel/setup/

### Impact

Public viewers can load the page and complete signaling but cannot establish the direct AV1 media path. Because AV1 intentionally has no FFmpeg/WebSocket fallback, playback has no working alternative.

Browser-side credentials for a standard external TURN service do not make the server's advertised 127.0.0.1 candidate reachable. A specially colocated and explicitly configured relay could be an exception, but that is not the documented default.

### Required fix

Choose and document one supported topology:

1. Expose a real public UDP/TCP media plane and configure announced addresses.
2. Provide a colocated relay design that can actually reach the server media listener.
3. Implement an AV1-capable tunnel fallback.
4. Disable AV1 in Quick Tunnel sessions and explain the limitation in the UI.

Add an end-to-end topology test that separately verifies page/signaling reachability and media-plane reachability.

## B-03 — Production dependencies contain known vulnerabilities

Severity: Blocker

Area: dependency security, release gate

### Evidence

The root lockfile resolves:

- ws 8.20.1 around package-lock.json:5965
- tar 7.5.13 around package-lock.json:5579
- engine.io 6.6.8 around package-lock.json:2887
- engine.io-client 6.6.5 around package-lock.json:2908
- socket.io-adapter 2.5.7 around package-lock.json:5402

npm audit --omit=dev reports four high findings and one moderate finding. The WebSocket issue permits unauthenticated memory exhaustion through fragmented messages. ws 8.21.0 is the patched release:

- https://github.com/advisories/GHSA-96hv-2xvq-fx4p

The tar issue is fixed in 7.5.16:

- https://github.com/advisories/GHSA-vmf3-w455-68vh

The nested poc-mediasoup lockfile independently resolves tar 7.5.9 and fails its own audit. It is not covered by the root dependency gate.

### Impact

The public Socket.IO endpoint is exposed to a remotely triggerable memory denial of service. The repository's own release gate is also red because package.json:30 and .github/workflows/ci.yml:19 run the production audit.

### Required fix

- Regenerate the root lockfile with ws at least 8.21.0 and tar at least 7.5.16.
- Upgrade the related Socket.IO transitive dependency chain.
- Add a temporary override if needed to prevent vulnerable re-resolution.
- Update or remove the nested proof-of-concept lockfile.
- Audit every independently installable package in CI.
- Rebuild Nextra.exe after the dependency update; the existing executable may contain the older dependency graph.

## B-04 — Fallback relay startup and teardown are not centrally serialized

Severity: Blocker for OBS/WHIP and fallback-heavy production

Area: concurrency, memory, process and transport lifecycle

### Evidence

lib/socket.js:662-1048 starts the fallback pipeline. Its initial guard checks room.fallbackWorker around :664, but the field is assigned only around :1015 after multiple awaits.

Concurrent callers include:

- WHIP prewarming in lib/whipRoutes.js
- fallback-consume-start around lib/socket.js:1744

Normal room destruction in lib/rooms.js:196-249 stops room.fallbackWorker but does not own all fields created by the startup path. Separate cleanup around lib/socket.js:1050-1079 handles more state, including the keyframe interval.

Potentially orphaned resources include:

- DirectTransports
- video and audio consumers
- PlainTransports and selected UDP ports
- FFmpeg process generations
- _fallbackKfInterval
- WHIP resource mappings
- buffered early chunks
- event listeners whose closures retain the room

### Impact

Two viewers or a WHIP prewarm/viewer race can create duplicate relay pipelines. A failed or normally destroyed room can leave transports, timers, callbacks, and buffered media alive. Under repeated room churn this becomes a process-stability problem.

### Required fix

- Set room.fallbackStartPromise or a starting state synchronously before the first await.
- Model starting, running, stopping, stopped, and failed states explicitly.
- Give every generation a cancellation token.
- Track every allocated resource immediately.
- Close partial resources in finally.
- Make room destruction call one idempotent fallback close operation.
- Bound earlyChunks independently of successful relay installation.

## B-05 — Windows release artifact lacks a production trust chain

Severity: Blocker for public binary distribution

Area: signing, provenance, licensing, release engineering

### Evidence

- Nextra.exe passes its adjacent SHA-256 check but Authenticode reports NotSigned.
- scripts/package-app.js:16-23 includes application runtime inputs but omits LICENSE, README, source instructions, an SBOM, and third-party notice material.
- package.json declares GPL-3.0-only.
- cloudflared is Apache-2.0 software included in the executable package.
- update-nextra-exe.bat performs build and packaging without the release:prep gate.
- CI currently has no Windows executable smoke test or signing job.

References:

- https://www.gnu.org/licenses/gpl-3.0.html.en
- https://www.gnu.org/licenses/gpl-faq.en.html
- https://www.apache.org/legal/apply-license
- https://github.com/cloudflare/cloudflared

### Impact

The adjacent hash detects accidental mismatch only if the hash itself is trusted. It does not authenticate the publisher. The current artifact layout also does not demonstrate a complete corresponding-source and third-party notice process for binary distribution.

### Required fix

- Authenticode-sign Nextra.exe using protected CI credentials.
- Build from a clean signed tag in Windows CI.
- Publish checksums, build provenance, and an SBOM.
- Include applicable licenses, notices, and exact-source instructions.
- Smoke-test startup, room creation, tunnel-disabled operation, and clean shutdown from the packaged executable.
- Require release:prep before packaging.
- Obtain legal review of the final distribution layout.
