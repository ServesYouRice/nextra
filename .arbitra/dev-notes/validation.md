# Validation ids the plan cites (from the run's plan, not exported into the prompts)

## VAL-001

OggOpusMuxer.pushRtp keeps emitting pages with strictly increasing granule positions when consecutive RTP timestamps span more than 2^31 samples from the first packet. This holds across a 32-bit RTP timestamp wrap. Granule increments equal the RTP timestamp deltas.

Evidence:
- New unit test in tests/oggOpusMuxer.test.js feeding packets at base, base+2^31-960, base+2^31, base+2^31+960 and across 0xffffffff→0 wrap, asserting a non-null page for each and the expected granule values
- node --test tests/oggOpusMuxer.test.js exit code 0

## VAL-002

After the re-anchoring change, the OggOpusMuxer still drops late, duplicate, and backward packets. An SSRC change still re-anchors to the current granule. baseTimestamp stays null until the first accepted packet, so FFmpegRelay.setAudioStartSec still offsets the first page.

Evidence:
- Unit tests for a duplicate timestamp, a backward timestamp, an SSRC switch, and a granule preset before the first packet
- Existing tests in tests/oggOpusMuxer.test.js pass unchanged

## VAL-003

When the RTP marker packet of frame A is lost and the next packet starts frame B with one missing sequence number, H264Depacketizer.pushFrames emits frame A with intact:false and frame B with intact:true.

Evidence:
- New test in tests/h264Depacketizer.test.js building synthetic single-NAL RTP packets with a dropped marker packet
- node --test tests/h264Depacketizer.test.js exit code 0

## VAL-004

Existing loss semantics are preserved in four cases: (a) a gap after a marker-terminated frame flags the next frame intact:false; (b) a gap inside a frame flags that frame intact:false; (c) a frame that vanished entirely flags the following frame intact:false; (d) a multi-packet gap at an unterminated timestamp transition flags both frames intact:false.

Evidence:
- Tests covering cases (a)–(d) in tests/h264Depacketizer.test.js
- Existing depacketizer tests pass unchanged

## VAL-005

H.264 reassembly memory is bounded. FU-A continuation packets that exceed the per-NAL byte or fragment limit discard the partial NAL. Access-unit accumulation beyond the per-frame limit discards that frame without emitting it, and the next emitted frame is reported intact:false. A well-formed large keyframe below the defaults is emitted unchanged.

Evidence:
- Tests pushing unterminated FU-A continuations and markerless same-timestamp NALs past configurable small limits, asserting internal buffers stay bounded and no oversized frame is emitted
- Test that a multi-MB keyframe below default limits round-trips byte-identically

## VAL-006

collectParameterSets never caches a truncated SPS/PPS taken from a FU-A start fragment. A later complete SPS/PPS (single NAL or STAP-A) is captured. Callers that rely on FU-A start NAL types for keyframe detection behave as before.

Evidence:
- New tests in tests/h264Sprop.test.js: a FU-A start fragment of NAL type 7 followed by a complete SPS yields the complete SPS bytes
- Repository search output listing all extractNalUnits/extractNalUnitsFromRtp/collectParameterSets callers, with their tests passing

## VAL-007

parseTrustProxy returns a number only for digits-only strings, keeps boolean keywords, and returns the trimmed string otherwise. For example, '2'→2, 'true'→true, '127.0.0.1'→'127.0.0.1', '10.0.0.0/8'→'10.0.0.0/8', 'loopback, 10.0.0.0/8'→the same string.

Evidence:
- New cases in tests/config.test.js loading config with fixture TRUST_PROXY values
- node --test tests/config.test.js exit code 0

## VAL-008

With forwarded-header trust enabled and a loopback peer, getTrustedForwardedClientIp ignores attacker-supplied leftmost X-Forwarded-For entries and returns the rightmost entry. It ignores CF-Connecting-IP when X-Forwarded-For is present. It returns '' for unparseable values and for any non-loopback peer, and returns '' whenever trust is disabled. A spoofed '127.0.0.1, <real>' therefore classifies as the real client, not loopback.

Evidence:
- New tests in tests/network.test.js for spoofed multi-hop X-Forwarded-For, spoofed CF-Connecting-IP with X-Forwarded-For present, garbage values, and the disabled/non-loopback cases
- node --test tests/network.test.js exit code 0

## VAL-009

isIpInTrustedLan rejects CIDR entries with an empty prefix ('192.168.1.0/'), '/0', non-decimal prefixes, or invalid network addresses. Such entries match nothing. Valid entries such as '192.168.1.0/24' and exact-IP entries keep matching as before.

Evidence:
- New tests in tests/network.test.js asserting classifyClient returns 'remote' for 8.8.8.8 with TRUSTED_LAN_CIDRS '192.168.1.0/' or '0.0.0.0/0'
- Existing trusted-LAN tests pass unchanged

## VAL-010

The relay capacity probe handler responds 404 without throwing when given a token whose JavaScript string length equals the armed token's length but whose UTF-8 byte length differs, for example multibyte characters. The armed probe is still served once to the correct token.

Evidence:
- New test in tests/relayCapacityProbe.test.js using a fake fetchImpl that invokes handler with a multibyte token while a probe is armed and asserts status 404 and no exception
- node --test tests/relayCapacityProbe.test.js exit code 0

## VAL-011

FFmpegRelay spawns no new FFmpeg process after an owner stop() issued at any of these points: during restart()'s 1s backoff, inside an 'exit' event listener, or while start() awaits the NVENC/BSF probes. reconfigure() and a fresh start() after stop() still spawn exactly one process.

Evidence:
- New tests in tests/ffmpegRelay.test.js using a stubbed spawn or fake FFMPEG_PATH and mocked timers, counting spawns per scenario
- Existing tests/ffmpegRelay.test.js, tests/fallbackRelaySwitch.test.js and tests/fallbackRelayAdaptation.test.js pass

## VAL-012

An FFmpeg process that the relay did not stop and that exits by signal (for example SIGSEGV or SIGKILL) while running triggers restart() and consumes restart budget. A process terminated by the relay's own stop() or superseded by reconfigure() does not trigger a restart.

Evidence:
- Tests emitting exit(null,'SIGSEGV') on a running fake child and asserting a restart, and exit after stop() asserting none

## VAL-013

After beginBurst(N) on a fresh process, writing frames that total N bytes while stdin's writableLength grows above MAX_STDIN_BUFFERED_BYTES drops no frames and emits no 'video-gap'. After the declared burst has been written and stdin drains below the normal cap, the normal 4 MiB cap applies again. A new start() resets any outstanding burst allowance.

Evidence:
- Test with a stub stdin whose writableLength is controlled, asserting writeVideoFrame returns true throughout the burst and false or 'video-gap' only after the burst completes and the normal cap is exceeded

## VAL-014

When an h264_nvenc relay process exits non-zero before emitting an init segment, the relay switches to libx264 for its next start. _buildArgs then contains '-c:v libx264' and no NVENC options, and a warning is logged. The NVENC probe exercises the same option set used at runtime. libx264 failures and videoCopy mode keep the existing restart behavior.

Evidence:
- Tests forcing _videoEncoder='h264_nvenc', simulating a non-zero exit before init, and asserting the next spawn's args use libx264
- Unit assertion that the probe argument list includes the runtime NVENC options (-preset p5, -tune ll, -rc cbr, -zerolatency 1, -bf 0)

## VAL-015

Invoking connect-transport, close-viewer-transport, produce, consume and consumer-resume (and every other handler that destructured its payload in the signature) with an explicit null payload calls the callback with success:false and the handler's existing invalid-parameter error. No synchronous exception or unhandled promise rejection escapes the listener.

Evidence:
- Unit test using the existing socket handler harness emits each event with null and asserts the callback payload
- Test registers process 'unhandledRejection'/'uncaughtException' listeners (or the harness equivalent) and asserts neither fired
- Search output listing every handler signature changed in lib/socket.js

## VAL-016

reclaim-host with a null payload returns success:false, error 'Invalid reclaim parameters.' and the RECLAIM_REJECTED room state. join-room with a null payload returns success:false, error 'Invalid room code format.'. Neither throws nor rejects, and no room membership changes.

Evidence:
- Unit tests for reclaim-host and join-room with null payloads asserting exact callback contents
- Assertion that the socket-to-room mapping is unchanged after both calls

## VAL-017

A media-chunk whose chunk is not a Buffer, ArrayBuffer or ArrayBufferView (for example {byteLength: 1, payload: 'x'.repeat(1e6)} or {size: 10}) is dropped. It is not stored as room.initChunk, not appended to room.mediaBootstrapChunks, not passed to room.relayMp4.push, and not forwarded to relay viewers, and room.mediaBootstrapBytes is unchanged.

Evidence:
- Unit tests for the WebM path and the MP4 path (room.relayMp4 set) with forged objects asserting room state is unchanged and no emit occurred

## VAL-018

Binary media-chunks (Buffer, ArrayBuffer, Uint8Array) are still accepted. Each is charged its real byte length against MAX_RELAY_BOOTSTRAP_BYTES and MAX_CHUNK_SIZE, and its bytes are stored and forwarded unchanged. An exception thrown by the MP4 relay parser while processing a chunk is caught inside the handler and does not escape the socket.io listener.

Evidence:
- Unit test asserting mediaBootstrapBytes equals the sum of real byte lengths for mixed binary forms
- Unit test with an oversized Buffer asserting the droppedOversized metric increments
- Unit test with a relayMp4.push stub that throws, asserting the handler returns normally and logs

## VAL-019

Repeating consume (including concurrent, overlapping calls) for the same producerId from one viewer leaves at most one live consumer per producer in viewerData.consumers. Superseded consumers are closed and removed from activeConsumerIds, and consumer-resume on a superseded consumer id returns 'Consumer not found.'.

