# Issues this plan fixes

## Cumulative RTP timestamp delta exceeds signed 32-bit limit and permanently drops audio

high · accepted · C-1a1aed1b3da4

OggOpusMuxer computes timestampDelta relative to the initial stream baseTimestamp and drops packets when timestampDelta exceeds 0x7fffffff. Because this.baseTimestamp is never updated, running for 2^31 samples (approx 12.4 hours at 48kHz, or sooner if initial timestamp was large) causes all subsequent packets to be permanently dropped.

## RTP sequence gap detection occurs after frame emission on timestamp transition

high · accepted · C-c22995c78104

In H264Depacketizer.pushFrames, when an RTP packet carrying the marker bit is dropped, frame completion is triggered by receiving a packet with a new timestamp. However, _emitFrame is invoked before checking whether sequence numbers advanced discontinuously. As a result, the damaged frame that suffered packet loss is emitted with intact: true, and the subsequent intact frame is mistakenly flagged with intact: false.

## H.264 reassembly has no aggregate memory limit

high · accepted · C-e4888f2e8dfc

<quotes>
            this._fuBuffer.push(Buffer.from(fragment));
            this._frameChunks.push(annexb);
</quotes>
Neither fragmented-NAL assembly nor access-unit assembly has a byte, packet or time limit. Sequential FU-A continuation packets with a fixed timestamp/SSRC and no end marker keep growing _fuBuffer. Complete NAL packets with a fixed timestamp and no RTP marker similarly keep growing _frameChunks.

## Fragmented SPS/PPS prefixes are cached as complete parameter sets

medium · accepted · C-e0d1ff2744c4

<quotes>
            nals.push(Buffer.concat([Buffer.from([nalHeader]), payload.subarray(2)]));
sps = Buffer.from(nal);
pps = Buffer.from(nal);
</quotes>
extractNalUnits() returns the start fragment of a FU-A NAL as though it were complete, without reassembling its continuations. collectParameterSets() then accepts that prefix as an SPS or PPS and retains the first value, preventing later complete copies from replacing the truncated value.

## TRUST_PROXY addresses are misparsed as proxy-hop counts

high · accepted · C-463b545aedba

<quotes>
    const asNumber = Number.parseInt(normalized, 10);
    if (Number.isFinite(asNumber)) return asNumber;
    return String(value).trim();
</quotes>
parseTrustProxy parses numeric prefixes rather than complete integers. Consequently, 127.0.0.1 becomes the number 127 and 10.0.0.0/8 becomes 10. If consumed as Express trust-proxy configuration, an intended address allowlist becomes a permissive hop-count policy.

## Trusted forwarded client IP is read from client-controllable headers (CF-Connecting-IP passthrough, leftmost X-Forwarded-For)

high · accepted · C-70eb68e12178

Forwarded headers are trusted when the opt-in flag is set and the immediate peer is loopback. In that case getTrustedForwardedClientIp returns the CF-Connecting-IP header verbatim if it is present. Otherwise it returns the first (leftmost) X-Forwarded-For entry. The code only checks that the TCP peer is loopback. It never checks that the proxy set or sanitized these headers. Generic local reverse proxies such as nginx and Traefik pass a client-supplied CF-Connecting-IP header through unchanged. nginx's common $proxy_add_x_forwarded_for appends the real address to the right of whatever the client sent, so the leftmost entry is chosen by the attacker. A remote client can therefore claim to be 127.0.0.1 or a trusted-LAN address, and classifyClient will report kind 'loopback' or 'trusted-lan'.

## A trusted-LAN CIDR entry with an empty prefix (e.g. '192.168.1.0/') is parsed as /0 and trusts every IPv4 address

medium · accepted · C-a223946bd23a

isIpInTrustedLan splits each entry on '/' and converts the prefix with Number(prefixText). Number('') evaluates to 0, which passes the Number.isInteger check and the 0..32 range check. A prefix of 0 produces mask 0, so the masked comparison is true for every valid IPv4 address. A trailing-slash typo or empty prefix therefore turns the allowlist into a match-all rule instead of being rejected. An explicit '/0' is also accepted silently.

## Mismatched buffer byte lengths cause crypto.timingSafeEqual to throw RangeError

medium · accepted · C-5b1e3856c97d

crypto.timingSafeEqual throws an unhandled RangeError when comparing buffers of differing byte lengths. The handler verifies token.length !== current.token.length using character length (UTF-16 code units) rather than UTF-8 byte length before constructing Buffer instances, allowing multi-byte character strings of matching string length to throw an unhandled exception.

## FFmpegRelay.restart() and start() can respawn FFmpeg after the owner has called stop()

medium · accepted · C-90a6cdbe1e70

restart() calls this.stop() itself, waits 1s, and then calls start() if !this._running. stop() is also the public teardown API, and it only sets _running = false. As a result, restart() cannot tell its own stop apart from an owner's stop. If the owner calls stop() during the 1s backoff, that stop is undone and a fresh FFmpeg is spawned. The same happens if an 'exit' listener calls stop(), because 'exit' is emitted synchronously just before restart() is invoked. start() has a similar gap. On first use it awaits probeNvenc() and probeInputBsf(), which can take up to 5s each. After the await it only checks `if (this._running) return;`, so a stop() issued while the probe is pending does not prevent the spawn. The class has no disposed flag or generation token.

## FFmpeg crashes reported as signals are treated as deliberate stops and never restarted

medium · accepted · C-b5d24f63d140

The exit handler restarts only when `wasRunning && signal == null`, assuming that any signal means our own stop(). That condition is redundant for deliberate stops. stop() already sets _running = false before killing the process, so wasRunning is false, and superseded processes return early. What the signal test actually excludes is involuntary termination: on Linux and macOS, a SIGSEGV or SIGABRT from a decoder or NVENC driver, an OOM-killer SIGKILL, or an external kill. The comment's premise is also inaccurate, because FFmpeg traps SIGTERM and usually exits with code 255 and no signal.

## Immediate reset of _stdinCap in writeVideoFrame defeats burst buffer expansion

high · accepted · C-c32d78b8b87c

When beginBurst() is invoked to replay a cached GOP burst into FFmpeg, _stdinCap is raised to accommodate the queued frames. However, in writeVideoFrame(), the condition checking if writableLength is below or equal to MAX_STDIN_BUFFERED_BYTES executes on the very first frame before the burst has filled the stdin buffer. This immediately resets _stdinCap back to MAX_STDIN_BUFFERED_BYTES, causing subsequent frames in the burst to exceed the cap, get dropped, and trigger an unwanted video-gap event.

## The first video write clears the declared burst allowance

medium · accepted · C-a075c323c477

<quotes>
        this._stdinCap = MAX_STDIN_BUFFERED_BYTES + Math.max(0, bytes) * 2;
</quotes>
beginBurst() increases the input allowance, but writeVideoFrame() immediately restores the ordinary cap whenever writableLength is at or below that cap. A fresh process normally satisfies that condition on its first write, so the declared allowance is discarded before the burst can build its queue.

## NVENC choice is cached permanently and probed with different options, so NVENC failures restart-loop to the cap instead of falling back to libx264

medium · accepted · C-aa078a605b33

probeNvenc() runs once per server process: one 256x256 frame encoded with h264_nvenc at default options. Its result is cached forever, and each relay pins _videoEncoder on its first start. The runtime command adds options the probe never exercises: -preset p5, -tune ll, -rc cbr, -zerolatency, -strict_gop, -forced-idr and -delay. Older FFmpeg builds or NVENC driver/SDK combinations reject these. NVENC can also fail at spawn time even after the probe passed, for example when the concurrent-session limit is reached because OBS already holds sessions, or after a driver reset. When an NVENC process exits non-zero, restart() reuses the same encoder. Once FALLBACK_RESTART_CAP is reached, it emits a fatal error.

## Null socket payloads throw before handler error protection

high · accepted · C-2a12ecf70368

