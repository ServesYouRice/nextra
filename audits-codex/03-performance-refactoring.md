# Performance and Refactoring Findings

## PF-01 — One mediasoup worker/router conflicts with configured capacity

Severity: High

lib/mediasoup.js:48-69 creates one worker and one router. config.js:267-269 permits 100 active rooms and 20 viewers per room by default.

The shared WebRtcServer avoids a transport-port ceiling, but all SRTP/RTP processing still converges on one worker and all signaling, depacketization, buffering, and fallback coordination converge on one Node process. H.264 relay work can reach tens of megabits per second per room.

Recommended actions:

- Lower defaults until load tests establish safe values.
- Export event-loop delay, worker CPU, transport count, relay throughput, and memory metrics.
- Add room-affine worker/router pooling.
- Cap simultaneous FFmpeg relay pipelines independently of room count.
- Document the supported desktop/single-host scale envelope.

## PF-02 — MediaRecorder restarts for each new fallback viewer

Severity: Medium

HostView around src/HostView.jsx:900-922 restarts the recorder when a viewer joins. The server already stores initialization and recent media for late joiners.

Every restart:

- creates a new media generation
- forces existing viewers to process a new initialization segment
- introduces a visible discontinuity
- adds encoder and garbage-collection churn

Keep one recorder generation alive and serve cached initialization data to new viewers.

## PF-03 — Incremental fMP4 parsing repeatedly copies pending data

Severity: Medium

lib/fmp4Parser.js:39 concatenates the existing pending buffer with every incoming chunk. Fragmented input can repeatedly copy the same bytes, producing quadratic-like work while waiting for a large box.

Slices around :77-78 may also retain the larger parent backing store longer than required.

Use a segmented byte queue, cursor-based reader, or amortized growable buffer. Copy only complete emitted boxes whose lifetime must outlast the input queue.

## PF-04 — H.264 FU assembly does not validate RTP continuity

Severity: Medium

lib/h264Depacketizer.js:98-122 reassembles fragmented NAL units without sufficiently tying the assembly to RTP sequence-number and timestamp continuity.

Packet loss or reordering can combine fragments from different frames and feed corrupted Annex-B data into FFmpeg.

Track expected sequence number, timestamp, SSRC, and active FU type. Drop the partial NAL on gaps, timestamp changes, unexpected starts, or marker inconsistencies. Add loss/reorder tests.

## PF-05 — UDP allocation uses bind-close-rebind probes

Severity: Medium

Port discovery in relay and resolver paths probes a UDP port, closes it, and later asks another process or transport to bind it. A concurrent room or unrelated process can claim the port between those operations.

Prefer:

- binding port zero and reading the assigned address
- retaining the socket until ownership transfers
- letting the final consumer choose its own port
- atomic reservations in a shared allocator

## PF-06 — Browser-only libraries are packaged as server production dependencies

Severity: Medium

package.json keeps React, React DOM, mediasoup-client, and socket.io-client in dependencies. scripts/package-app.js installs all production dependencies into the packaged server even though those libraries have already been compiled into dist.

This increases executable size, package time, dependency audit surface, and cold extraction cost.

Separate:

- server runtime dependencies
- browser build-only dependencies
- packaging tool dependencies

Verify the packaged server from a clean production install after moving browser libraries.

## PF-07 — External Google Fonts reduce privacy and offline reliability

Severity: Medium

index.html loads Google Fonts for every host and viewer, and the CSP allows those remote origins.

The otherwise self-hosted application therefore makes an unconditional third-party request, exposes client metadata, and loses intended typography offline.

Bundle font files locally and remove the external CSP entries.

## PF-08 — Hot modules combine state machines, UI, protocol, and cleanup

Severity: High maintainability

Approximate module sizes at audit time:

- src/HostView.jsx: about 1,850 lines
- src/WatchView.jsx: about 1,374 lines
- lib/socket.js: about 2,136 lines
- server.js: about 1,251 lines

File size alone is not the defect. The problem is that each file mixes several independently failure-prone lifecycles. The room object in lib/rooms.js also gains undeclared fields from WHIP and fallback modules, making ownership difficult to inspect.

Recommended lifecycle boundaries:

### HostSession

Own capture, browser transports/producers, recorder, heartbeat, OBS state, and shutdown.

### RoomMediaPipeline

Own WHIP producers, fallback startup generation, FFmpeg worker, direct/plain transports, consumers, keyframe interval, and teardown.

### ViewerSession

Own producer-to-consumer-to-track mappings, playback generation, retry state, and leave cleanup.

### TunnelSupervisor

Own child process, output draining, URL, health, backoff, and termination.

### SessionRegistry

Own atomic WHIP/WHEP/socket capacity reservations and resource-to-room mappings.

Each controller should expose one idempotent close operation and explicit state transitions.

## PF-09 — Browser relay and RTP parsing compete with signaling on the main thread

Severity: Medium to High at scale

Fallback chunk handling, RTP depacketization, initialization caching, viewer fanout, room timers, and Socket.IO acknowledgements all execute through the Node event loop. Under high-bitrate relay traffic, signaling latency and cleanup timers can be delayed even if mediasoup worker CPU remains available.

Measure event-loop delay under realistic 1080p/4K relay traffic. Consider worker threads or a dedicated relay process for parsing and fanout if load testing confirms contention.

## PF-10 — Production HTML is cached until process restart

Severity: Low

server.js:734-744 caches the transformed index template. Running a new Vite build while the source server remains active can continue serving the previous HTML shell.

For production this is acceptable if deployments always restart atomically. Development and operational documentation should make that contract explicit, or reload the template when dist changes.

## PF-11 — Dependency drift should be managed deliberately

Severity: Low to Medium

Direct dependencies had several patch/minor upgrades available during the audit, including dotenv, helmet, mediasoup, mediasoup-client, and Vite.

The issue is not that every newest version must be installed. The project needs a routine:

- scheduled dependency PRs
- root and nested audits
- mediasoup interoperability tests
- packaged executable rebuilds after runtime dependency changes
- a documented support window for Node and cloudflared