Evidence:
- Unit test calling consume N times sequentially and asserting consumers.length <= number of active room producers and that the old consumers' close() was called
- Unit test with two overlapping consume calls (deferred recvTransport.consume) asserting exactly one surviving consumer
- Unit test that consumer-resume with a superseded id fails

## VAL-020

Two overlapping create-send-transport calls from the same host leave exactly one open transport assigned to room.hostTransport, and every other transport created is closed and marked for shutdown. If the socket has disconnected or no longer hosts the room when createSocketWebRtcTransport resolves, the new transport is closed, not stored, and the callback reports failure.

Evidence:
- Unit test with a deferred createSocketWebRtcTransport stub resolving two calls out of order, asserting closed/open state of each fake transport
- Unit test where the host disconnects (or the room is reclaimed by another socket) during the await

## VAL-021

A second successful produce of the same kind closes the previous producer of that kind. room.producer/room.audioProducer reference the new producer, the old producer id is absent from activeProducerIds, and a produce that resolves after room.hostTransport was replaced is closed rather than published.

Evidence:
- Unit test producing video twice and asserting the first fake producer's close() was called and room.producer is the second
- Unit test where hostTransport changes during the produce await

## VAL-022

RoomMediaPipeline closes every fallback resource and timer it owns on closeFallback() and close(), including resources registered while the state is 'idle'. The onFallbackClose callback still fires at most once per started fallback, and WHIP resources are still closed only by close().

Evidence:
- tests/roomMediaPipeline.test.js cases: own() while idle then close() closes it; own() after a cancelling closeFallback() then closeFallback() closes it; the onClose call count stays 1

## VAL-023

A startFallbackRelay call that has been superseded (generation changed while it awaited) does not stop, replace or mutate the newer start or running relay. room.fallbackWorker, room.fallbackBitrate, room.fallbackSource, room.fallbackInitSegment and the delivery state are untouched by it, and its finally/catch do not call closeFallback/stopFallbackRelay on the newer generation. Every resource the stale start created is closed, and the fallback pipeline capacity counter returns to its pre-start value once all starts have finished or been torn down.

Evidence:
- Unit test in tests/fallbackRelaySwitch.test.js (or a new tests/fallbackRelayStaleStart.test.js) using injected FFmpegRelay/relayRuntime fakes: start A, cancel, start B, let A resume past each await (including the frame-rate sampling wait), assert B's relay is still room.fallbackWorker and not stopped
- Assertion that A's fake relay/transports have close/stop called
- Assertion on the active fallback pipeline count (via the existing metrics/stats accessor)

## VAL-024

RtpReorderBuffer exposes a time-driven flush (for example poll()) that, once maxWaitMs has elapsed since waiting began, releases held packets in sequence order and counts the skipped gap in lostPackets, without another push(). The fallback relay calls it periodically from a pipeline-owned timer, so a tail held after a lost packet reaches the depacketizer within roughly maxWaitMs plus one timer period.

Evidence:
- tests/rtpReorder.test.js case using an injected now(): push packets 1, 3, 4, advance time past maxWaitMs, poll() returns [3, 4] and lostPackets === 1
- Unit test that poll() before the deadline returns []
- Fallback relay test or code evidence that the flush timer is registered through pipeline.setTimer and cleared on closeFallback

## VAL-025

readVideoTrackInfo given an init segment whose mdhd box is header-only (8 bytes) or too short for its version-dependent timescale field returns without throwing. A RangeError from init parsing cannot escape createMp4RelayStream: the stream reports onError and continues with no track info.

Evidence:
- tests/relayMp4.test.js cases built with tests/mp4Boxes.js: a header-only mdhd at the end of moov/trak/mdia, and a truncated version-1 mdhd
- Assertion that valid init segments still yield the same videoTrackId/videoTimescale/defaultSampleFlags

## VAL-026

measure() returns {status: 'failed', reason} (not 'fast') when an HTTP 200 body reaches EOF with fewer than PROBE_BYTES bytes and too little measurement. It still returns 'fast' when the full PROBE_BYTES arrive within the ramp-up window, and 'measured' when enough data was timed.

Evidence:
- tests/relayCapacityProbe.test.js cases with a fake fetch: an empty 200 body, a 1 KiB 200 body, a full body delivered instantly, and a full body delivered slowly

## VAL-027

When joinRoom, commitRoom or reclaimHostRoom maps a socket to a new room, the socket is removed from its previous room's viewers/relayViewers/fallbackViewers. destroyRoom/clearRoomMappings and reclaimHostRoom unmap a socket only if its mapping still points at the room being torn down or reclaimed, so a socket that moved to another room keeps its current mapping.

Evidence:
- tests/rooms.test.js and tests/sessionRegistry.test.js cases: a viewer joins A then B, B's mapping survives destroyRoom(A), A.viewers no longer contains the socket
- Case: a host socket of A reclaimed by a new socket while the old socket is mapped to B, B's mapping survives

## VAL-028

The repository's existing automated test suite and lint configuration pass after each task, with no previously passing test now failing.

Evidence:
- Exit code 0 from the repository test script
- Exit code 0 from eslint over the changed files

## VAL-029

WHIP createAnswer returns exactly one m-section per offered m-section, in offer order (including audio-first offers). Any offered section that is not accepted (unsupported codec, unknown kind such as application) is answered with port 0 instead of being omitted, and its mid is absent from a=group:BUNDLE.

Evidence:
- New tests in tests/whip.test.js parsing the answer's m= lines for an audio-first offer, an offer with an unsupported audio codec, and an offer with an application section
- Diff of lib/whip.js createAnswer/buildMediaSection

## VAL-030

For every accepted WHIP codec payload type, the answer contains a=rtcp-fb lines for exactly the feedback entries that appear both in the offer for that PT (or the '*' wildcard) and in the producer's supported feedback. No unoffered feedback is emitted.

Evidence:
- New tests in tests/whip.test.js asserting rtcp-fb lines for offers with full, partial and no feedback

## VAL-031

A WHIP Opus offer with fmtp sprop-stereo=1 produces producer rtpParameters whose Opus codec parameters contain 'sprop-stereo' = 1. An offer without it produces no sprop-stereo parameter.

Evidence:
- New test in tests/whip.test.js inspecting toMediasoupRtpParameters output

## VAL-032

In WHEP createViewerAnswer, a disabled (port 0) or inactive offer section that precedes an active section of the same kind does not receive a consumer. The active section receives the consumer, and the disabled/inactive section is answered with port 0 in its original position.

Evidence:
- New tests in tests/whep.test.js with port-0 and a=inactive video/audio sections preceding active ones

## VAL-033

Every a=extmap line in a WHEP answer m-section names a URI the offer listed for that section, uses the offer's id, and equals an entry in that consumer's rtpParameters.headerExtensions (same uri and id). No id appears twice in a section. a=rtcp-fb lines in the WHEP answer are limited to offered feedback.

Evidence:
- New tests in tests/whep.test.js comparing answer extmap/rtcp-fb lines against the offer and the fake consumer's rtpParameters, including an offer whose ids collide with router preferredIds

## VAL-034

For every codec answered in a WHEP m-section (including RTX with its apt), the payload type written in a=rtpmap/a=fmtp equals the payload type in that consumer's rtpParameters.codecs, consistent with the remediation chosen for section-189067a43c5f50160f1b8635/Q-001.

Evidence:
- New tests in tests/whep.test.js where the router's preferredPayloadType differs from the offer's PT
- Recorded section-189067a43c5f50160f1b8635/Q-001 decision referenced in the task notes

## VAL-035

WHEP H.264 matching compares the parsed profile (profile_idc together with the profile-iop constraint byte, as in RFC 6184 / mediasoup semantics) rather than only the first byte. It treats an absent profile-level-id as the RFC default 42001f. For example, offer 640c1f does not match router 64001f, and an offer without profile-level-id does not match a High-profile-only router codec.

Evidence:
- New table-driven tests in tests/whep.test.js for both the capability filter and the answer codec matcher

## VAL-036

A WHEP offer with a=setup:passive produces an answer with a=setup:active, and the transport is connected with remote DTLS role 'server'. Offers with actpass or active produce a=setup:passive, and the remote role is 'client'.

Evidence:
- New tests in tests/whep.test.js asserting both the answer setup attribute and the dtlsParameters.role passed to the fake transport's connect

## VAL-037

If a viewer leaves (leave-room) or disconnects while create-recv-transport is awaiting transport allocation, the newly allocated transport is marked for shutdown and closed. It is not stored in room.viewerTransports, and the callback reports failure. A viewer that stays connected still gets a stored transport and success.

Evidence:
- New test (for example tests/socketRecvTransportDeparture.test.js) using an injected deferred createWebRtcTransport and a fake io/socket

## VAL-038

launchCloudflaredCandidate recognizes a trycloudflare.com URL that is split across two or more stdout/stderr chunks. Scanning state is kept per stream and bounded in size, and an incomplete URL prefix is never resolved as the base URL.

Evidence:
- New tests (for example tests/tunnel.test.js) driving a fake child process with split chunks

## VAL-039

A named tunnel resolves only after a registration signal appears in cloudflared output. A process that stays alive without registering is stopped and rejected when timeoutMs elapses, and TunnelSupervisor then publishes 'error' rather than 'active'.

Evidence:
- New tests in tests/tunnel.test.js with a fake child process
- Updated or added tests in tests/tunnelSupervisor.test.js

## VAL-040

Startup log retention treats a session's primary file and all of its rotated generations (.1, .2, ...) as one unit. It keeps the 10 newest sessions with all their generations and deletes every file of older sessions. Files not matching the startup-session pattern, including startup-latest.log*, are untouched.

Evidence:
- New tests against the extracted retention helper using a temporary directory or a fake fs

## VAL-041

An uncaught exception that an 'uncaughtException' listener handles does not trigger the blocking failure dialog. A fatal exception or non-zero exit triggers the dialog at most once. The dialog wording does not claim a startup failure for a crash after startup completed (per section-189067a43c5f50160f1b8635/Q-004 default).