<quotes>
socket.on('close-viewer-transport', ({ transportId } = {}, callback)
socket.on('connect-transport', async ({ transportId, dtlsParameters } = {}, callback)
</quotes>
The handlers destructure their arguments before entering their try blocks. The default object handles undefined, not an explicit null. Sending null therefore throws outside the synchronous close handler's catch, or rejects the asynchronous handlers before their catches run. This occurs before room membership checks.

## Null socket payloads throw before request error handling

high · accepted · C-8c511aaf0762

<quotes>
lib/socket.js:1835-1836
        socket.on('reclaim-host', ({ code, hostToken, reloadRecovery = false } = {}, callback) => {
            try {
lib/socket.js:1898-1899
        socket.on('join-room', async ({ code, passphrase } = {}, callback) => {
            try {
</quotes>
The default object applies only to undefined, not null. Destructuring a client-supplied null throws before either try block is entered. The synchronous reclaim handler therefore leaks an exception; the async join handler returns an unhandled rejected promise. Neither path requires room membership.

## Forged chunk lengths bypass relay memory limits

high · accepted · C-1c83f882073c

<quotes>
: chunk?.byteLength || chunk?.size || 0;
const nextBootstrapBytes = (room.mediaBootstrapBytes || 0) + size;
room.mediaBootstrapChunks.push(chunk);
room.mediaBootstrapBytes = nextBootstrapBytes;
</quotes>
Nonbinary objects are accepted, and their client-controlled byteLength or size property is treated as their actual memory size. In the non-MP4 path, a large JSON object claiming byteLength: 1 passes the size checks and is retained while only one byte is charged to the bootstrap budget. Buffering happens even without relay viewers.

## media-chunk accepts non-binary payloads based on client-supplied byteLength/size and has no try/catch

medium · accepted · C-23a0d57d129f

For anything that is not a Buffer or ArrayBuffer, the size comes from chunk.byteLength or chunk.size, which the client controls. A plain JSON object such as {byteLength: 10} therefore passes both the empty-chunk and oversize checks. That object is then passed to room.relayMp4.push or stored as room.initChunk, which is later served to viewers. The handler is synchronous with no try/catch, so if downstream parsing throws on a non-Buffer value, the exception escapes the socket.io listener.

## consume lets one viewer create unlimited consumers of the same producer (egress amplification)

high · accepted · C-e5fe351740e4

The consume handler checks three things: the producerId belongs to the room, the router can consume it, and the socket has a recv transport. If all pass, it always creates a new consumer and appends it to viewerData.consumers. It never checks whether this viewer already has a consumer for the same producerId, and it sets no per-viewer or per-transport cap. consumer-resume will resume any consumer in that list. A single viewer can therefore repeat consume and consumer-resume, and the SFU will forward N copies of the host's media to that one transport.

## Transport creation handlers do not re-check state after the await; overlapping create-send-transport calls leak host transports

medium · accepted · C-a9f26790d388

create-send-transport closes the previous host transport, awaits createSocketWebRtcTransport, and then assigns room.hostTransport without checking what is there now. If two calls overlap (for example a client retry after a timeout; the join-room comment says socketRequest retries), both run the close step before either assigns. The first new transport is then overwritten without ever being closed. create-recv-transport handles this exact race with its raced check, but the host path does not. Neither handler checks after the await that the socket is still connected or still in this room, so a transport created for a socket that left mid-await is stored on a stale entry.

## Repeated produce requests leave superseded producers open

medium · accepted · C-5c63bfc64dd0

<quotes>
const producer = await room.hostTransport.produce({ kind, rtpParameters, appData });
if (kind === 'video') room.producer = producer;
if (kind === 'audio') room.audioProducer = producer;
</quotes>
A successful produce request overwrites the room's single producer slot for that media kind without rejecting or closing an existing producer. Repeated same-kind requests therefore leave older producers alive on the send transport while losing their room-level references.

## RoomMediaPipeline.close() never releases fallback resources registered while the pipeline is idle

medium · accepted · C-cd1aa8c6c7ce

own() and setTimer() accept fallback resources in any state and never check the startup generation. closeFallback() returns early without touching _resources when the state is 'idle'. close() relies on closeFallback() for _resources and only closes _whipResources itself. Any fallback resource registered while idle is therefore never closed on teardown. Examples are a worker owned by an async startup continuation after a cancelling closeFallback (before it calls assertCurrent), or a restart or backoff timer set after the fallback closed.

## A superseded startFallbackRelay can stop the newer, healthy relay from its catch block

medium · accepted · C-b3a36c82620e

startFallbackRelay captures a local pipeline and calls ensureCurrentGeneration() after its awaits. That call appears to throw when the start has been superseded. The finally block only closes the fallback when room._mediaPipeline === pipeline, but the catch block calls stopFallbackRelay(room) with no such check. stopFallbackRelay reads room._mediaPipeline again, closes whatever pipeline is current, and clears room.fallbackWorker, fallbackInitSegment and fallbackSource. There is a second gap: frame-rate sampling can wait up to 3 seconds, and nothing checks the generation until line 1443. In that window the stale start overwrites room.fallbackBitrate, calls resetFallbackDelivery(room), and sets room.fallbackWorker = relay, replacing the live relay's reference before the generation check runs.

## RTP reorder timeout cannot expire without another packet

medium · accepted · C-3aa47d3cc833

<quotes>
lib/rtpReorder.js:66
            if (this._held.size === 0) this._waitingSince = this._now();
lib/rtpReorder.js:71, elapsed-time excerpt
this._now() - this._waitingSince
lib/rtpReorder.js:72
            this._skipToNextHeld(out);
lib/rtpReorder.js:74
        return out;
</quotes>
The expiration check runs only inside push(). There is no timer or flush operation that releases held packets when maxWaitMs elapses. If a packet is missing and the subsequent burst ends before the deadline, the retained tail remains buffered indefinitely rather than being released after the configured maximum wait.

## Truncated mdhd boxes cause an out-of-bounds read

medium · accepted · C-af5a704bc789

<quotes>
if (mdiaType === BOX.mdhd) {
    const version = initSegment.readUInt8(mdiaBoxStart + 8);
    const scaleOffset = mdiaBoxStart + (version === 1 ? 28 : 20);
</quotes>
The box iterator accepts an eight-byte box header, but readVideoTrackInfo reads the mdhd version byte before checking that any payload exists. A header-only mdhd at the end of the buffer therefore causes readUInt8(buffer.length) to throw RangeError. The later timescale bounds check cannot protect this earlier read.

## Short HTTP 200 responses are misclassified as a fast public link

medium · accepted · C-c78bc8af0a2e

<quotes>
const PROBE_BYTES = 10 * 1024 * 1024;
completed = true;
return completed ? { status: 'fast', kbps: null } : { status: 'failed', kbps: null, reason };
</quotes>
Any successful response whose body reaches EOF is considered completed, without checking that the expected probe bytes were received. An empty or small HTTP 200 response finishes without enough measurement data and is therefore reported as fast, even though no capacity measurement occurred.

## Single-valued socket-to-room mapping is overwritten without removing prior membership, and room teardown unmaps sockets now in other rooms

medium · accepted · C-c40f97d49a6b

joinRoom and commitRoom (and reclaimHostRoom) call mapSocket, which overwrites any existing mapping. They do not remove the socket from its previous room's viewers set and do not clear a previous host role. removeViewer cleans only the room the socket is currently mapped to, so the old room keeps a phantom viewer. When the old room is destroyed, clearRoomMappings unconditionally unmaps every socket in its viewers set plus its hostSocketId, which deletes the mapping to the socket's current room.

## Answers reorder media sections and omit unsupported tracks

high · accepted · C-b0c456cadccc

<quotes>
lines.push(...buildMediaSection('video', parsedOffer.video, parsedOffer.video.selectedCodec));
lines.push(...buildMediaSection('audio', parsedOffer.audio, parsedOffer.audio.selectedCodec));
</quotes>
createAnswer always emits video before audio, regardless of offer order, and omits audio when its codec is unsupported. SDP answers must preserve the number and order of offered media sections; an unsupported section must be rejected with port zero rather than removed. Consequently, an audio-first offer or an offer containing unsupported audio receives a structurally invalid answer.

## SDP answers omit negotiated RTCP feedback

medium · accepted · C-de82dfaf35cc

<quotes>
const requiredFb = [
    { type: 'nack', parameter: '' },
    { type: 'nack', parameter: 'pli' },
    { type: 'ccm', parameter: 'fir' },
];
sec.push(`a=fmtp:${pt} ${fmtpStr}`);
</quotes>
The producer is configured with RTCP feedback, but createAnswer never emits any a=rtcp-fb attributes. Feedback offered by the client is therefore not accepted in the SDP answer. Configuring mediasoup internally does not negotiate retransmission or keyframe feedback with the sender.

## Opus sprop-stereo is always dropped (underscore vs hyphen key mismatch)

medium · accepted · C-b8130d793188

fmtp parameter names are stored exactly as they appear in the SDP (lowercased), so the Opus parameter is stored under 'sprop-stereo'. toMediasoupRtpParameters looks it up as fmtp.sprop_stereo, with an underscore, which can never exist. The sprop-stereo flag from the publisher is therefore never added to the producer's rtpParameters.

## createViewerAnswer allocates consumers to rejected/inactive SDP offer sections

high · accepted · C-cb3339ade98c

createViewerAnswer iterates over all parsed media sections and assigns the first matching consumer by kind without checking if the offer m-section is disabled (port === 0) or inactive. If a viewer offer contains a disabled or renegotiated inactive m-section prior to an active section of the same kind, the consumer is assigned to the disabled section and responded to with port 9 (violating RFC 3264). Because consumersByKind[section.kind] is deleted upon assignment, the subsequent legitimate active media section receives no consumer and is rejected.

## Header extensions the viewer never offered are negotiated and emitted in the answer, possibly with colliding IDs

medium · accepted · C-b5febf64d2e0

buildViewerRtpCapabilities keeps every router header extension for the active kinds, whether or not the offer lists that URI. The consumer therefore negotiates extensions the viewer never offered. buildActiveSection writes these into the answer using the router's own ID whenever the offer lacks the URI. Offered URIs, meanwhile, are remapped to the offer's IDs. An unoffered extension's router ID can therefore equal an ID the offer already bound to a different URI, which produces duplicate a=extmap IDs in one m-section. Adding unoffered extensions in an answer also violates RFC 8285 negotiation rules.

## WHEP answer rewrites payload types and header-extension IDs in SDP only, while consumer RTP keeps the router's values

high · accepted · C-69cb8a77c1a9

buildViewerRtpCapabilities pushes the router's own codec objects (filteredCodecs.push(rc)) and router header extensions into the capabilities passed to consume(). That means the router's preferredPayloadType and preferredId values flow into the mediasoup consumer's rtpParameters, and those are the PT and extension IDs the worker stamps on outgoing RTP. buildActiveSection then replaces each PT with the offer's PT (answerPt) and each extension ID with the offer's ID, but only in the SDP text. Nothing changes consumer.rtpParameters, and mediasoup has no way to override consumer PTs. So the answer can tell the browser something like H264=PT 102 and abs-send-time=2 while the packets on the wire carry PT 103 and extension id 4.

## H.264 compatibility checks discard profile constraints and defaults

medium · accepted · C-2ae13a6deb9f

<quotes>
lib/whep.js:309-310
                const consumerProfile = consumerCodec.parameters?.['profile-level-id']?.slice(0, 2)?.toLowerCase();
                const offerProfile = offerFmtp['profile-level-id']?.slice(0, 2)?.toLowerCase();
lib/whep.js:514-515
                const rcProfile = rc.parameters?.['profile-level-id']?.slice(0, 2)?.toLowerCase();
                const vcProfile = vc.fmtp['profile-level-id']?.slice(0, 2)?.toLowerCase();
</quotes>
Both matchers compare only profile_idc, ignoring the constraint byte that distinguishes H.264 profiles. They also treat an omitted profile-level-id as unrestricted, although it has a defined default. Because the filtered capabilities contain the router codec rather than the viewer's actual parameters, downstream canConsume checks cannot recover the discarded constraints.

## Passive DTLS offers receive a contradictory passive answer

medium · accepted · C-ba70cd023811

<quotes>
lib/whep.js:195
    const role = section.setup === 'passive' ? 'server' : 'client';
lib/whep.js:373
    lines.push('a=setup:passive');
</quotes>
A passive offer is accepted and passed to mediasoup as a remote DTLS server, requiring the local transport to act as client. The SDP answer nevertheless always declares the local endpoint passive. This contradicts both the offered role and the configured transport role.

## Receive transport creation can commit after viewer departure

medium · accepted · C-a6d7a1b075f4

<quotes>
const room = findRoomBySocket(socket.id);
const { transport, params } = await createSocketWebRtcTransport(router, { purpose: 'viewer' });
room.viewerTransports.set(socket.id, { recvTransport: transport, consumers: [] });
const updatedRoom = removeViewer(socket.id);
</quotes>
Room membership is checked only before awaiting allocation. If the viewer leaves or disconnects during that await, departure cleanup runs before the new transport is stored. The handler then writes the newly allocated transport into the captured room without verifying current membership, connection state, or room identity. The concurrent-creation cleanup does not address this departure race.

## Tunnel URL detection assumes pipe chunks contain complete URLs

medium · accepted · C-7a074ed76e89

<quotes>
lib/tunnel.js:97
            const text = chunk.toString();
lib/tunnel.js:103
            if (!match) return;
lib/tunnel.js:136
            stopChildProcess(child);
</quotes>
URL matching examines each stdout or stderr chunk independently and discards unmatched text. Pipe data events do not preserve log-line or URL boundaries. A valid public URL split across two chunks is never recognized, so startup eventually kills a functioning tunnel.

## Named tunnels are declared active on a fixed timer

medium · accepted · C-d13a4e2383e9

<quotes>
lib/tunnel.js:148-149
                settled = true;
                clearTimeout(timeout);
lib/tunnel.js:153
                    baseUrl: knownBaseUrl,
lib/tunnel.js:158
            }, 1500);
lib/tunnel.js:198
                knownBaseUrl: namedTunnel ? baseUrl : '',
lib/tunnelSupervisor.js:94
            this._publish('active', '', baseUrl);
</quotes>
For named tunnels, the launcher resolves successfully after 1.5 seconds merely because the process has not exited. It neither observes successful tunnel registration nor probes readiness, and it cancels the startup deadline. A cloudflared process that remains alive retrying unsuccessful connections is consequently reported as active without a working tunnel.

## Rotated startup logs escape retention cleanup

medium · accepted · C-181a8ba46ab4

<quotes>
/^startup-\d{8}-\d{6}-\d+\.log$/
                const destination = `${filePath}.${generation}`;
                fs.renameSync(source, destination);
</quotes>
pruneOldLogs only recognizes unrotated session files. Rotation creates startup-*.log.1 and subsequent generations, which never match that filter. Deleting an old session's primary file therefore leaves its rotated generations permanently behind.

## uncaughtExceptionMonitor shows a synchronous 15-second PowerShell modal, even for exceptions the app may recover from, and reports runtime crashes as startup failures

medium · accepted · C-4ad24b7d0512

Node emits 'uncaughtExceptionMonitor' for every uncaught exception before any 'uncaughtException' listener runs, whether or not the application then handles it and continues. The handler calls showFailureDialog(). That function uses execFileSync to start powershell.exe and show a WScript Popup with a 15-second timeout, which blocks the Node main thread until the user dismisses it or the timeout elapses. Consequences:
- If the server installs a recovering uncaughtException handler (outside this scope), the first runtime exception freezes all HTTP and signalling work for up to 15 s plus PowerShell start-up time.
- The dialog tells the user 'Nextra could not start correctly' while the app keeps running.
- Any non-zero exit at any time, not only during startup, produces the same startup-failure dialog.

## DTLS role inverted for non-actpass setup attributes in WHIP ingest

medium · accepted · C-a6bfe7e35a4e

parseDtlsParameters maps remote section.setup === 'active' to role: 'server'. In mediasoup DtlsParameters, role designates the remote peer's DTLS role. When a client advertises setup:active (meaning the client is active/client), marking remote role as server while the server answer declares a=setup:passive creates a role mismatch where both sides expect the other to listen or initiate, breaking DTLS handshake establishment.

## TCP ICE candidates are serialized without required tcptype

medium · accepted · C-ba678dea7584

<quotes>
sec.push(`a=candidate:1 1 ${proto.toUpperCase()} 2130706431 ${cand.ip} ${cand.port} typ ${type}`);
</quotes>
The serializer accepts TCP candidates but never includes their required tcptype attribute. A mediasoup TCP candidate therefore becomes an invalid ICE-TCP candidate, which a client can reject or discard.

## SSRC-less offers lose all RTP stream identifiers

medium · accepted · C-1e6314bdf369

<quotes>
encodings: [{ ssrc: parsedOffer.video.ssrc }],
if (rtpParams.video?.encodings?.[0]?.ssrc == null) delete rtpParams.video.encodings[0].ssrc;
</quotes>
For an offer without an explicit SSRC, conversion followed by deletion produces an empty encoding object. Neither conversion supplies mid, rid, or the corresponding RTP header-extension mappings. Consequently, mediasoup lacks an identifier for associating incoming RTP with the producer; deleting null does not implement support for SSRC-less offers.

## Asynchronous startup can publish a superseded session

high · accepted · C-0114aaa7ba9b

<quotes>
await transport.connect({ dtlsParameters: remoteDtls });
room.whipSessionId = sessionId;
room.whipResourceId = resourceId;
room.whipTransport = transport;
room.whipProducer = await transport.produce({
</quotes>
There is no cancellation or generation check after awaiting transport.connect and before publishing session state. Cancellation clears the generation and releases the startup lock, but a subsequently resolved connect can still register its resource and overwrite room state. Producer callbacks similarly assign awaited results into shared room fields and pipeline ownership before checking their generation, allowing stale completions to mutate replacement-session state.

## Producer creation failure after DTLS connect is only logged, leaving a half-initialized session that never goes live and is never torn down

medium · accepted · C-86fcac1b4add

The handler sends the 201 SDP answer before any producer exists. Producers are created later, inside the async 'connected' handler. If transport.produce() rejects, the catch block only logs the error. This happens, for example, when the router rejects the audio rtpParameters derived from the offer, or when the video producer succeeds and the audio producer fails. Any producer already created stays open and owned by the media pipeline. room.whipConnected is never set, so no new-producer events or host metrics are emitted and no relay is prewarmed. Nothing closes the transport, and since DTLS stays connected the grace timer never runs. The superseded-generation branches close producers but never release the pipeline ownership taken by ownWhip(). The async handler also has a race: if DTLS fails while produce() is pending, the later 'room.whipConnected = true' overwrites the false set by the failure branch. The grace timer then sees a connected session and never tears it down.

## WHIP session liveness depends only on DTLS state, so an abrupt OBS loss or a never-completed ICE leaves the session 'connected' indefinitely

medium · accepted · C-c989b1b9ed7a

The only lifecycle hook on the WHIP transport is 'dtlsstatechange'. The grace-period teardown starts only on DTLS 'failed' or 'closed'. In mediasoup, when the remote peer disappears without sending a DTLS close_notify (OBS crash, network drop, laptop sleep), ICE consent expiry is reported through 'icestatechange' ('disconnected'). The DTLS state remains 'connected'. No icestatechange handler exists in this file. No timeout exists for the initial ICE/DTLS establishment either. Because of this, room.whipConnected stays true and the producers and prewarmed relay stay allocated. The grace timer never starts. A transport whose ICE never completes after the 201 also stays attached to the room with whipSessionId set and no timer.

## Raw H.264 SPS/PPS captured from one OBS session persist into later sessions

medium · accepted · C-7eca647136d1

room.fallbackH264Sps and room.fallbackH264Pps are written only by the stream capture. They are never cleared, neither in closeWhipSession nor at the start of a new session's connected handler. That handler does reset fallbackH264Sprop and fallbackH264Profile. The inline comment says the relay depacketizer injects these bytes before every keyframe. A new session therefore inherits the previous session's parameter sets in three cases. First, its offer carries sprop-parameter-sets, so no stream capture runs and the old SPS/PPS persist for the whole session. Second, its capture times out. Third, the prewarmed relay, started immediately at line 499, reads the values before the async capture finishes.

## Session deletion does not verify the host bearer token

medium · accepted · C-ad225d9c2901

<quotes>
if (!timingSafeTokenEqual(token, room.hostToken)) {
stopFallbackRelay(room);
closeWhipSession(room);
</quotes>
POST enforces host-token ownership, but DELETE resolves the resource and immediately tears down the room's session without checking Authorization. Anyone possessing a resource URL can therefore terminate the stream without the host credential. Random resource IDs limit discovery but do not authenticate a caller once the URL is disclosed.

## Public WHIP rate-limit map is never pruned and is populated before authentication

medium · accepted · C-f04e9d9c1539

isPublicRateLimited inserts one entry per client IP into publicAttempts and never deletes it. An expired window is only reset when the same IP returns. The check runs before room lookup and token verification, so unauthenticated clients create permanent entries. Many distinct source addresses, which are trivial to obtain with IPv6, make the map grow for the life of the process. The default getClientIp uses the raw socket address. Behind a reverse proxy, every client therefore shares one bucket, and one abusive client can exhaust PUBLIC_WHIP_RATE_LIMIT_MAX and lock out the legitimate OBS encoder.

## Unbounded public WHIP rate limiting map leaks memory across unique IP addresses

medium · accepted · C-f16891b4b1df

The `publicAttempts` map instantiated in `createWhipRouter` retains client IP entries indefinitely. Although it resets counters when `now > current.resetAt`, old keys are never pruned or evicted. Over time, requests from varying client IPs (or port scanners/spammers) cause the Map size to increase without bound.

## Insecure TLS flag is not applied to fetchMetrics, causing benchmark aborts against HTTPS targets

high · accepted · C-201a0174c13e

The runtime benchmark script provides a `--allow-insecure-tls` CLI option, but only passes `rejectUnauthorized: !allowInsecureTls` to the socket.io client. The `fetchMetrics` helper invokes the global `fetch` API without configuring TLS verification settings (e.g. via an undici Agent/Dispatcher or `NODE_TLS_REJECT_UNAUTHORIZED = '0'`). When targeting an HTTPS server with self-signed certificates (such as local HTTPS development/test environments), `fetchMetrics` fails immediately on certificate validation, terminating the benchmark.

## Missing worker/process/event-loop metrics are coerced to 0, so the benchmark can report a pass without having measured them

medium · accepted · C-a8d71e4b17ab

The code clearly intends missing data to become null rather than 0:
- cpuPercent() returns null for non-finite inputs.
- The threshold checks skip null values.
- The model tests expect workerCpu headroom to be null when the observation is null.
The callers defeat this by pre-coercing every input with '|| 0'. As a result:
- An absent mediaWorker.resourceUsage or process.cpuUsageMicroseconds becomes 0% CPU with 100% headroom.
- An absent process.memory.rss makes memoryGrowth 0.
- Absent eventLoopDelayMs values become 0 ms.
Each of these thresholds then passes silently instead of being reported as unavailable. Topology checks fail closed, but these resource checks fail open.

## Harness failures leave sockets and background work running

medium · accepted · C-6d493af411aa

<quotes>
scripts/benchmark-runtime.js:
    await fetchMetrics();
    process.exitCode = 1;
scripts/churn-runtime.js:
        const host = await connectClient();
        const viewer = await connectClient();
    const baseline = await fetchMetrics();
    process.exitCode = 1;
</quotes>
Both scripts establish persistent sockets before operations that can reject, but their outer error handlers only set exitCode. They do not close previously connected sockets. A benchmark sampling failure can also leave running true, allowing acknowledgement loops to continue indefinitely. In the churn setup, a viewer connection failure additionally leaves its already-connected host outside the pairs array.

## Open-source preflight only blocks root-level .env files; tracked .env files in subdirectories pass the gate

medium · accepted · C-3f8281819bbd

forbiddenTracked lists only root-relative names. The .env path regex is anchored at the start with no directory prefix, unlike the certs/ and binary rules, which accept '(?:^|/)'. As a result, poc-mediasoup/.env, server/.env.production or config/.env.local are neither in the set nor matched. The content scan only recognises a few vendor token formats. Generic secrets in such files therefore pass, and the gate prints OK. Examples: passwords, tunnel tokens, METRICS_TOKEN values, TURN credentials.

## Git-quoted filenames bypass preflight content scanning

medium · accepted · C-310a41447c0f

<quotes>
        const output = execSync('git ls-files', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8');
        return false;
        if (!isTextFile(absPath)) continue;
</quotes>
Without -z, git ls-files quotes and escapes unusual filenames, including non-ASCII names under Git's default core.quotePath setting. The script treats that display representation as a literal filesystem path. Reading it fails, isTextFile returns false, and the tracked file is silently skipped instead of scanned for secrets.

## downloadFileWithRedirects has no timeout and ignores response stream failures, so packaging can hang indefinitely

medium · accepted · C-38752a30726c

The function sets no request, socket or idle timeout, and attaches no 'error', 'aborted' or 'close' handler to the response. After headers arrive, a mid-body connection reset destroys the IncomingMessage. Current Node emits that error only if a listener exists, and the ClientRequest emits no 'error' once a response exists. response.pipe(file) does not end the destination when the source closes without 'end', so 'finish' never fires and the promise never settles. A server that stalls also hangs forever.

## macOS CLOUDFLARED_PATH/local/PATH cloudflared is checked against the .tgz archive digest and copied without extraction

medium · accepted · C-d94409bfc1f0

On darwin, assetName is a .tgz, so expectedSha256 is the archive digest. The download path confirms this: it verifies the archive with that digest and only then extracts. The CLOUDFLARED_PATH branch, the ALLOW_LOCAL_CLOUDFLARED candidates and the PATH candidate hash the file as-is and compare it to the archive digest. Any file that passes is copied verbatim with copyCloudflaredToStage, with no extraction and no chmod. A real cloudflared Mach-O binary can never match. Only the pinned tarball itself can pass, and it is then staged as the `cloudflared` executable.

## Windows run() uses shell:true, so caxa path arguments are split on spaces and parsed by cmd.exe

medium · accepted · C-92eb1d3a74b1

On win32, run() calls spawnSync with shell:true. In that mode Node joins the command and its args with single spaces into one `cmd.exe /d /s /c "..."` line and does not quote individual arguments. The caxa invocation passes absolute paths as args: stageDir and outputExe come from projectRoot, and iconStub comes from os.tmpdir(). A space in any of these splits the argument. Characters such as &, |, ^, (, ) or % are interpreted by cmd.exe.

## Benchmark leaves sockets and ack loops running on any error, so a failed run hangs instead of exiting

medium · accepted · C-d19a51311c21

main() opens every client socket before the first metrics request. It closes them only on the success path. Each of these failures makes main() reject while the catch handler only sets process.exitCode:
- connectClient() rejects for any one socket (Promise.all).
- The initial fetchMetrics() throws, e.g. a non-OK status.
- Any fetchMetrics() inside the sampling loop throws.
The already-connected socket.io websockets stay open and keep the event loop alive. For mid-run failures, 'running' is never set to false, so the ack loops keep emitting requests every ackIntervalMs forever.

## Benchmark validates required load only at the final sample

medium · accepted · C-2d9a99230b38

<quotes>
        rooms: last.metrics.rooms?.active || 0,
        producers: last.metrics.sockets?.counters?.activeProducers || 0,
        consumers: last.metrics.rooms?.totalMediasoupConsumers || 0,
    const failures = evaluateTopology(observedTopology, requirements);
</quotes>
Required room, producer, consumer, relay-viewer, and pipeline counts are checked only against the last sample, while performance statistics cover the broader measurement window. A topology that is missing or underloaded for most of that window can recover just before the final sample and pass with artificially favorable performance measurements.

## generate-icons.ps1 overwrites the social card that generate-social-card.js owns

medium · accepted · C-89a6711d2d4a

Both scripts write public/brand/nextra-social-card.png, and they produce different designs. generate-icons.ps1 draws the mark and wordmark on a #080b10 to #03060b linear gradient with no tagline. generate-social-card.js renders the primary lockup with a tagline on the #0f0f12 radial-gradient palette, and its header calls the card committed art that must not drift from the page. Any generate-icons.ps1 run that finds the reference image silently replaces the curated card. generate-social-card.js also reads nextra-primary-logo.png, which generate-icons.ps1 produces, so the two scripts must run in a fixed order. Nothing enforces that order.

## HTTP timeout does not cover smoke response-body reads

medium · accepted · C-65284685dfb9

<quotes>
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
            const response = await fetchWithTimeout(`${baseUrl}/readyz`, {}, 2000);
            const body = await response.json();
</quotes>
Fetch resolves when response headers arrive, so fetchWithTimeout clears its abort timer before callers consume the response body. Subsequent json() and text() calls are outside the timeout. A server that sends headers but never completes its body can leave a stage pending indefinitely, preventing execution from reaching cleanup.

## Packaged smoke can validate and shut down the wrong instance

medium · accepted · C-ccfa6de3b188

<quotes>
const port = 31847;
const baseUrl = `http://127.0.0.1:${port}`;
        console.error(`Packaged executable failed to start: ${err.message}`);
        await runStages();
</quotes>
The smoke test probes a fixed endpoint without establishing that the launched executable owns it. Spawn errors are only logged, and an early process exit does not stop the stages. An existing smoke-enabled instance can therefore receive the checks, worker termination and shutdown requests instead of the candidate executable. The PowerShell implementation likewise does not correlate its HTTP target with the process it starts.

## Smoke cleanup can kill unrelated concurrent Nextra instances

medium · accepted · C-0e09df3d2b26

<quotes>
    if (CAXA_PATTERN.test(command)) return true;
        process.kill(pid, 'SIGKILL');
    $remaining = @(Get-SmokeProcesses | Where-Object { $baselineProcessIds -notcontains $_.ProcessId })
    foreach ($candidate in $remaining) {
        Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
</quotes>
Cleanup identifies processes using a shared Nextra caxa-path pattern and excludes only PIDs observed before launch. It does not establish process ancestry or another run-specific identity. Any unrelated matching instance started after the baseline is therefore eligible for forced termination. The baseline protects pre-existing processes, not concurrently started ones.

## Smoke process enumeration fails open, so leftover-process checks can pass without checking anything and CI can hang

medium · accepted · C-eebc05491fe1

listProcesses() returns [] in several failure cases: PowerShell or ps exits non-zero, stdout is empty, output exceeds the 8 MiB maxBuffer (spawnSync then sets result.error to ENOBUFS and status to null), or the JSON does not parse. cleanup() then finds nothing to kill and nothing stale and returns null. The stale-extraction and lingering-cloudflared assertions therefore pass without checking anything. The spawned child is never killed directly through its handle. If enumeration fails, the packaged process tree stays alive and the referenced ChildProcess keeps Node's event loop running, so the script does not exit. If only the baseline enumeration fails, every caxa nextra- process is SIGKILLed, including pre-existing instances the baseline was meant to protect.

## Graceful-shutdown stage never asserts process exit, and cleanup silently force-kills survivors

medium · accepted · C-613aa45d62ae

checkGracefulShutdown discards the shutdown response and sets stopped = true on any fetch exception, including the 1 s abort timeout. A server that is alive but unresponsive therefore counts as stopped. cleanup() then SIGKILLs every new smoke process before it checks for stale ones. A process tree that never exits after shutdown is killed and the run still passes. The child's exit code is never observed. The PowerShell version has the same structure: Stop-Process -Force runs before the stale check.

## Tunnel or proxy requests without Origin/Referer fall back to loopback (operator) classification when the local server runs plain HTTP

critical · accepted · C-abbe228712ec

Every request relayed by the built-in cloudflared tunnel, or by any proxy on the same host, arrives from 127.0.0.1. Only isKnownPublicShareRequest() stops such a request from being treated as the local operator, and it fails open in several ways.

1. The Host-derived candidate takes its scheme from the local socket's TLS state. getRequestHostOrigin is called with `encrypted` = req.socket.encrypted, and the server is plain HTTP when LOCAL_HTTPS is false. The tunnel forwards Host=<name>.trycloudflare.com, so the candidate becomes http://<name>.trycloudflare.com. It never matches the known https:// tunnel/share origin.
2. getForwardedOrigin needs X-Forwarded-Host as well as X-Forwarded-Proto. Cloudflare does not normally set X-Forwarded-Host.
3. The only candidates left are Origin and Referer. The client controls both and can omit them, or set Origin to an allowed local origin such as http://127.0.0.1:PORT.

getClientIpFromHeaders then returns the raw loopback address (line 352). classifyClient almost certainly reports 'loopback', and isOperatorAuthorized returns true without any token. Missing proxy evidence is treated as full local trust.

## cf-connecting-ip is honoured without checking that the peer is the loopback tunnel, enabling per-IP rate-limit bypass

medium · accepted · C-a6ca149a0e84

The fallback branch in getClientIpFromHeaders runs whenever isKnownPublicShareRequest() is true. Unlike shouldTrustRequestForwardedHeaders, it has no isLoopbackIp(remoteAddress) check. The Host, Origin and Referer that drive isKnownPublicShareRequest are client-controlled, and the share URL is public by design.

A client connecting directly to a non-loopback bind (LAN, or PUBLIC_IP mode) can therefore:
- send Host or Origin equal to the share/tunnel URL;
- send an arbitrary cf-connecting-ip;
- receive the identity `public-share:<attacker value>`.

Rotating that value gives a fresh identity on every request or socket.

## HTTP-only serving can still instruct browsers to upgrade resources to HTTPS

medium · accepted · C-6d6f7a1e98d1

<quotes>
            upgradeInsecureRequests: config.ALLOW_INSECURE_TRUSTED_LAN_RELAY ? null : [],

    if (config.LOCAL_HTTPS) {
        const { cert, key } = await getOrCreateCert();
        appServer = https.createServer({ cert, key }, app);
    } else {
        appServer = http.createServer(app);
    }
</quotes>
The upgrade-insecure-requests directive is controlled by relay policy rather than the effective serving scheme. With LOCAL_HTTPS disabled and insecure LAN relay disabled, the listener is HTTP-only but the CSP still requests HTTPS upgrades. Browsers applying this upgrade to localhost, notably Safari, can request application resources over TLS on a plaintext port.

## IPv6-only listeners are advertised through unreachable IPv4 loopback URLs

medium · accepted · C-a4e4921ef1a0

<quotes>
    return `${protocol}://127.0.0.1:${config.PORT}/#host`;

    if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost' || host === '::1' || host === '[::1]') {
        return '127.0.0.1';
    }

        await listenServer(server, resolvedPort, config.WHIP_BIND_HOST);
</quotes>
Binding specifically to ::1 does not create a listener on 127.0.0.1. Nevertheless, the host-page URL always uses IPv4, and the WHIP URL helper explicitly converts IPv6 loopback to IPv4. These advertised URLs do not reach the corresponding IPv6-only listeners.

## Cached TURN credentials retain their original advertised TTL

medium · accepted · C-351744abf455

<quotes>
        res.json(cachedCloudflareTurnCredentials);

            ttlSeconds: result.ttlSeconds,

        cachedCloudflareTurnCredentialsExpiresAt = now + Math.max(0, (result.ttlSeconds - 60) * 1000);
</quotes>
Cached responses reuse the original ttlSeconds without subtracting elapsed time or returning an expiration timestamp. The cache remains usable until approximately one minute before credential expiration, so an authorized caller can receive almost-expired credentials advertised with their full original lifetime.

## Fatal-error handling becomes a no-op once a graceful shutdown has started, leaving the process half torn down

medium · accepted · C-e52d75091752

handleUnexpectedProcessError delegates to requestFatalShutdown and returns immediately. requestFatalShutdown resolves without doing anything when isShuttingDown is already true. The graceful shutdown() later in server.js sets the same flag before it awaits, runs cleanupGlobalResources and arms its 5-second exit timer.

If shutdown() rejects, or an uncaught error occurs while it is in progress, handleUnexpectedProcessError neither cleans up nor exits. That covers:
- the explicit `.catch` for the SMOKE_TEST path;
- an unhandled rejection from the SIGINT/SIGTERM handlers.

If the throw happened before the exit timer was armed, nothing ever exits the process. The installed signal handlers also suppress default termination.

## Worker-crash recovery starts a detached child with no output and exits 0, which defeats supervisors and hides failures

medium · accepted · C-d0ab9d3f522a

When the mediasoup worker dies after the minimum uptime, the recovery handler restarts the server by spawning a copy of itself. The copy is detached, runs with stdio 'ignore' and windowsHide, and the original process then exits with code 0 once the child spawns. This causes several problems. The copy sits outside the original console and process tree. Its stdout and stderr, including any startup failure, are discarded. Ctrl+C or closing the launching console no longer reaches it. Any supervisor tracking the original PID sees a clean, successful exit. The fatal path in the same file says an external supervisor is expected to restart Nextra, so the two recovery strategies contradict each other.

## Skip-to-content link is treated as a hash route and replaces the current view with 'Page not found'

medium · accepted · C-84d11f9a0943

The skip link uses href='#main'. The hashchange handler treats every fragment change as navigation: it reads window.location.hash, runs canLeaveRoute('#main'), then calls setRoute('#main'). '#main' matches no router branch, so the router renders NotFound and unmounts the active view (Host, Watch, Status). The link never just moves focus to the main region as intended.

## Modal focus effect re-runs whenever onClose changes identity, stealing focus on parent re-renders

medium · accepted · C-1d64ecacf775

The effect that moves focus into the dialog depends on onClose. If a caller passes a non-memoized handler, every parent re-render first runs the cleanup, which restores focus to the trigger outside the dialog. It then re-runs the setup, which focuses the first focusable element. Focus therefore jumps to the first control on each parent render.

## WebSocket-first transport list does not actually fall back to long-polling when WebSocket is blocked

medium · accepted · C-69692244ae92

The comment assumes that listing 'polling' after 'websocket' provides a fallback. In engine.io-client, the first transport in the list opens the connection. If the WebSocket handshake fails at the network level, the client emits an error and the Manager reconnects with WebSocket again. Moving on to the next transport only happens with tryAllTransports: true, available in socket.io-client 4.8 and later, and that option is not set.

## Diagnostic text sanitizer misses common credential, URL and room-code formats despite the UI's redaction promise

medium · accepted · C-11b48118cfa0

Redaction is regex-based and misses several common formats. (a) 'Authorization: Basic dXNlcjpwYXNz': the bearer rule does not match, and the generic key rule consumes only the next token, so the output is 'Authorization=[redacted] dXNlcjpwYXNz' with the credential intact. It is under 48 characters, so the final rule also misses it. (b) JSON-serialized text such as {"token":"abc123"}: a quote sits between the key and the colon, so the key-value rule never matches. (c) Room codes outside the literal 'room code=' or 'roomCode:' form survive, for example 'Room AB12CD not found', '/whip/AB12CD' or '#watch/AB12CD'. (d) Only http(s), ws(s), stun and turn are treated as links; scheme-less host:port values, IP addresses, and rtmp, rtsp, srt or file URLs pass through. (e) The hex rule is case-sensitive, so 32–47 character uppercase hex values and base64 values containing +, / or = survive.

## Pending sharing operations can continue after teardown

high · accepted · C-9f1c5549a0b8

<quotes>
                const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
                streamRef.current = stream;
                    const result = await configureObsStream(buildObsAutoConfig(whipUrl, hostToken));
</quotes>
handleStartSharing does not invalidate or check its operation after asynchronous steps. While the capture chooser is pending, isSharing is false and the navigation guard is absent. Component teardown can therefore finish before capture resolves; the continuation then installs the newly acquired stream and proceeds toward publishing without another mounted-session check. Similarly, the UI enables stopping before OBS configuration finishes, but the configuration continuation can still update state and open a control channel after stop or terminal cleanup.

## Retry Auto-Configure OBS can start OBS streaming without a live control channel, so teardown may leave OBS streaming at a dead room

medium · accepted · C-646efd072238

The start path explicitly opens an OBS control channel after configureObsStream. The in-code comment says the channel exists because a configured OBS stream must not outlive the page. The Retry button calls configureObsStream again but never opens or reopens that channel. Two cases fall out of this. (1) When the WHIP endpoint was not ready at start (lines 1445-1453, non-AV1), the start path skips configuration and the channel entirely, so a successful retry leaves obsControlChannelRef null. (2) When the initial configure failed because OBS was unreachable, the channel opened at 1467 most likely failed too. That failure is only logged at 1471, and the dead channel stays in obsControlChannelRef. stopObsIngest prefers any non-null channel and calls channel.stopStream(). It falls back to a fresh stopObsStream connection only when the ref is null. Per its own comment, that fallback cannot complete during page unload. So after a retry, a pagehide teardown with reload recovery disabled has no usable synchronous stop path. In case (2), even an explicit Stop may be routed to a dead channel instead of the fallback.

## get-media-init acknowledgements arriving after stop() rebuild a MediaSource and hijack the video element

medium · accepted · C-2ed31e138e53

requestCurrentInit checks state === 'stopped' only before it emits. The ack callback then calls handleMediaInit unconditionally. resetAndRequestInit's callback likewise calls handleMediaInit or handleError without any state check. stop() clears timers and socket subscriptions but cannot cancel acks already in flight. If a successful ack arrives after stop(), handleMediaInit sets currentGeneration and calls setupMediaSource. That creates a new MediaSource, assigns videoElement.src to its blob URL (overwriting the '' that stop() set), and on sourceopen emits setState('buffering') through onStateChange. If a failed ack arrives instead, handleError moves the stopped player to 'error' and calls onError.

## resetAndRequestInit recovery fails permanently on one unavailable response and can hang with no timeout

medium · accepted · C-611e7e8e2cb4

resetAndRequestInit runs on a SourceBuffer error and after 15 consecutive queue drops. It tears down the MediaSource, sets currentGeneration = -1 and state 'buffering', and sends a single get-media-init. If the response is unsuccessful, it calls handleError right away, which is terminal. It does not use scheduleInitRetry the way requestCurrentInit does. It also never calls armInitTimeout, which only start() arms. So if the ack never arrives, the player stays in 'buffering' with no timer to retry or to surface an error.

## Non-quota append failures are terminal, never recovered, and re-reported for every incoming fragment

medium · accepted · C-37119fd16bcd

processQueue treats any appendBuffer exception other than QuotaExceededError as fatal. It calls handleError, drops the fragment, and leaves sourceBuffer and mediaSource in place. Nothing gates further work after that. handleMediaChunk only checks the generation, so it keeps enqueuing fragments and calling processQueue. Each new fragment calls appendBuffer again, throws again, and calls handleError again, which means another console.error and another onError callback for every fragment. setState('error') is deduplicated, but onError is not. This path makes no recovery attempt. The SourceBuffer 'error' event path does recover by calling resetAndRequestInit, but the exception path does not. There is also no listener for the video element's 'error' event or the MediaSource 'sourceclose' event. A re-sent media-init for the same generation is ignored by the dedup check because sourceBuffer and mediaSource are still non-null. Per the MSE spec, appendBuffer throws InvalidStateError whenever the media element's error attribute is non-null (for example after a decoder failure) or when the SourceBuffer has been removed because the MediaSource closed or detached.

## Live synchronization overrides intentional pause

medium · accepted · C-8759928f0f6e

<quotes>
if (videoElement.paused && started && ahead >= START_BUFFER_SECONDS) play();
        liveSyncTimer = setInterval(liveSync, LIVE_SYNC_INTERVAL_MS);
const LIVE_SYNC_INTERVAL_MS = 250;
</quotes>
Once playback starts, every live-sync tick resumes a paused video whenever enough media is buffered. The player does not distinguish intentional user pause from a playback failure, so calling pause() cannot reliably keep playback paused.

## Module-level window.localStorage access is not guarded and can make the HostView module fail to load

medium · accepted · C-a539b28daadf

MEDIA_DEBUG_LOGS is computed when the module is evaluated, and it reads the window.localStorage property directly. In Chromium, reading that property throws a SecurityError when site data is blocked. Examples are a 'block all cookies' setting or a sandboxed iframe without storage access. Every other storage access in this file is wrapped in try/catch. This one runs at module scope outside any handler, so the exception escapes during module evaluation.

## Reload-recovery reclaim treats every error, including transient timeouts, as a terminal room end

medium · accepted · C-738aa0c5bf30

After a reload, the stored recovery session is reclaimed with a single socketRequest. Any rejection calls terminateHostSession unconditionally, with no retry. That marks the room as ended and runs cleanup, whose resetState clears the recovery session from sessionStorage. The socket reconnect path in the same file terminates only when err.terminal === true. That shows non-terminal errors, such as timeouts and disconnects, are an expected class of error.

## When reclaiming a stored OBS room fails, stopObsIngest is a no-op because ingestModeRef is still 'browser'

medium · accepted · C-2b4b5fc66639

With reload recovery enabled, pagehide deliberately leaves OBS streaming and persists {code, hostToken, ingestMode}. On the new page, ingestModeRef starts as 'browser'. It becomes 'obs' only after a successful reclaim sets ingestMode state and the sync effect runs. If reclaim fails, terminateHostSession calls stopObsIngest, which returns immediately because ingestModeRef.current !== 'obs'. The stored ingestMode value is available but ignored. The comments on stopObsIngest say the fallback stop path exists for the post-reload case, so this is the case it was meant to cover.

## Cancelling the screen picker on 'Resume Sharing' emits host-stopped and destroys the reclaimed room

medium · accepted · C-09374ee51cc5

In browser-mode reload recovery, the mount effect has already reclaimed host ownership of the room ('reclaim-host') and set resumePending, and the button reads 'Resume Sharing'. handleStartSharing then calls getDisplayMedia, and every failure, including a NotAllowedError from the user dismissing or cancelling the picker and preflight blockers, lands in the same catch. That catch unconditionally emits 'host-stopped' and calls cleanup(). cleanup() also clears resumeRoomRef and the stored recovery session. A single cancelled picker therefore permanently ends the room that viewers were waiting in, which defeats the feature whose hint promises the host only needs to 'select again'.

## Recovery permits changing ingest mode without replacing the room

medium · accepted · C-673c899927b3

<quotes>
                setIngestMode(response.ingestMode === 'obs' ? 'obs' : 'browser');
            let createdRoom = resumedRoom;
            if (!createdRoom) {
        setIngestMode(mode);
</quotes>
Browser-room recovery leaves the view idle with Resume Sharing pending, so ingest-mode settings remain available. Changing to OBS updates local state but leaves resumeRoomRef intact. Starting then reuses the recovered browser room, skips create-room, and follows the OBS path without communicating the changed room mode to the server.

## Stopping or leaving while OBS auto-configuration is in flight lets configure finish after teardown and leaks a fresh OBS control channel

medium · accepted · C-e52ed0832d05

handleStartSharing sets isSharing true and status 'streaming' before awaiting configureObsStream, so the Stop Sharing button (and Leave and Stop) is live during configuration. No session or abort token is checked after the await. If the host stops during configuration, the following sequence runs. stopObsIngest sees no channel, sets the ref null, and fires an async stopObsStream fallback. That fallback can reach OBS before configureObsStream's own start-stream step, so OBS ends up streaming. The continuation then runs: it updates obsAuto state, opens a new control channel, and stores it in obsControlChannelRef after cleanup has already run. If the view unmounted (Leave and Stop), nothing will ever close that channel or stop OBS.

## A relay recorder that errors while already on the VP8/fallback format is never restarted

medium · accepted · C-e4dd705a6467

Per the MediaRecorder spec, a fatal error event is followed by the recorder stopping, and onstop clears mediaRecorderRef. A restart happens only when React re-renders with changed effect dependencies. For an MP4 recorder, onerror flips relayMp4Failed, which re-renders and restarts with VP8. For a non-MP4 recorder, or once relayMp4Failed is already true, onerror only logs. No state changes, so neither the membership effect nor the parameter effect re-runs, and the relay stays down. The safety-flush interval and the silent-audio AudioContext also stay alive until a later stop.

## Security section says all media is DTLS-encrypted, but the same page describes a non-WebRTC relay path

medium · accepted · C-e08bdd29e5ae

The Security and privacy section states that "media is encrypted in transit with WebRTC DTLS." The same page also describes a second delivery path: a relay "over the page connection" used for public-link viewers, plus an opt-in Relay Mode for H.264 OBS rooms. That relay path is not WebRTC, so DTLS does not protect it. Its confidentiality depends only on the page's transport. Same-network viewers are pointed at a Local Link, and line 116 tells hosts to capture only from the local host page. That instruction suggests the LAN origin is not a secure context, which typically means plain HTTP/WS. On the public link, TLS ends at the tunnel provider, so the relay media is not end-to-end encrypted either. The blanket claim is therefore inaccurate for at least one documented path.

## Height-bounded video stage width collapses to zero or a sliver on short viewports such as landscape phones

medium · accepted · C-7800a02b5d47

The stage width is min(100%, var(--media-stage-max-width), (100svh - var(--stage-chrome)) * 16 / 9), and the height term has no lower bound. The default --stage-chrome is 24rem (384px). The @media (max-height: 820px) block at line 2052 raises it to 26rem (416px), and .watch-video sets 19rem (304px) on the element. When the small-viewport height is at or below the chrome budget, the third term is zero or negative. A negative width from min()/calc() is clamped to 0, so the 16:9 stage, which has overflow: hidden, renders with no size. Just above the budget the stage is only a sliver. For example, a viewer with about 340px of svh gets (340 - 304) * 16 / 9, which is about 64px of video. The comment says the term is inert on every phone. That is false in landscape orientation, where height is the binding constraint.

## Unbounded reload loop on persistent chunk loading failures

high · accepted · C-07a926089959

Chunk load error recovery relies solely on an in-memory boolean flag `reloadScheduled`. When `window.location.reload()` executes, the page completely reloads and resets the JavaScript execution context along with `reloadScheduled`. If a dynamic chunk fails to load persistently (such as after a deployment where old chunks are deleted, or during a persistent network issue), the page enters an infinite reload loop.

## Queue-overflow drops discard arbitrary fragments and resume mid-GOP; dropped fragments are still acked

medium · accepted · C-009d5a411943

When appendQueue reaches 600 entries or 16 MB, handleMediaChunk drops the incoming fragment. As soon as one slot frees, the next fragment is enqueued and consecutiveDrops resets to 0. Each chunk carries keyframeStart, but the player never reads it, so after a drop it resumes appending mid-GOP. In sequence mode those fragments are laid end to end, and the decoder receives inter-frames whose reference frames were discarded. Only 15 consecutive drops trigger resetAndRequestInit, which re-inits and forces a random-access point. Interleaved drops never reach that threshold. In addition, relay-ack is sent before the overflow check, so the server's latency measurement counts dropped fragments as delivered.

## socketRequest retries create-room and join-room after timeouts that the server may have already processed

medium · accepted · C-3d1ab7efd04f

create-room, join-room, reclaim-host and leave-room are retried once after a 'timed out' or 'connection lost' error. A client-side timeout does not mean the server skipped the request. The late ack is simply ignored because of the settled flag, and the same request is sent again. For create-room and join-room this can create a second room or a double join, or the retry may fail with an 'already exists/joined' error, depending on server idempotency. isTransientError also matches any server error message containing 'timed out', so genuine server-side failures get retried too.

## A timed-out mutation loses its already-captured rollback state

medium · accepted · C-4a8fe6288cb3

<quotes>
src/lib/obsWebSocket.js:87-88
                    pendingRequests.delete(requestId);
                    reqReject(new Error(`OBS request ${requestType} timed out after ${requestTimeoutMs}ms.`));
src/lib/obsWebSocket.js:475
        const inverse = await snapshotMutation(requestType, requestData);
src/lib/obsWebSocket.js:485-489
        const response = await sendRequest(requestType, requestData);
        if (!successfulResponse(response)) return response;

        if (inverse) {
            rollbackSteps.push(inverse);
</quotes>
An OBS mutation can take effect even if its response arrives after the request timeout. Although its inverse was captured before dispatch, it is journaled only after a successful response. A timeout throws past that insertion, so rollback silently omits the possibly applied mutation and can report no rollback failures.

## Rollback of profile parameters that were unset writes an empty string instead of restoring the default

medium · accepted · C-a828ec1795b0

For a parameter with no user value, GetProfileParameter returns parameterValue null, and OBS uses defaultParameterValue. The snapshot turns null into '' and rollback writes that empty string. In v5, sending parameterValue null deletes the parameter instead. The result is that a 'rollback' replaces OBS defaults with explicit empty values. Affected keys include AdvOut Encoder, SimpleOutput VBitrate and StreamEncoder, Stream1 IgnoreRecommended, AdvOut ApplyServiceSettings and Video ColorSpace/ColorRange. OBS reads those as 0, false or an empty encoder id.

## Rollback restores configuration without waiting for stream shutdown

high · accepted · C-2e1af7e99156

<quotes>
src/lib/obsWebSocket.js:492-493
        } else if (requestType === 'StartStream') {
            rollbackSteps.push({ requestType: 'StopStream' });
src/lib/obsWebSocket.js:502-504
        for (const step of rollbackSteps.reverse()) {
            try {
                const response = await sendRequest(step.requestType, step.requestData);
src/lib/obsWebSocket.js:233-234
        await delay(250);
        const nextStatus = await getStreamStatus(sendRequest);
</quotes>
Rollback treats a successful StopStream response as completed shutdown and immediately dispatches the next inverse configuration mutation. Unlike the forward stop path, it never polls for inactivity. When OBS acknowledges stopping before the output actually finishes, restoring video, service or encoder-related settings races the still-active replacement stream.

## Rollback restarts the stream right after restoring video settings, skipping the settle delay the forward path uses to avoid an OBS crash

medium · accepted · C-6cf5d2b06b57

The StopStream sent by stopActiveStream is the first mutation recorded, with StartStream as its inverse. SetVideoSettings is recorded later. Rollback replays the inverses in reverse, one after another with no pause. So it restores the previous video settings, which resets OBS's video pipeline, then restores the stream service, then immediately issues StartStream. The forward path waits 1200 ms before StartStream for exactly this reason. Its comment says that starting the encoder while a video reset is in flight can crash OBS in video_output_connect2.

## Transaction deadline closes the connection before rollback

high · accepted · C-85e8ca23d8f5

<quotes>
src/lib/obsWebSocket.js:161-164
                        done({
                            success: false,
                            message: `OBS setup timed out after ${transactionTimeoutMs}ms.`,
                        });
src/lib/obsWebSocket.js:66-68
            rejectPendingRequests(new Error(result?.message || 'OBS WebSocket transaction ended.'));
            try { ws.close(); } catch {}
            resolve(result);
src/lib/obsWebSocket.js:552
                const rollbackFailures = await transaction.rollback();
</quotes>
The connection-level deadline calls done directly instead of the configuration finish handler. It marks the connection settled, rejects pending requests and closes the socket before configuration rollback can run. A resulting callback rejection may eventually invoke finish, but its rollback requests are then rejected because the connection is already settled. The caller has already received the timeout result.

## openObsControlChannel().close() does nothing before the handshake completes, leaving the channel open for the page lifetime

medium · accepted · C-3c20059705e3

close() can only end the connection through `settleConnection`. That reference is assigned inside the callback, which runs only after OBS sends Identified (op 2). If close() is called while the socket is still connecting or authenticating, it nulls `sendRequest` and returns. The WebSocket stays open. When the handshake later completes, the callback re-assigns `sendRequest` and `settleConnection` and returns a promise that never settles. transactionTimeoutMs is Infinity, so nothing ever closes the session. The 'closed' channel also comes back to life: stopStream() will send requests again.

## Housekeeping stream cleanup is neither guaranteed nor verified

high · accepted · C-9d767f71181a

<quotes>
src/lib/obsWebSocket.js:265
        const started = await sendRequest('StartStream');
src/lib/obsWebSocket.js:270
            const status = await getStreamStatus(sendRequest);
src/lib/obsWebSocket.js:276
        await sendRequest('StopStream');
src/lib/obsWebSocket.js:282
        if (ran) return true;
src/lib/obsWebSocket.js:608
            if (await releaseStaleEncoder(rawSendRequest)) {
src/lib/obsWebSocket.js:616
            const videoResult = await sendRequest('SetVideoSettings', videoSettings);
</quotes>
A request exception after StartStream but before StopStream skips cleanup because there is no finally block. On the nonexceptional path, the StopStream response is ignored, and exhausting all stop-status polls still returns true whenever ran was observed. Configuration can therefore proceed to video and encoder mutations while the temporary output is still active. These raw-channel operations also have no transaction inverse.

## Configuration broadcasts even when autoStart is false

high · accepted · C-ac8b3a070c20

<quotes>
src/lib/obsWebSocket.js:540
export async function configureObsStream({ whipUrl, bearerToken, password = '', autoStart = false, videoSettings = null, encoderSettings = null, writeEncoderSettings = null, listEncoders = null }) {
src/lib/obsWebSocket.js:594
                server: whipUrl,
src/lib/obsWebSocket.js:605-608
        if (!stopResult.wasLive) {
            // Uses the raw channel: this start/stop is housekeeping, not a step
            // a failed setup should roll back.
            if (await releaseStaleEncoder(rawSendRequest)) {
src/lib/obsWebSocket.js:265
        const started = await sendRequest('StartStream');
</quotes>
The housekeeping stream is independent of autoStart. With OBS initially idle, configuration installs the supplied WHIP destination and starts a real broadcast even when autoStart is explicitly false or omitted. The flag only controls the later, final start.

## Encoder-file changes are excluded from configuration rollback

medium · accepted · C-bd27b5f28721

<quotes>
src/lib/obsWebSocket.js:791-792
                        const written = await writeEncoderSettings({ profileName, settings: encoderFileSettings });
                        encoderSettingsApplied = written?.applied === true;
src/lib/obsWebSocket.js:824-827
                await finish({
                    success: false,
                    message: `OBS configured, but auto-start failed: ${startResult.requestStatus?.comment || 'unknown error'}`,
                });
src/lib/obsWebSocket.js:552
                const rollbackFailures = await transaction.rollback();
</quotes>
The external encoder-settings write happens before later fallible operations, but no previous file contents or undo operation are registered with the transaction. If auto-start subsequently fails, finish restores WebSocket-managed settings only. A successful disk write remains in place even when the failure message says OBS settings were restored.

## Auto-start streams with the old output mode and encoder even after deciding OBS needs a restart

medium · accepted · C-9fc687f89a33

The code states that OBS builds its outputs (mode and encoder) only at startup or on a profile change. When the mode or encoder changed, it records only a warning. With autoStart it still sends StartStream and returns success true. For AV1, the Simple-mode mirror is skipped (it only runs for h264), so OBS will likely stream with its old encoder, usually H.264, while the app treats the session as AV1. For H.264, the old output handler may ignore the new bitrate, keyframe and B-frame settings.

## window.localStorage is read at module load outside any try/catch

medium · accepted · C-6669f71b004a

The window.localStorage property is evaluated as an argument at module top level, so any guard inside isMediaDebugEnabled cannot catch the error. Browsers throw a SecurityError on this access when site storage or cookies are blocked, or in sandboxed iframes without allow-same-origin. The WatchView module then fails to evaluate.

## Status polling can continually abort slow metrics requests

medium · accepted · C-38f389b21b3c

<quotes>
src/StatusView.jsx:7
const REFRESH_INTERVAL_MS = 5000;
src/StatusView.jsx:43
        abortRef.current?.abort();
src/StatusView.jsx:76: void fetchMetrics();
src/StatusView.jsx:69
            if (err?.name === 'AbortError') return;
</quotes>
Every refresh aborts the preceding request, and the poll callback discards its promise. Consequently, even a poller that normally awaits asynchronous work cannot observe that this request remains pending. If successive refresh ticks occur every five seconds, requests taking longer than that are repeatedly cancelled without an error being displayed.

## Superseded playback attempts keep mutating shared refs and the video element after awaits

medium · accepted · C-46da39562b9e

Both playback starters capture an attemptId but check it only at a few points. startMediasoupPlayback awaits create-recv-transport and then assigns recvTransportRef without checking whether the attempt was superseded. startRelayPlayback checks the attempt only once, at line 705, after awaiting relay-consume-start, get-media-init, the live media-init wait and sourceopen. During those awaits it sets relaySubscribedRef, mediaSourceRef, objectUrlRef, videoRef.current.src and sourceBufferRef unconditionally. If cleanupPlayback runs while an attempt is in flight, the stale attempt re-attaches its own MediaSource to the shared video element and marks the relay as subscribed after cleanup has already run. Triggers for that cleanup include the 40s watch timeout, transport-failed recovery, socket reconnect and Try WebRTC. cleanupRelayAttempt never emits relay-consume-stop. Stale attempts also reject, and their callers react with cleanupPlayback()/setError. handleWatch, onTransportFailed and onReconnect all do this, so they can tear down the newer, healthy session. onTransportFailed and onReconnect also start recovery attempts with no mutual exclusion.

## WebRTC connection timeout starts after potentially indefinite playback waits

medium · accepted · C-ba4dead4ddc6

<quotes>
src/WatchView.jsx:190
            await videoRef.current.play();
src/WatchView.jsx:248
        await playVideoElement(newStream);
src/WatchView.jsx:356-358
        for (const producer of producers) {
            await consumeProducer(producer.producerId, attemptId);
        }
src/WatchView.jsx:365
        const iceTimeoutMs = shouldFailFastForTunnel ? 2000 : 8000;
</quotes>
The ICE timeout is installed only after all producers have been consumed, but consuming a producer awaits video.play(). That promise can remain pending while an unreachable WebRTC connection supplies no media, preventing execution from reaching the connection timeout. Unlike handleWatch, Try WebRTC and the automatic recovery paths have no enclosing 40-second deadline.

## Relay queue overflow or SourceBuffer error after playback starts leaves the UI in watching/relay state with a frozen stream

medium · accepted · C-d20f555bcf10

failRelayGeneration removes the chunk listeners and emits relay-consume-stop. It does not reset watching or playbackMode, tear down the MediaSource, or restart playback. It sets fallbackState, which belongs to fMP4 fallback mode and is not used for relay status, so the status line keeps reporting an active relay. A SourceBuffer 'error' only clears appendingLock. After an MSE parse or decode error, MediaSource leaves the 'open' state and processQueue returns early, so the failure stays silent until 240 chunks or 24MB accumulate. During startup, cleanupRelayAttempt settles firstBuffered with the generic 'cleaned up' error before settleFirstBuffered(failure) runs. The specific overflow message is therefore lost, and the caller's catch handler overwrites the displayed error.

## Relay append failures silently discard required media bytes

medium · accepted · C-bc451ddd2eaa

<quotes>
src/WatchView.jsx:522
                const nextChunk = chunkQueueRef.current.shift();
src/WatchView.jsx:528-533
                queuedBytesRef.current = Math.max(0, queuedBytesRef.current - nextChunk.byteLength);
                sourceBufferRef.current.appendBuffer(nextChunk);
            } catch (appendErr) {
                console.warn('[Nextra] appendBuffer error:', appendErr.message);
                appendingLock = false;
            }
</quotes>
The chunk is removed and its byte count deducted before appendBuffer succeeds. A synchronous failure, including QuotaExceededError, only logs the error, permanently losing those bytes while subsequent chunks continue to be processed. Asynchronous SourceBuffer errors likewise only clear the lock. Neither path transitions established playback into a recoverable failure state.

## An in-flight reconnect can undo an explicit Leave Room

medium · accepted · C-210358e42002

<quotes>
src/WatchView.jsx:905
            await device.load({ routerRtpCapabilities: rtpCapabilities });
src/WatchView.jsx:923
        setJoined(true);
src/WatchView.jsx:1181
            await socketRequest(socket, 'leave-room', {}, { timeoutMs: 5000, maxAttempts: 1 });
src/WatchView.jsx:1191
        setJoined(false);
src/WatchView.jsx:1237
                const response = await joinRoomAndLoadDevice(roomCode);
</quotes>
Reconnect leaves the joined UI available while awaiting room rejoin and device loading. Leave Room can therefore complete during that wait. The pending join helper has no session-generation or cancellation check before restoring the room refs and setting joined true, and reconnect can subsequently attempt playback. The UI can return to a joined state even though the server has already processed the leave.

## fallback-consume-start uses an un-timed ack; a lost ack latches isEnteringFallbackRef and blocks fallback, and a late ack starts a player regardless of state

medium · accepted · C-5a217b5eb0cb

Other requests in this file go through socketRequest with timeouts. enterFallbackMode instead uses a raw socket.emit with an ack callback and no timeout. isEnteringFallbackRef is set to true before the emit and is cleared only inside the ack or in exitFallbackMode. If the connection drops after the emit, socket.io-client never invokes that ack. onReconnect then resets fallbackMode to false but not isEnteringFallbackRef. Its call to enterFallbackMode() returns immediately, and so does the auto-enter effect. The viewer can no longer enter fMP4 fallback. If the server never answers, the UI stays in 'connecting' indefinitely, because the 40s watch safety timeout does not cover this path. The ack callback also never checks whether the viewer is still joined, whether the room ended, or whether another session has started. A late ack therefore calls cleanupPlayback(), which can tear down a session started meanwhile. It also creates and starts an fMP4 player, falling back to codeInput when joinedRoomCodeRef has been cleared.

## Sorted ticket files do not guarantee mutual exclusion

medium · accepted · C-5483ef840d06

<quotes>
        String(Date.now()).padStart(13, '0'),
</quotes>
<quotes>
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(ticketPath, '', { flag: 'wx' });
</quotes>
<quotes>
                .sort();
            if (tickets[0] === ticketName) break;
</quotes>
The ordering key is chosen before asynchronous filesystem operations. A worker with an earlier key can publish its ticket after another worker has already observed itself first and entered. The late publisher then also observes itself first and enters; the existing holder never rechecks ownership. Exclusive creation of distinct ticket filenames does not prevent this race.

## SPS/PPS are re-injected before every IDR slice, splitting multi-slice keyframes into non-conforming access units

medium · accepted · C-abe73b05c848

The pushFrames test expects a two-slice keyframe to come out as [SPS, PPS, IDR, SPS, PPS, IDR], and a comment states that parameter sets go before each IDR slice. H.264 clause 7.4.1.2.3 says an SPS or PPS NAL unit that follows the last VCL NAL unit of a primary coded picture begins a new access unit. Inserting them between slices of one picture therefore produces a non-conforming bitstream in which the second slice appears to start a new access unit. The push() path does the same per-IDR-NAL injection. When the IDR already carries in-band SPS/PPS, the output probably duplicates them, and no test covers that case.

## Client IP is taken from client-controllable forwarded headers (leftmost X-Forwarded-For, unconditional CF-Connecting-IP)

medium · accepted · C-993924baa102

The tests lock in two behaviors. First, parseForwardedFirst returns the leftmost X-Forwarded-For entry. Second, getTrustedForwardedClientIp returns CF-Connecting-IP whenever the TCP peer is loopback and trust is enabled. Standard proxies (nginx $proxy_add_x_forwarded_for, Caddy, Cloudflare) append the address they observed on the right, so the leftmost XFF entry is whatever the client sent. CF-Connecting-IP is only authoritative when the loopback peer is cloudflared/Cloudflare. Any other loopback reverse proxy passes a client-supplied CF-Connecting-IP through unchanged. Trust depends only on the peer being loopback, not on which proxy is deployed or which header it overwrites.

## "without auto-start" test cannot detect an unwanted StartStream

medium · accepted · C-c38b441fff11

The test title says a live output is stopped and then reconfigured "without auto-start", and it passes autoStart: false. Its fake OBS only adds StopStream, SetStreamServiceSettings and SetVideoSettings to `order`. A StartStream request falls through to the generic success reply. It is never recorded and never sets outputActive. If configureObsStream wrongly sent StartStream (for example at the end, ignoring autoStart: false), the order assertion would still pass. The no-auto-start contract is therefore untested.

## Setup runs an unrequested live test stream to the target room, even when OBS was idle

medium · accepted · C-acd4cd6d33eb

The tests require configureObsStream to point OBS at the new room's WHIP endpoint and issue StartStream then StopStream, to make OBS release an old encoder. This is required even when OBS was idle, and the attempt is repeated once if it fails. The test stream runs before the new video settings are applied, and no test passes autoStart: false on this path. Whatever OBS is currently compositing, which could be a full desktop capture, is sent to the broadcast room before the host has chosen to go live. Viewers already in the room may see it.

## Probe endpoint test never sends a wrong token while a probe is armed

medium · accepted · C-1a0aeac94ce4

The comment says nothing is served for a wrong token. However, the only wrong-token request is made before probe.measure() arms a probe, so the 404 can come from the 'no probe in progress' branch without ever reaching the token comparison. While the probe is armed, the test only sends the correct token (once to download, once to show it is spent). A handler that served any token while armed would still pass.

## Disconnect-during-creation check waits a fixed 25 ms, likely shorter than the scrypt hash it races

medium · accepted · C-58d755516428

The disconnect case starts a create-room with a passphrase, closes the client, and waits until the pending reservation count drops to 0. It then releases the deferred prepareRoom, which runs the real scrypt hash for 'disconnect hashing'. It sleeps a fixed 25 ms and asserts that the room count is unchanged. Scrypt at typical cost parameters often takes tens of milliseconds, and longer on a loaded CI runner. In that case the assertion runs before the code path that could wrongly commit a room for the disconnected host has run. The test then passes whether or not disconnect cancellation works, and the finally block tears down the server while that creation is still in flight.

## WHIP start race tests never check that the rejected request leaves the winner's claim or pending slot intact

medium · accepted · C-2fb8bcd212c7

Right after the losing request is rejected (409 or 503), both tests release the winning request. The later assertions (whipStarting false, whipTransport null, the next request admitted) would also pass if the rejection path wrongly cleared room.whipStarting or decremented the global pending-start counter. That could happen if a shared finally or error handler also ran on early 409/503 returns. Such a regression would admit a third concurrent start while the first is still allocating. It could also push the pending counter negative, silently raising the effective limit.

## WHEP answer SDP is barely checked, and the partial audio failure test never checks the failed audio m-section

medium · accepted · C-5886d250ed5f

The success test checks only that the answer contains 'v=0' and 'a=sendonly'. The partial failure test offers video plus audio (BUNDLE 0 1, audio at mid:1) and injects an audio consume() rejection. It then checks only HTTP 201 and some counters, and never reads the answer body. Under RFC 3264 and JSEP, an answer must have one m-section per offered m-section, in the same order. A failed audio leg must be rejected (port 0) or set to inactive. The suite would not catch an answer that drops the audio m-line, leaves it sendonly with no SSRC, has the wrong mids, or uses a setup attribute that contradicts the asserted remote DTLS role 'client'.

## createViewerAnswer test requires the SDP answer to advertise a header extension the viewer never offered

medium · accepted · C-7f17ab5999fc

SAMPLE_OFFER's video m-section offers only one header extension, extmap:1 sdes:mid. The bundled audio section binds ID 4 to ssrc-audio-level. The mock video consumer carries ID 4 = transport-wide-cc, and the test asserts that the generated answer contains 'a=extmap:4 ...transport-wide-cc...'. This means createViewerAnswer copies consumer.rtpParameters.headerExtensions verbatim. It does not limit them to the extensions and IDs present in the matching offer m-section. JSEP (RFC 8829 section 5.3.1) only allows answer a=extmap lines for supported extensions that are present in the offer. The audio fixture also uses ID 5 for ssrc-audio-level while the offer uses ID 4, and no test checks that the answer reconciles IDs with the offer. The test suite therefore locks in an offer/answer mismatch instead of guarding against one.

## No test covers rollback after a stream was stopped or test-started; the withStream fake hides stream state

medium · accepted · C-d82b36078052

The transaction tests show that a StopStream recorded in a transaction is undone with StartStream on rollback. The setup tests require that a stale stream be stopped before anything changes, and they add a StartStream/StopStream encoder-reset probe. No failure-path test combines either of these with a later rollback. If they go through the transaction, rollback could restart a stale stream (one retrying a room that no longer exists), or start streaming to the new room before the old service is restored. The failure tests at lines 380 and 497 use withStream, which keeps `status` in a default parameter the test cannot read. They therefore cannot assert that OBS is left not streaming.

## Proxy-header trust tests cover only single-value X-Forwarded-For, so spoofed leftmost hops are untested

medium · accepted · C-bfcdc67f6dce

The integration server runs with TRUST_X_FORWARDED_HEADERS=true from a loopback peer. The suite shows that the forwarded address alone determines privilege. With no X-Forwarded-For, the caller gets loopback treatment: sensitive JSON metrics and create-room without an operator token. With a 203.0.113.x value, the caller gets 403 or 'Operator authorization'. With 192.168.50.25, the caller gets trusted-LAN relay (relayAllowed true). Every case uses a single-value header. Real proxies, including Cloudflare, append to a client-supplied X-Forwarded-For instead of replacing it, so an attacker controls the leftmost entry. No test sends a chain such as '127.0.0.1, 203.0.113.40'. Nothing verifies that the server picks the proxy-appended hop rather than the client-controlled one, or that it ignores the header when the peer is not a trusted proxy.

## Unauthenticated destructive /api/test/* endpoints have no negative test proving they are disabled outside smoke-test mode

medium · accepted · C-d197b37dade1

The tests call /api/test/shutdown, /api/test/unhandled-rejection and /api/test/kill-media-worker with bare POSTs: no operator token, no Origin header, no body. They expect 202. These endpoints can stop the server, crash it with exit code 1, or kill the mediasoup worker and end every room. Their availability appears to depend only on the NEXTRA_SMOKE_TEST environment flag. No test asserts that these routes return 404 when the flag is unset, or when NODE_ENV/APP_ENV indicate production. The gating therefore relies entirely on code outside this snapshot and can regress silently.

## Vite dev/preview proxy makes every proxied client look like loopback while public quick-tunnel hosts are allowlisted by default

medium · accepted · C-740131c505fd

Both the dev and preview servers always allowlist '.trycloudflare.com', which is a public tunnel domain. Both proxy /api and /socket.io from the Vite process to localhost:3000 with changeOrigin, and xfwd is not enabled. The backend's TCP peer for all proxied traffic is therefore 127.0.0.1, and Vite adds no forwarding information of its own. The integration tests show the backend gives loopback callers extra privileges: unauthenticated JSON metrics with sensitive fields, and create-room without an operator token. The config's own comment says to 'never expose Vite dev/preview publicly', yet the default allowlist enables exactly that through quick tunnels. Whether the backend still sees the real client depends on headers passed through from cloudflared and on backend trust settings, neither of which is visible in this snapshot.