Evidence:
- New unit tests of the extracted failure-reporting installer using a fake process EventEmitter and an injected notifier

## VAL-042

The repository's existing automated test suite still passes after each task, except for assertions that explicitly encode the removed buggy behavior. Each such assertion is updated and listed in the task evidence.

Evidence:
- Test runner output for the full suite after each task
- List of any updated pre-existing assertions with justification

## VAL-043

parseDtlsParameters returns role 'client' when the remote offer has a=setup:active or a=setup:actpass, or has no setup attribute (session- or media-level). For a=setup:passive it returns role 'server'. Fingerprints are unchanged.

Evidence:
- tests/whip.test.js cases for active, actpass, absent, passive, and session-level inheritance
- node --test tests/whip.test.js exit code 0

## VAL-044

createAnswer serializes TCP ICE candidates with a tcptype attribute (the candidate's tcpType, defaulting to 'passive'). UDP candidate lines are byte-identical to the previous output.

Evidence:
- tests/whip.test.js asserting 'TCP ... typ host tcptype passive' and an unchanged UDP line
- node --test tests/whip.test.js exit code 0

## VAL-045

A WHIP offer whose produced video or audio section lacks a=ssrc is rejected with a 4xx JSON error before createWebRtcTransport is called. No transport, resource, or room state is left behind, and whipStarting is released. Offers that declare SSRCs produce rtpParameters with encodings[0].ssrc set exactly as before.

Evidence:
- tests/whipRoutes.test.js case with a fake createWebRtcTransport spy asserting zero calls for an SSRC-less offer
- tests/whip.test.js case asserting SSRC presence detection
- node --test tests/whip.test.js tests/whipRoutes.test.js exit code 0

## VAL-046

If the request is cancelled or superseded while transport.connect() is pending, the stale startup does not register a WHIP resource. It does not set whipSessionId, whipResourceId, or whipTransport for the room, and it closes its transport. A replacement session's state is unchanged.

Evidence:
- tests/whipRoutes.test.js case with a deferred fake connect() resolved after a replacement POST or client abort
- sessionRegistry lookup for the stale resource returns nothing
- node --test tests/whipRoutes.test.js exit code 0

## VAL-047

A stale transport.produce() completion (generation changed or room.whipTransport no longer this transport) closes only its local producer. It never assigns room.whipProducer or room.whipAudioProducer, never calls ownWhip, and never mutates the replacement session's fields.

Evidence:
- tests/whipRoutes.test.js case with a deferred fake produce() resolved after supersession
- ownWhip spy call log
- node --test tests/whipRoutes.test.js exit code 0

## VAL-048

If transport.produce() rejects for video or audio after DTLS connects, the current generation is torn down. Already-created producers are released or closed, the transport is closed, the resource is unregistered, whipConnected stays false, host metrics are emitted, and no new-producer events or relay prewarm occur.

Evidence:
- tests/whipRoutes.test.js cases: video produce rejects; video succeeds then audio produce rejects
- fake transport/producer close() spies and registry assertions
- node --test tests/whipRoutes.test.js exit code 0

## VAL-049

If DTLS reports 'failed' or 'closed' while produce() is pending, whipConnected is not later set to true and the grace timer tears the session down after the timeout. A dtlsstatechange or grace-timer callback from a superseded generation does not modify a newer session.

Evidence:
- tests/whipRoutes.test.js case using mock timers: emit connected, emit failed before produce resolves, advance past grace
- node --test tests/whipRoutes.test.js exit code 0

## VAL-050

An 'icestatechange' of 'disconnected' on the current WHIP transport sets whipConnected false and whipReconnecting true, emits host metrics, and starts the grace teardown. A return to 'connected'/'completed' within the grace period cancels the teardown and restores the connected state. Events from superseded transports are ignored.

Evidence:
- tests/whipRoutes.test.js ICE-disconnect cases with mock timers (patterned after tests/whepRoutesIceDisconnect.test.js)
- node --test tests/whipRoutes.test.js exit code 0

## VAL-051

A WHIP session whose DTLS never reaches 'connected' within the establishment timeout after the 201 is closed through closeWhipSession (resource unregistered, transport closed). The timer is cleared when DTLS connects and when closeWhipSession runs.

Evidence:
- tests/whipRoutes.test.js establishment-timeout case with mock timers
- node --test tests/whipRoutes.test.js exit code 0

## VAL-052

closeWhipSession clears fallbackH264Sps and fallbackH264Pps. A new session's connected handler resets them before the fallback relay is prewarmed. A stream-capture callback whose producer is no longer room.whipProducer does not write sprop/SPS/PPS onto the room.

Evidence:
- tests/whipRoutes.test.js case: seed Sps/Pps, close or replace the session, assert null at startFallbackRelay invocation time
- node --test tests/whipRoutes.test.js exit code 0

## VAL-053

DELETE /whip/broadcast/:resourceId without an Authorization header, or with a wrong bearer token, returns an error status (403 by default) and leaves the session, relay, and registry intact. With the room's host token it returns 200 and tears the session down as before.

Evidence:
- tests/whipRoutes.test.js DELETE auth cases
- node --test tests/whipRoutes.test.js exit code 0

## VAL-054

Public WHIP rate-limit state is bounded. Entries whose window has expired are pruned without the same IP returning, the number of tracked addresses never exceeds the configured cap under a flood of distinct addresses, and per-IP limiting (429 after PUBLIC_WHIP_RATE_LIMIT_MAX in a window) still works.

Evidence:
- unit test of the extracted limiter with mock time: insert N distinct IPs > cap, assert size <= cap; advance past window, assert pruning
- existing whipRoutes rate-limit tests still pass
- node --test tests/whipRoutes.test.js exit code 0

## VAL-055

The public WHIP router is mounted with a getClientIp that resolves the trusted client address (not the raw proxy socket address) when proxy trust is configured. This is shown by a test or by a documented code reference in server.js. The default raw-socket fallback is used only when no proxy trust is configured.

Evidence:
- test or code-reference evidence of the createWhipRouter options passed in server.js
- node --test tests/whipRoutes.test.js exit code 0

## VAL-056

With --allow-insecure-tls, the benchmark's metrics requests to an HTTPS target with a self-signed certificate succeed. Without the flag they fail certificate verification. HTTP targets and the METRICS_TOKEN Authorization header behave as before.

Evidence:
- new requireable metrics-client test against a local HTTPS server with a self-signed cert, or an injected-request test asserting rejectUnauthorized wiring
- node --test tests/benchmarkRuntime.test.js exit code 0

## VAL-057

The benchmark reports null (not 0) for worker CPU, process CPU, memory growth, and event-loop p95/max when the corresponding metrics are absent. Headroom is null for those metrics, the run fails with an explicit '<metric> unavailable' failure per missing metric (per the section-f0767a79379636e542689295/Q-002 default), and runs with complete metrics compute the same values as before.

Evidence:
- tests/runtimeBenchmarkModel.test.js cases for the extracted observation/threshold helpers with missing and present fields
- node --test tests/runtimeBenchmarkModel.test.js exit code 0

## VAL-058

The churn harness fails with an explicit unavailable failure when baseline or settled heapUsed, resources.total, rooms.active, or activeSockets are absent, instead of computing 0 growth and passing.

Evidence:
- tests/churnRuntime.test.js case with a metrics fixture missing those fields
- node --test tests/churnRuntime.test.js exit code 0

## VAL-059

When the benchmark fails after sockets connect (metrics endpoint error during warm-up or sampling, or partial connect failure), every connected socket is closed, ack loops stop, the process exits with code 1 within a bounded time, and the fixture server observes zero remaining client sockets.

Evidence:
- tests/benchmarkRuntime.test.js spawning the script against a local socket.io+HTTP fixture whose /api/metrics returns 500
- node --test tests/benchmarkRuntime.test.js exit code 0

## VAL-060

When the churn harness fails during pool setup (viewer connect fails after its host connected) or at baseline metrics, every already-connected socket, including the orphaned host, is closed and the process exits with code 1 within a bounded time.

Evidence:
- tests/churnRuntime.test.js fixture case with failing baseline metrics and a connection limiter rejecting the Nth socket
- node --test tests/churnRuntime.test.js exit code 0

## VAL-061

The preflight tracked-path check reports a violation for .env, .env.local, .env.production and similar files at any directory depth (for example poc-mediasoup/.env, server/.env.production, config/.env.local). It still allows .env.example at any depth.

Evidence:
- Unit test in tests/opensourcePreflight.test.js exercising the exported path classifier with root-level and nested .env names and .env.example
- Diff of forbiddenPathRegexes and the .env.example exemption in scripts/opensource-preflight.js

## VAL-062

The preflight enumerates tracked files NUL-delimited (git ls-files -z), so names with spaces, quotes or non-ASCII characters are scanned for secrets. A tracked regular file that cannot be read is reported as a violation instead of being skipped. Binary files and gitlink directories are still handled explicitly.

Evidence:
- Unit test for the exported ls-files output parser using NUL-separated input that contains non-ASCII and quoted names
- Unit test showing that a secret inside a non-ASCII-named file in a temporary root is reported, and an unreadable or missing tracked path yields a violation

## VAL-063

On darwin, no CLOUDFLARED_PATH, local or PATH candidate can be staged as the cloudflared executable unless it was verified against the pinned digest and then extracted. Bare binaries compared against the archive digest are never accepted silently, and the verified download path is unchanged.

Evidence:
- Unit test in tests/packageApp.test.js for the exported candidate-resolution helper with platform darwin: the archive candidate is routed through extraction, a bare binary is rejected or skipped with a reason
- Code diff showing that every darwin .tgz staging path goes through verifyCloudflared on the archive followed by extractCloudflaredFromArchive

## VAL-064

On win32, the packager's npm and caxa invocations pass stageDir, outputExe and iconStub to the child process as distinct arguments, even when the paths contain spaces or cmd.exe metacharacters (& | ^ ( ) %). No argument is reinterpreted by cmd.exe.

Evidence:
- Unit test for the exported command or argument builder showing paths with spaces and metacharacters either bypass the shell or are quoted, with unsafe characters rejected
- Approval-gated Windows packaging run from a project path that contains a space

## VAL-065

downloadFileWithRedirects rejects within a bounded time on connect stalls, idle body stalls, mid-body connection resets, response 'aborted' or 'error', and file-stream errors. It removes the partial destination file and settles exactly once. Redirect limits and the HTTPS-only production transport are preserved.

Evidence:
- Unit tests in tests/packageApp.test.js using an injected request function or a local test server for stall, reset and success cases
- Assertion in the tests that no partial file remains after each failure

## VAL-066

When any client connect fails, the initial metrics fetch fails, or a sampling fetch fails, benchmark-runtime.js sets running to false, closes every connected socket, awaits or bounds the ack loops, reports the error, and exits with code 1 instead of hanging.

Evidence:
- Unit or integration test with a stub server, or extracted lifecycle helper, showing that the process exits non-zero within a bounded time on each failure path
- Code diff showing a try/finally (or equivalent) teardown around the connect, sampling and ack phases

## VAL-067

Topology requirements are evaluated against every sample in the measured window, not only the last one. The summary reports the minimum observed value per requirement, and a window with any under-loaded sample fails.

Evidence:
- Unit test in tests/runtimeBenchmarkModel.test.js for a per-sample topology evaluator: under-loaded middle samples fail and fully loaded samples pass
- Benchmark summary JSON includes per-requirement minimum observed values

## VAL-068

Running generate-icons.ps1 no longer writes public/brand/nextra-social-card.png, so generate-social-card.js is the sole owner of that file. The required run order (icons, which produce nextra-primary-logo.png, before the social card) is documented in both scripts.

Evidence:
- Static test or grep check asserting that generate-icons.ps1 does not reference nextra-social-card.png
- Updated header comments in scripts/generate-icons.ps1 and scripts/generate-social-card.js

## VAL-069

Every HTTP call in smoke-packaged.js applies its timeout to both headers and body consumption (json() and text()). A server that sends headers but never completes the body causes a timeout error, and the stage proceeds to cleanup.

Evidence:
- Unit test using a local HTTP server that writes headers and then stalls the body, showing the exported fetch helper rejects within the timeout
- Code diff replacing direct response.json()/text() calls after fetchWithTimeout with timeout-bounded helpers

## VAL-070

smoke-packaged.js refuses to start if something already answers on the smoke port, fails fast on child spawn error or early child exit, and verifies that the server answering the port belongs to the launched executable before sending destructive requests (kill-media-worker, shutdown).

Evidence:
- Unit tests for exported pre-launch port check and ownership-verification helpers, with stubbed process lists and responses
- Test or harness run showing the smoke fails with a clear message when the port is pre-occupied

## VAL-071

Smoke cleanup force-kills only processes owned by this run (the spawned child, its descendants, and PIDs adopted through verified ownership). An unrelated Nextra caxa instance started after the baseline is not killed.

Evidence:
- Unit test for the exported cleanup-target selector: an unrelated concurrent caxa PID outside the owned set is excluded

## VAL-072

Process enumeration failures (non-zero exit, ENOBUFS, empty output, invalid JSON) fail closed. A baseline enumeration failure aborts before launch, and a cleanup enumeration failure is reported as an error. The spawned child is killed through its handle, so the script always exits.

Evidence:
- Unit tests showing that listProcesses failure cases produce an error rather than an empty list, and that cleanup returns an error
- Code diff showing child.kill on the child handle and no lingering referenced ChildProcess on failure paths

## VAL-073

The graceful-shutdown stage checks the shutdown response, treats only connection refusal or reset (not an abort timeout) as the server going down, and asserts that owned processes exit within a deadline. Any owned process still alive after the shutdown deadline is recorded as a failure, even if cleanup later force-kills it.

Evidence:
- Unit tests for the exported shutdown evaluation: an abort-timeout is not counted as stopped, and survivors are reported as failures
- Smoke output (approval-gated packaged run) printing the observed child exit code and the survivor check result

## VAL-074

Existing script behaviour stays intact: dependency-license checks, the cloudflared and FFmpeg verified download paths, the benchmark threshold checks, the brand asset outputs other than the social card, and the smoke stage sequence. Existing tests keep passing.

Evidence:
- Repository test script result after each task
- No changes to exported function signatures that existing tests depend on, or matching test updates

## VAL-075

With LOCAL_HTTPS=false and a public HTTPS share/tunnel origin configured, a request arriving from a loopback peer with Host equal to the share host and no Origin, Referer or operator token is not operator-authorized. POST /api/cloudflare-turn-credentials and GET /api/metrics return 403, and isOperatorSocketAuthorized-equivalent socket checks deny create-room without a token. The same holds when the request is otherwise identical but Host matches over https.

Evidence:
- New/updated test in tests/operatorBoundary.test.js or tests/serverIntegration.test.js exercising loopback requests with Host=<share host> and no Origin/Referer, asserting 403 and non-loopback classification
- Test output showing the scheme-independent host match

## VAL-076

A loopback-peer request carrying Cloudflare tunnel evidence (cf-connecting-ip, cf-ray, or cdn-loop containing cloudflare) is never classified as kind 'loopback' or granted operator access without a valid token, even when Origin is spoofed to http://127.0.0.1:PORT.

Evidence:
- Unit/integration test with spoofed Origin=http://127.0.0.1:PORT plus cf-connecting-ip from a loopback peer asserting operator denial

## VAL-077

Direct local operator access is preserved. A loopback request with Host localhost:PORT, 127.0.0.1:PORT or [::1]:PORT and no proxy evidence headers is still operator-authorized without a token, and trusted-LAN behavior is unchanged.

Evidence:
- Regression test asserting 200 for /api/metrics from loopback with local Host and no proxy headers
- Existing operatorBoundary tests pass unchanged

## VAL-078

A non-loopback peer that sends Host/Origin equal to the public share URL plus an arbitrary cf-connecting-ip is identified by its own socket address. Rotating cf-connecting-ip yields the same identity, so per-IP connection and TURN-mint rate limits accumulate for that peer.

Evidence:
- Unit test of the client-identity helper with remoteAddress=192.168.1.50, share-host headers and varying cf-connecting-ip, asserting a constant identity equal to the normalized socket IP

## VAL-079

Tunnel viewers arriving from the loopback cloudflared peer with distinct cf-connecting-ip values still receive distinct 'public-share:<ip>' identities, and the identity is 'public-share-proxy' when the header is absent. These identities never satisfy isLocalClientIp.

Evidence:
- Unit test asserting per-viewer public-share identities from a loopback peer and isLocalClientIp=false for them

## VAL-080

When the local listener is plain HTTP (LOCAL_HTTPS=false), the Content-Security-Policy response header does not contain upgrade-insecure-requests. When LOCAL_HTTPS=true and ALLOW_INSECURE_TRUSTED_LAN_RELAY is false, it does. All other CSP directives, including the script nonce, are unchanged.

Evidence:
- Test asserting CSP header contents for both LOCAL_HTTPS settings (integration request or unit test of an extracted CSP-options builder)

## VAL-081

With BIND_HOST=::1 the advertised host-page URL uses [::1], and the socket origin allowlist accepts http(s)://[::1]:PORT. With WHIP_BIND_HOST=::1 the whipHttpHost/whipHttpUrl exposed via /api/config and server-config point at [::1] and an HTTP request to the advertised whipHttpUrl reaches the WHIP listener. The default IPv4 binding still advertises 127.0.0.1.

Evidence:
- Unit test of the URL-derivation helpers for ::1, [::1], 0.0.0.0, ::, localhost and 127.0.0.1 inputs
- Integration test (skipped when IPv6 loopback is unavailable) requesting the advertised WHIP URL

## VAL-082

A cached TURN credential response advertises the remaining lifetime: ttlSeconds is at most the original ttlSeconds minus the elapsed whole seconds since minting, and greater than 0. A fresh mint still returns the provider TTL. The cached payload object is not mutated across responses.

Evidence:
- Unit test with injected clock / stubbed credential loader asserting decreasing ttlSeconds on cache hits

## VAL-083

If an unhandled rejection or uncaught exception occurs while a graceful shutdown is in progress, or shutdown() itself rejects, the process runs cleanup and exits with a non-zero code within a bounded time. The graceful path's force-exit timer is armed before its first await, so no code path leaves the process alive and half torn down.

Evidence:
- Unit test of an extracted shutdown coordinator with injected exit/cleanup/timer functions asserting exit(1) when a fatal error arrives mid-shutdown and when shutdown throws before cleanup
- Assertion that the force-exit timer is scheduled before the first awaited step

## VAL-084

A normal graceful shutdown (SIGTERM/SIGINT or the SMOKE_TEST endpoint) with no errors still emits room-ended, cleans up, and exits 0.

Evidence:
- Existing serverIntegration/smoke shutdown tests pass
- Coordinator unit test for the happy path asserting exit(0)

## VAL-085

Worker-crash recovery follows the model chosen in section-907fcaeb0abb75a2dbbcbaee/UQ-002. No path combines a discarded-output detached replacement with exit code 0. In supervisor mode the process exits non-zero without spawning a replacement. In any self-restart mode the replacement's output is preserved (inherited or logged) and signals from the launching console reach it, or the deviation is documented. The startup-crash 'exit' action is unchanged.

Evidence:
- Updated tests/workerRecovery.test.js covering the decision function's new actions
- tests/workerProcessRecovery.test.js passing with updated expectations

## VAL-086

Activating the skip-to-content link does not change the router route. The current view (e.g. Host while sharing) stays mounted, NotFound is not rendered, the navigation guard is not triggered, and focus moves to the main region.

Evidence:
- Playwright test in tests/browser/ui-semantics.spec.mjs: focus skip link, press Enter on #host/#watch, assert route content unchanged, no 'Page not found' heading, and document.activeElement is #main

## VAL-087

Re-rendering a parent with a new onClose function identity while a Modal is open does not move focus. Escape and backdrop clicks invoke the latest onClose. Focus moves into the dialog once on open and is restored to the trigger once on close.

Evidence:
- Automated test (DOM unit harness if present, otherwise Playwright) that forces a parent re-render with a fresh onClose while focus is on a non-first control and asserts focus stays put

## VAL-088

The client socket configuration falls back to HTTP long-polling when the WebSocket transport cannot connect (tryAllTransports enabled on socket.io-client >= 4.8, or an equivalent polling-capable configuration), and still prefers WebSocket when available.

Evidence:
- Unit test of an extracted socket-options module asserting the fallback-enabling option
- Optional Playwright test blocking WebSocket upgrades and asserting the socket connects via polling

## VAL-089

sanitizeDiagnosticText redacts all of the following:
- 'Authorization: Basic <b64>' credentials in full
- JSON-quoted secrets such as {"token":"abc123"} and {"password": "x y"}
- room codes in contexts like 'Room AB12CD not found', '/whip/AB12CD', '/whep/AB12CD' and '#watch/AB12CD'
- rtmp/rtsp/srt/file URLs, scheme-less host:port and IP addresses
- uppercase hex of 32+ characters and base64 tokens containing + / =
Existing redaction behavior and benign text such as encoder names and version numbers are preserved.

Evidence:
- New cases in tests/diagnosticBundle.test.js for each format (a)-(e) from the issue, plus negative cases for benign text

## VAL-090

If HostView unmounts, or the host stops or terminates, while handleStartSharing is awaiting getDisplayMedia, room creation, transport/producer setup or OBS configuration, the stale continuation stops any newly acquired media tracks and does not install the stream or create further transports/producers. It also emits host-stopped for any room it created, opens no OBS control channel, and does not update state for the torn-down session.

Evidence:
- Automated test (Playwright with stubbed getDisplayMedia / socket, or unit test of an extracted operation-guard helper) asserting tracks stopped, no produce request after teardown, and no control channel opened

## VAL-091

After a successful 'Retry Auto-Configure OBS', a live OBS control channel exists, so stopObsIngest sends StopStream through it. When a control channel's ready state reports failure, obsControlChannelRef is cleared, so explicit Stop and pagehide teardown use the stopObsStream fallback instead of a dead channel. A retry whose session was torn down does not open a channel.

Evidence:
- Test with a stubbed obsWebSocket module asserting openObsControlChannel is called after a retry success, the ref is nulled on ready failure, and stopObsStream is used as fallback

## VAL-092

After stop(), a get-media-init acknowledgement that arrives later, from either requestCurrentInit or resetAndRequestInit and whether it succeeds or fails, does not create a MediaSource. It also does not change videoElement.src, call setupMediaSource, change state from 'stopped', or invoke onStateChange or onError.

Evidence:
- Unit test in tests/fmp4RelayPlayer.test.js using a fake socket that holds the ack callback, calls stop(), then delivers success and failure acks; asserts no MediaSource construction, src remains '', state 'stopped', and no callbacks
- Code diff showing an epoch/stopped guard in every init ack callback and in the sourceopen handler

## VAL-093

resetAndRequestInit retries an unsuccessful or unavailable get-media-init response with the same bounded retry policy as requestCurrentInit, and arms an init timeout. A missing ack eventually leads to a retry or one surfaced error, never an indefinite 'buffering' state.

Evidence:
- Unit test with fake timers: first reset response unavailable then success leads to playback setup and no handleError
- Unit test with fake timers: ack never delivered leads to the timeout firing and either a retry or a single onError after the retry budget
- Unit test: stop() during reset recovery clears retry and timeout timers

## VAL-094

A non-quota appendBuffer exception, a MediaSource 'sourceclose', or a video element 'error' while running causes at most one onError/console.error per failure episode. Fragments after the failure are not re-appended to the broken SourceBuffer. A bounded recovery through resetAndRequestInit is attempted, and a media-init for the same generation is accepted after the reset.

Evidence:
- Unit test: appendBuffer throws InvalidStateError and N further fragments arrive; onError is called once and appendBuffer is not called on the failed buffer again
- Unit test: recovery re-requests init and resumes appends on the new SourceBuffer
- Unit test: repeated failures beyond the recovery budget end in exactly one terminal error
- Existing QuotaExceededError tests remain passing

## VAL-095

When the user pauses the relay video intentionally, live sync does not call play() on later ticks. Automatic resume after the player's own start or stall handling still works, and a user-initiated play clears the pause intent.

Evidence:
- Unit test with fake timers and a fake video element: emit user 'pause' after playback starts; several LIVE_SYNC_INTERVAL_MS ticks with ahead >= START_BUFFER_SECONDS do not call play()
- Unit test: user 'play' clears the flag, and subsequent stalls auto-resume as before
- Existing tests/relayLiveSync.test.js and tests/fmp4RelayPlayer.test.js pass

## VAL-096

Evaluating the HostView module does not throw when reading window.localStorage throws a SecurityError. Media debug logging falls back to the URL flag or disabled.

Evidence:
- Unit test in tests/mediaDebug.test.js: isMediaDebugEnabled (or the new safe accessor) returns a boolean when storage is null or its getter throws
- Code diff: no module-scope expression in src/HostView.jsx reads window.localStorage outside try/catch

## VAL-097

On reload recovery, a transient reclaim failure, such as a timeout or disconnect without err.terminal === true, is retried within the recovery window and does not call terminateHostSession or clear the stored recovery session until the bounded retries are exhausted. A terminal failure ends the session immediately, as it does today.

Evidence:
- Unit tests for a pure helper (e.g. src/lib/hostRecovery.mjs classifyReclaimFailure) covering terminal, timeout, disconnect and unknown errors
- Code diff showing that the reclaimStoredRoom catch uses the classification and a bounded, cancellable retry

## VAL-098

When reclaiming a stored room whose ingestMode is 'obs' finally fails, an OBS stop is issued using the stored ingest mode, even though ingestModeRef is still 'browser'.

Evidence:
- Unit test for a helper deciding whether an OBS stop is required after a failed reclaim, given the stored session
- Code diff showing that the failure path calls the stop fallback (stopObsStream with the session password) when stored.ingestMode === 'obs'

## VAL-099

On 'Resume Sharing' for a reclaimed browser room, a NotAllowedError from the picker, a getDisplayMedia failure, or a preflight blocker raised before any media is produced does not emit 'host-stopped'. It also keeps resumeRoomRef, the resume-pending state and the stored recovery session, stops any partially acquired tracks, and leaves the button showing 'Resume Sharing'. Failures after the room is in use keep the existing full teardown.

Evidence:
- Unit tests for a pure helper (e.g. shouldTeardownAfterStartFailure({ resumed, phase, errorName })) covering the cancel, preflight, post-transport and fresh-room cases
- Code diff showing the phase-aware catch in handleStartSharing

## VAL-100

While a recovered browser room is pending resume, the host cannot switch the ingest mode to one that differs from the recovered room's mode. handleStartSharing also refuses, without destroying the room, to reuse a recovered room whose ingest mode differs from the current ingestMode.

Evidence:
- Code diff: the OBS mode toggle is disabled with an explanatory hint when resumePending is true, and handleIngestModeChange ignores mismatched changes
- Unit test for the mismatch guard helper
- Optional Playwright check that the toggle is disabled in the resume-pending state if a recovery fixture exists

## VAL-101

If teardown (Stop Sharing, Leave and Stop, room-ended, or unmount) happens while configureObsStream is awaiting, the continuation does not update obsAuto state, does not open or store a control channel, and issues a compensating OBS stop. No control channel stays open after unmount.

Evidence:
- Unit tests for a session-guard helper (new or reused from src/lib/lifecycleController.mjs) showing that a stale token is rejected after teardown
- Code diff showing the session token captured before the await and checked after it, a compensating stopObsStream on stale continuations, and teardown paths invalidating the token

## VAL-102

A relay MediaRecorder error or an unexpected stop on the non-MP4 format, or after relayMp4Failed is already true, restarts the relay recorder while relay is still needed. Restarts are bounded, and the safety-flush interval and silent-audio context of the failed recorder are released. Errors from superseded generations are ignored.

Evidence:
- Unit tests for a restart-budget helper (e.g. in src/lib/relayRecorderFormat.mjs) covering allow, deny-after-cap and window reset
- Code diff showing onerror/onstop for the current generation scheduling a restart through state the membership effect depends on

## VAL-103

The HowTo Security and privacy section no longer claims that all media is DTLS-encrypted. It states that WebRTC paths are DTLS-encrypted and that relay media travels over the page connection, so that media is encrypted only to the extent the page connection is. TLS for the public link ends at the tunnel provider, and a plain-HTTP local link is not encrypted.

Evidence:
- grep for the old sentence returns no match
- Code diff of src/HowToView.jsx reviewed against lib/https.js and lib/tunnel.js behavior
- npm run build succeeds

## VAL-104

On short viewports, for example a landscape phone of about 844x390 CSS px and heights at or below --stage-chrome, the .video-container on the host and watch pages renders with a positive width at least equal to the agreed minimum (capped at 100% of its container), keeping a 16:9 aspect ratio. Desktop viewport sizing is unchanged.

Evidence:
- Playwright spec (tests/browser/ui-semantics.spec.mjs) setting viewports 844x390, 667x375 and 1440x900, and asserting the .video-container bounding box width > 0 and >= min floor on short viewports and unchanged on desktop
- CSS diff showing the max() floor inside the height term and corrected comments

## VAL-105

The existing repository test suite and production build pass after each task, with no regressions to unrelated behavior.

Evidence:
- npm test exit code 0
- npm run build exit code 0

## VAL-106

Repeated chunk-load errors across page loads trigger at most a bounded number of reloads within a time window, tracked in sessionStorage. After that, no further reload happens, and the guard resets after a successful load or once the window expires.

Evidence:
- Unit test simulating consecutive loads with persisted sessionStorage and a stubbed location.reload call count

## VAL-107

After any overflow drop, the relay player discards incoming fragments until a chunk with keyframeStart === true arrives. Interleaved drops can never append a mid-GOP fragment.

Evidence:
- tests/fmp4RelayPlayer.test.js case: overflow, then non-keyframe chunks are not enqueued, then a keyframe chunk is enqueued

## VAL-108

relay-ack is emitted only for fragments that were accepted into the append queue. It is not emitted for fragments dropped by overflow.

Evidence:
- tests/fmp4RelayPlayer.test.js case asserting socket.emit('relay-ack') count when fragments are dropped

## VAL-109

socketRequest does not resend create-room or join-room after an ack timeout or a disconnect that may follow server receipt. Server error responses whose message contains 'timed out' are not classified as transient. Connect-phase failures are still retried.

Evidence:
- tests/mediasoupClient.test.js cases counting emits per event under ack timeout, server error, and connect failure

## VAL-110

Calling openObsControlChannel().close() before Identified closes the underlying WebSocket. ready resolves without success. A later handshake never re-arms sendRequest, and stopStream() resolves false.

Evidence:
- tests/obsWebSocket.test.js case with a fake WebSocket that sends Hello/Identified after close()

## VAL-111

When the configureObsStream transaction deadline expires, rollback requests are sent over the still-open connection before it closes. The resolved result reports the timeout together with the rollback outcome.

Evidence:
- tests/obsWebSocket.test.js case with a stalled request, fake timers, and recorded inverse requests sent before ws.close

## VAL-112

A mutating request that times out or throws after dispatch still has its pre-captured inverse journaled, so rollback replays it.

Evidence:
- tests/obsWebSocket.test.js case: SetVideoSettings times out, rollback issues SetVideoSettings with the snapshot

## VAL-113

Rolling back a profile parameter whose snapshot parameterValue was null sends parameterValue null (delete), not an empty string.

Evidence:
- tests/obsWebSocket.test.js case inspecting the rollback SetProfileParameter payload

## VAL-114

During rollback, a StopStream inverse is followed by GetStreamStatus polling until the output is inactive, or a bounded timeout is recorded as a failure, before the next inverse is dispatched.

Evidence:
- tests/obsWebSocket.test.js request-order assertion

## VAL-115

During rollback, a StartStream inverse that follows a restored SetVideoSettings waits at least the forward-path settle delay (1200 ms) before dispatch.

Evidence:
- tests/obsWebSocket.test.js with fake timers asserting no StartStream before the delay elapses

## VAL-116

The housekeeping test stream is always stopped, including on a request exception between StartStream and StopStream. The StopStream result and inactivity are verified. If inactivity is not confirmed, configuration aborts before any video or encoder mutation.

Evidence:
- tests/obsWebSocket.test.js cases: getStreamStatus throws mid-run; StopStream rejected; status stays active

## VAL-117

With autoStart false, configureObsStream behaves as resolved in section-84098610a3c7f7be0c63f39f/Q-001. Either no StartStream is sent at all, or the test stream runs only behind the explicitly agreed gate, and the gate is asserted by the test.

Evidence:
- tests/obsWebSocket.test.js 'without auto-start' case asserting the StartStream count on the request log

## VAL-118

If configuration fails after a successful encoder-file write, rollback restores the previous file through the undo hook. If the hook cannot restore it, the failure message says the encoder file was not restored and does not claim settings were restored.

Evidence:
- tests/obsWebSocket.test.js case with a writeEncoderSettings double recording write/restore calls and the message text

## VAL-119

When a restart-required condition is detected and autoStart is true, StartStream is not sent. The result carries the outcome agreed in section-84098610a3c7f7be0c63f39f/Q-003 (default: restartRequired flag with a warning).

Evidence:
- tests/obsWebSocket.test.js case with previous Mode 'Simple' and autoStart true asserting no StartStream

## VAL-120

With a window.localStorage getter that throws SecurityError, the WatchView module evaluates, the media debug flag resolves to false, and the Watch route renders the Join Room form. When storage is accessible, existing debug-flag behavior is unchanged.

Evidence:
- node:test case for the safe storage accessor or isMediaDebugEnabled with a throwing storage getter
- Playwright case that installs a throwing localStorage getter via addInitScript and asserts the 'Join Room' button is visible on #watch
- Existing tests/mediaDebug.test.js cases still pass

## VAL-121

A StatusView poll tick never aborts an in-flight metrics request. A request that exceeds the per-request timeout is aborted and shows a visible error rather than being silently swallowed. Unmount still aborts the outstanding request without showing an error.

Evidence:
- node:test cases for the extracted single-flight metrics fetcher using a fake fetch and fake timers: overlapping ticks yield one request, slow success is applied, timeout yields a timeout error, unmount abort yields no error
- Code diff showing StatusView no longer calls abort() at the start of each poll

## VAL-122

Once a playback attempt is superseded (by cleanupPlayback or a newer attempt), it writes no shared refs (recvTransportRef, mediaSourceRef, objectUrlRef, sourceBufferRef, relaySubscribedRef), does not touch the video element, closes or revokes only the resources it created, and sends relay-consume-stop if it subscribed. Its rejection does not cause cleanupPlayback or setError in handleWatch, onTransportFailed or onReconnect.

Evidence:
- node:test cases for the extracted attempt-ownership helper: a stale token check throws a superseded error, and the dispose callbacks of the stale attempt run
- Code review checklist: an attempt-current check follows every await in startMediasoupPlayback, consumeProducer and startRelayPlayback
- Playwright or unit scenario: cleanupPlayback called during an in-flight relay attempt leaves the video element src empty and records one relay-consume-stop

## VAL-123

transport-failed (recoverable) and socket reconnect cannot run overlapping recovery attempts. A second trigger during an active recovery is coalesced or ignored, and at most one playback attempt is in flight.

Evidence:
- node:test case for the shared recovery guard showing that concurrent triggers produce one execution
- Code diff showing onTransportFailed and onReconnect use the same recovery guard

## VAL-124

startMediasoupPlayback rejects with the ICE timeout error within the configured 2s (tunnel fail-fast) or 8s window, plus a bounded margin, even when HTMLMediaElement.play() never settles. Try WebRTC and automatic recovery paths always clear watchLoading within the overall deadline.

Evidence:
- Playwright case that stubs HTMLMediaElement.prototype.play to return a never-settling promise and blocks ICE (or a unit test with fakes), asserting that the rejection message and loading-state reset occur within the deadline
- Existing autoplay-denial and direct WebRTC Playwright tests still pass

## VAL-125

After relay playback starts, a queue overflow, SourceBuffer 'error', or MediaSource closing or ending unexpectedly tears down the MediaSource, sets watching to false and playbackMode to '', displays the specific failure message (for example 'Relay playback fell behind and must be restarted.'), and makes the Watch Stream button visible again. During startup, the specific overflow message is the one surfaced to the user, not the generic 'cleaned up' error.

Evidence:
- node:test cases for the extracted relay generation and append-queue module covering overflow and error transitions
- Code diff showing failRelayGeneration no longer uses fallbackState and settles the first-buffered promise with the specific failure before generic cleanup
- Playwright relay-mode check that the status line no longer reports 'relay mode active' after an injected failure

## VAL-126

A synchronous appendBuffer failure does not silently discard a chunk. The chunk stays at the head of the queue and its byte count is deducted only after a successful append. QuotaExceededError triggers eviction and a bounded retry. Any other append error transitions the generation into the recoverable failure state from VAL-125.

Evidence:
- node:test cases with a fake SourceBuffer that throws QuotaExceededError once (the chunk is retried and queued bytes are preserved) and throws InvalidStateError (a generation failure is reported)

## VAL-127

If Leave Room completes while a reconnect-triggered joinRoomAndLoadDevice is in flight, the stale completion does not set joined, joinedRoomCodeRef or room capability state, and does not start playback. The view remains on the join form. A compensating leave-room follows the section-49e0545c60d121dd3e784d86/Q-003 decision.

Evidence:
- node:test case for the extracted viewer-session generation helper: a join completion whose generation is behind the current one is rejected as stale
- Code diff showing that handleLeave bumps the session generation synchronously before awaiting leave-room, and that joinRoomAndLoadDevice commits state only after a generation check

## VAL-128

fallback-consume-start uses a bounded acknowledgement timeout. On timeout, disconnect, leave, room end or reconnect, isEnteringFallbackRef is cleared and the fallback UI resets with an error. After a reconnect, enterFallbackMode can start fallback again.

Evidence:
- Code diff replacing the raw socket.emit ack with a timed request
- Unit or Playwright scenario: a server that never acks leaves fallbackState out of 'connecting' after the timeout, and a later enterFallbackMode emits fallback-consume-start again

## VAL-129

A late fallback-consume-start ack that belongs to a superseded viewer session (left, room ended, newer session or attempt) does not call cleanupPlayback, does not create or start an fMP4 player, and does not fall back to codeInput when joinedRoomCodeRef is empty. It sends fallback-consume-stop for the orphaned server-side subscription.

Evidence:
- node:test or code-review check of the ack ownership guard
- Code diff removing the codeInput fallback for roomCode in the ack path

## VAL-130

The media-flow Playwright serialization lock gives mutual exclusion under concurrent acquisition, including an acquirer that publishes late. At most one holder exists at any time, release is owner-checked, and a stale lock from a dead process is recovered.

Evidence:
- node:test case that starts N concurrent acquirers with randomized delays against the extracted lock helper and asserts that the maximum observed concurrent holders is 1
- node:test case for stale-lock recovery
- Diff showing that media-flow.spec.mjs beforeEach and afterEach use the helper and no longer sort ticket files

## VAL-131

A multi-slice IDR access unit receives one cached SPS/PPS pair before its first IDR slice only (pushFrames output [7, 8, 5, 5]). An access unit that already carries in-band SPS/PPS gets no duplicates. Each separate keyframe access unit still gets injected parameter sets, and single-IDR push() behavior ([7, 8, 5]) is preserved.

Evidence:
- Updated and new cases in tests/h264Depacketizer.test.js covering multi-slice IDR, in-band SPS/PPS, consecutive keyframes and the push() path
- All existing h264Depacketizer tests pass apart from the intentionally corrected [7, 8, 5, 7, 8, 5] expectation

## VAL-132

A client-supplied leftmost X-Forwarded-For value and a client-supplied CF-Connecting-IP passed through a non-Cloudflare loopback proxy are never returned as the trusted client IP. The resolved IP follows the trust model decided in section-49e0545c60d121dd3e784d86/Q-001 (rightmost untrusted hop; CF-Connecting-IP only under the Cloudflare trust mode).

Evidence:
- Updated tests/network.test.js cases: 'spoofed, real' X-Forwarded-For resolves to the proxy-appended value, and CF-Connecting-IP is ignored unless the Cloudflare trust mode is enabled
- tests/operatorBoundary.test.js and tests/serverIntegration.test.js pass unchanged or are updated deliberately with justification

## VAL-133

The 'without auto-start' OBS test records StartStream requests and fails if configureObsStream sends StartStream after configuration when autoStart is false on the live-output path. It also asserts that the output is inactive at the end.

Evidence:
- Diff of tests/obsWebSocket.test.js showing StartStream recorded in order and an assertion that no StartStream appears
- A local mutation check (temporarily forcing StartStream at the end of configureObsStream) makes the test fail, then the mutation is reverted

## VAL-134

configureObsStream with autoStart false, including from an idle OBS, delivers no media to viewers of the target room before the host chooses to go live. The encoder-release behavior follows the approach decided in section-49e0545c60d121dd3e784d86/Q-002, and tests assert the new request order and target.

Evidence:
- Updated obsWebSocket tests asserting that the encoder-reset stream never targets the room WHIP URL (or is skipped) when autoStart is false
- Server or route test, if the probe-target option is chosen, proving that probe sessions are not fanned out to viewers

## VAL-135

While a relay capacity probe is armed, a request with a wrong token returns 404. The armed token is not consumed by that wrong request: the correct-token download still succeeds and the measurement completes.

Evidence:
- tests/relayCapacityProbe.test.js contains a wrong-token fetch inside fetchImpl, before the correct-token fetch, with its status asserted to be 404.
- node --test tests/relayCapacityProbe.test.js output for the 'serves one armed download and nothing else' case.

## VAL-136

The disconnect-during-creation case waits on a deterministic completion signal for the released prepareRoom (including its scrypt hash) and the handler step after it, not on a fixed sleep. Afterward, the room count equals the baseline and no pending reservation remains. Teardown happens only after that creation has settled.

Evidence:
- tests/roomCreationConcurrency.test.js no longer contains 'setTimeout(resolve, 25)'.
- node --test tests/roomCreationConcurrency.test.js output.
- A manual mutation check: temporarily disabling disconnect cancellation in a scratch copy makes the test fail.

## VAL-137

After a WHIP start is rejected with 409 (same room) or 503 (public pending capacity), the winner's claim is intact. Before the winner is released: room.whipStarting stays true, a further request is still rejected, and enteredCount stays 1. After release, two overlapping starts again admit only one, which proves the pending counter did not go negative.

Evidence:
- New assertions in tests/whipRoutes.test.js in both race tests.
- node --test tests/whipRoutes.test.js output.

## VAL-138

For a video+audio WHEP offer, the 201 answer has exactly two m-sections in offer order (video mid 0, then audio mid 1), 'a=group:BUNDLE 0 1', and a=sendonly with an a=ssrc line in each section. Its a=setup is consistent with the remote DTLS role 'client' (a=setup:passive).

Evidence:
- New SDP structure assertions in the success test of tests/whepRoutesSession.test.js.
- node --test tests/whepRoutesSession.test.js output.

## VAL-139

When the audio consume() fails, the 201 answer still has an audio m-section at mid 1 in second position. That section is rejected (port 0 and/or a=inactive) and has no a=ssrc or a=sendonly. The BUNDLE group lists only mid 0, and the video section is sendonly with its SSRC.

Evidence:
- The partial-failure test in tests/whepRoutesSession.test.js reads the answer body and asserts the audio section state.
- node --test tests/whepRoutesSession.test.js output.

## VAL-140

The createViewerAnswer tests no longer require an extension the viewer never offered. Every (id, uri) a=extmap pair in each answer m-section appears in the matching offer m-section. A positive fixture whose consumer IDs match the offer shows the offered extension is kept.

Evidence:
- tests/whep.test.js no longer asserts 'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'.
- A new per-section extmap subset assertion exists (todo-marked with C-b5febf64d2e0 if production does not yet comply).
- node --test tests/whep.test.js output.

## VAL-141

Stream state is visible in the OBS failure-path tests, and those tests pin the outcome. Case 1: setup stops a stale (reconnecting) stream, then fails, and OBS ends with outputActive false with no StartStream issued after rollback restored the previous service. Case 2: setup fails after the encoder-reset test stream ran, and OBS ends not streaming. The withStream fake exposes its status object to the test.

Evidence:
- New failure-path tests in tests/obsWebSocket.test.js that assert on obs.status and obs.order.
- withStream accepts a caller-owned status object, and existing callers still pass.
- node --test tests/obsWebSocket.test.js output.

## VAL-142

Through a loopback peer with TRUST_X_FORWARDED_HEADERS=true, a multi-hop X-Forwarded-For chain whose rightmost (proxy-appended) hop is remote is treated as remote, even when the leftmost entry is a spoofed loopback or trusted-LAN address. Concretely: '127.0.0.1, 203.0.113.40' gets 403 on /api/metrics; create-room without an operator token is denied with 'Operator authorization'; and '192.168.50.25, 203.0.113.61' gets relayAllowed false.

Evidence:
- A new XFF-chain test case in tests/serverIntegration.test.js (todo-marked with C-70eb68e12178/C-993924baa102 if production still trusts the leftmost hop).
- node --test tests/serverIntegration.test.js output.

## VAL-143

With NEXTRA_SMOKE_TEST unset, POST /api/test/shutdown, /api/test/unhandled-rejection and /api/test/kill-media-worker each return 404. Afterward the server process is still running, /healthz returns 200, and the media worker PID is unchanged.

Evidence:
- New tests/testControlEndpoints.test.js.
- node --test tests/testControlEndpoints.test.js output.

## VAL-144

By default the Vite dev and preview servers do not allowlist '.trycloudflare.com'. It is added only when the explicit opt-in env flag is set, and SHARE_BASE_URL/EXTRA_ALLOWED_ORIGINS entries are still honoured. Both proxy entries (/socket.io and /api) set xfwd: true so the backend receives the real client address.

Evidence:
- The vite.config.mjs diff.
- New tests/viteConfig.test.js evaluates the exported config function with and without the opt-in flag.
- node --test tests/viteConfig.test.js output.

## VAL-145

With forwarded-header trust enabled and a loopback peer, getTrustedForwardedClientIp returns only the valid rightmost X-Forwarded-For entry. A spoofed 'X-Forwarded-For: 127.0.0.1, 203.0.113.5' returns '203.0.113.5'. CF-Connecting-IP is never returned, whether or not X-Forwarded-For is present. A request carrying CF-Connecting-IP '127.0.0.1' or '192.168.1.5' and no X-Forwarded-For returns 'unknown', and classifyClient gives 'remote' even with TRUSTED_LAN_CIDRS '192.168.1.0/24'. An invalid rightmost X-Forwarded-For returns 'unknown'. A loopback peer with no forwarding headers returns ''. Trust disabled or a non-loopback peer returns ''.

Evidence:
- New tests in tests/network.test.js for each case listed in the assertion
- The legacy CF-preference expectation is updated to the rightmost X-Forwarded-For value, with a comment citing C-70eb68e12178
- node --test tests/network.test.js exit code 0
- Caller list showing that no caller converts '' or 'unknown' into the loopback TCP peer for requests that carry forwarding evidence

## VAL-146

With the explicit Cloudflare trust mode off (the default), a loopback-proxied request carrying only CF-Connecting-IP never resolves to a loopback or trusted-LAN identity and classifies as 'remote'. With the mode on, a valid CF-Connecting-IP is honoured. X-Forwarded-For resolves to the rightmost entry after skipping the configured trusted hop count.

Evidence:
- Updated tests/network.test.js cases for mode off and on, and for trusted hop counts 1 and 2
- tests/operatorBoundary.test.js and tests/serverIntegration.test.js pass, or are updated deliberately with justification

## VAL-147

WHEP H.264 matching, in both buildViewerRtpCapabilities and the answer codec matcher, compares the profile parsed from profile_idc plus the profile-iop bit pattern (libwebrtc/mediasoup isSameProfile semantics). It ignores level, requires equal packetization-mode (default '0'), and treats an absent or empty profile-level-id as 42e01f (Constrained Baseline). An unparseable value never matches. Concretely: an absent offer profile matches a 42e01f router codec and does not match 42001f or 640032; 42e01f does not match 42001f; 640c1f does not match 64001f; 42e01f matches 42e034; 4d801f matches 42e01f; uppercase hex matches lowercase. Filtered H.264 capabilities carry the viewer's own profile-level-id and packetization-mode.

Evidence:
- Table-driven tests in tests/whep.test.js with an explicit expected boolean per row, exercised through the shared helper, createViewerAnswer and buildViewerRtpCapabilities
- Test runner output for tests/whep.test.js

## VAL-148

For WHIP offers with a=setup:passive, createAnswer emits a=setup:active in every answered m-section and parseDtlsParameters returns remote role 'server'. For a=setup:active, a=setup:actpass or no setup attribute (media- or session-level), createAnswer emits a=setup:passive and parseDtlsParameters returns 'client'. The answer's setup and the connect role are therefore never both passive or both active, and the actpass (OBS) answer is unchanged apart from the o= line.

Evidence:
- tests/whip.test.js cases that build parseDtlsParameters and createAnswer from the same parsed offer for passive, active, actpass and absent setup, and assert the paired values
- node --test tests/whip.test.js exit code 0, produced during implementation

## VAL-149

The packaged smoke classifies child exits by harness phase. A spawn error, or an exit before readiness or during the non-destructive stages, aborts the run promptly. A code-0 exit without a signal after kill-media-worker is accepted is tolerated, and recovery succeeds only through an adopted replacement PID plus readiness. Any exit after the harness enters the shutdown or cleanup phase is never reported as unexpected.

Evidence:
- Unit tests for the exported classifyChildExit and createChildExitMonitor using a fake EventEmitter child: unexpected, tolerated-recovery and expected cases, with no unhandled rejections
- Simulated recovery-stage test in which the child exits with code 0 and a replacement is adopted (passes), and the same without adoption (fails, reporting the recorded exit)

## VAL-150

The graceful-shutdown stage enters the shutdown phase before sending the shutdown request, so the requested child exit satisfies the stage instead of aborting it. When the child already exited during recovery, the stage relies on owned-PID liveness rather than a child exit event. A child exit with a non-zero code or a signal in the shutdown phase is a failure.

Evidence:
- Unit tests for the exported evaluateShutdown covering a code-0 exit in the shutdown phase (pass), an exit already recorded in recovery with no owned survivors (pass), a non-zero or signal exit in the shutdown phase (fail) and surviving owned PIDs (fail)
- Approval-gated packaged smoke log showing the shutdown phase transition and the child exit record, or 'replacement exit code not observable'

## VAL-151

Consider an earlier start operation that is invalidated (by Stop, terminate or unmount) while its room-creation request is pending, and is then followed by a newer Start. The earlier operation emits no host-stopped and calls no stopObsStream after the newer operation has begun. The newer operation's create-room or reclaim-host is emitted only after the earlier operation's room request has settled and any compensation it was entitled to has been emitted. The newer room stays active, while the earlier operation's own tracks, transports and producers are still released. When no successor exists, the stale operation does emit host-stopped for the room it created, unless the teardown was a reload-preserving pagehide for a recovery-eligible room.

Evidence:
- Deterministic unit tests of src/lib/startOperationGuard.mjs with controllable promises, asserting the emitted-event order (no host-stopped after the successor's create-room) and the compensation decisions for the no-successor, successor and reload-preserve cases
- Optional Playwright scenario with a delayed create-room acknowledgement, asserting rooms.active is 1 for the successor after the stale acknowledgement arrives

## VAL-152

HostView runs all non-unload OBS operations strictly in FIFO order through one module-scope queue that survives unmount and remount: configureObsStream from Start and Retry, the stopObsStream fallback, and channel stopStream on teardown. A rejected operation does not stall later ones, and a stop enqueued for session S completes before any configure enqueued later begins.

Evidence:
- Unit tests in tests/obsOperationQueue.test.js using controllable promises, covering FIFO order, continuation after a rejected operation, and a stop for S completing before a later configure starts
- Code diff showing every configureObsStream and non-pagehide OBS stop call site in src/HostView.jsx routed through the queue

## VAL-153

A stale configure continuation for session S issues a compensating OBS stop only while the OBS ownership record still names S. If a newer session has claimed OBS, no stop is sent on S's behalf and the newer session's state and control channel are left untouched.

Evidence:
- Unit tests showing the compensating stop skipped when ownership moved to a newer token and executed when S is still the owner
- Unit test simulating teardown of S during configure followed by Start of S2, asserting the stop request order [stop for S, then configure for S2] and no stop after S2's configure

## VAL-154

During rollback, if the output is not confirmed inactive within the bounded GetStreamStatus polling after a StopStream inverse, or the status cannot be read, no further inverse of any type is dispatched. rollback() resolves with failures naming the stop failure and each skipped step, and configureObsStream's message contains 'Rollback incomplete:'.

Evidence:
- tests/obsWebSocket.test.js scripted OBS whose status stays outputActive after StopStream: the request log has only GetStreamStatus after the StopStream inverse, and the failures list skipped steps
- tests/obsWebSocket.test.js scripted OBS whose GetStreamStatus rejects during rollback: same fail-closed assertions

## VAL-155

During rollback, a StopStream inverse that OBS rejects but whose status polls show the output inactive does not abort rollback. The remaining inverses are dispatched in reverse journal order.

Evidence:
- tests/obsWebSocket.test.js request-order assertion with a rejecting StopStream and an inactive status

## VAL-156

A superseded relay playback attempt, or the cleanupPlayback relay-subscription owner, emits relay-consume-stop only when the subscription ledger shows it is still the latest relay-consume-start claimant, the socket is connected, and socket.id is unchanged since the start was emitted. If attempt A's acknowledgement arrives after attempt B's relay-consume-start has been emitted and acknowledged, no relay-consume-stop is emitted, and B's committed refs and video element source are untouched.

Evidence:
- node:test case in tests/subscriptionLedger.test.js with a fake socket. A claims and emits a start; cleanup runs; B claims, emits and is acknowledged; A's ack is then delivered. Recorded emits contain no relay-consume-stop, and B's claim is still the latest
- node:test cases: exactly one stop when no newer claim exists, no stop after a socket.id change, and no stop while disconnected
- Code review check: every relay-consume-stop emission in WatchView and useViewerSessionController is gated by ledger.canRelease

## VAL-157

A compensating or exit-path fallback-consume-stop is emitted only when the subscription ledger shows that the fallback claim is still the latest on the same connected socket.id. If a stale fallback-consume-start ack, or a timeout, comes after a newer fallback-consume-start was emitted and acknowledged, no fallback-consume-stop is emitted and the newer subscription and player stay intact.

Evidence:
- node:test case in tests/viewerSession.test.js. A's fallback ack is delivered after B's fallback-consume-start has been emitted and acknowledged; the recorded emits contain no fallback-consume-stop
- node:test cases: exactly one stop for a stale ack or timeout with no newer claim, and no stop after a disconnect or socket.id change

## VAL-158

fallback-consume-start goes through a single-attempt timed-ack helper that resolves with the raw server response. A { ok: true, fallbackAvailable: true } acknowledgement is classified as success, as it is today, and creates the fMP4 player. { ok: false, error } takes the existing error path. Timeout and disconnect reject without retrying, and no start is emitted while disconnected.

Evidence:
- node:test cases in tests/timedAck.test.js for raw passthrough of { ok: true, fallbackAvailable: true }, timeout, disconnect, an ignored late ack, no retry, and no emit while disconnected
- node:test or scenario evidence that a { ok: true } response through emitWithTimedAck reaches WatchView's success path and creates the player
- Code diff showing that fallback-consume-start is not sent through socketRequest

## VAL-159

Lock reclamation in the media-flow serialization lock never displaces a live owner and never removes a replacement owner's lock. A holder that stays alive is never reclaimed, however long it holds the lock. Reclamation happens only when the owner process on the same host is provably dead (ESRCH). When several reclaimers act on the same stale observation, including one paused while another reclaims and a new owner acquires, at most one removes the stale lock and none removes the new owner's lock.

Evidence:
- node:test case in which a live child process holds the lock well beyond any former staleMs value, asserting that no other acquirer is admitted until release
- node:test case using injected hooks to pause a reclaimer after reading stale token T while another reclaimer reclaims and a new owner acquires T2, asserting that the lock still holds T2 after the paused reclaimer resumes
- node:test case racing two reclaimers for one dead-owner token, asserting a single marker winner and a single subsequent holder
- Helper diff showing no age-, mtime- or staleMs-based reclamation and no rename of the lock path

## VAL-160

For an IDR access unit that carries only some of its parameter sets in band, the depacketizer injects exactly the missing ones before the first IDR slice, keeping SPS before PPS. With only an in-band SPS, the unit's output is [7, 8, 5]. With only an in-band PPS, it is [8, 7, 8, 5]. With STAP-A [SPS, IDR], it is [7, 8, 5]. No IDR slice is emitted without both an SPS and a PPS earlier in its access unit when both are cached.

Evidence:
- New cases in tests/h264Depacketizer.test.js for SPS-only in-band, PPS-only in-band, and STAP-A [SPS, IDR] access units, through both push() and pushFrames()
- A diff of lib/h264Depacketizer.js showing independent SPS and PPS presence flags per access unit

## VAL-161

Across simulated page loads sharing one persisted sessionStorage, repeated chunk-load failures trigger at most maxReloads reloads within the time window. This holds even when each failure happens after the app has mounted. Mounting never resets the budget.

Evidence:
- Unit test in tests/chunkReloadGuard.test.js that creates a fresh guard per simulated load over a shared fake storage, injects a post-mount failure on each load, and asserts the reload stub call count equals maxReloads
- Review of the src/main.jsx diff showing no budget reset or clear on mount

## VAL-162

The reload budget resets only when the window expires, measured from firstAt. A malformed stored entry or a clock that moved backwards starts a new window, does not throw, and does not exceed the cap.

Evidence:
- Unit test advancing the injected clock past windowMs and asserting one more reload is allowed
- Unit tests with malformed JSON and with now() < firstAt

## VAL-163

If sessionStorage is missing or its reads or writes throw, the guard does not throw and allows no automatic reload. Once the cap is reached, the chunk-error handlers do not call preventDefault, so the error propagates.

Evidence:
- Unit tests with storage = null and with getItem/setItem stubs that throw
- Review of the src/main.jsx diff showing preventDefault only on the reload-scheduled branch
