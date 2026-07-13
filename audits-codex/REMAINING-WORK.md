# Remaining audit work

Updated: 2026-07-13

This is the single backlog for audit work that is not complete. Completed and
superseded audit reports were removed after their repository-controlled findings
were remediated.

## External release gates

### R-01 — Provision trusted Windows signing

The tagged release workflow signs, timestamps, and verifies `Nextra.exe`, but the
repository owner must provision a trusted publisher certificate through the
`SIGNING_PFX_BASE64` and `SIGNING_PFX_PASSWORD` GitHub secrets.

Completion criteria:

- a tagged build succeeds with a valid Authenticode signature
- the timestamp and publisher chain validate on a clean Windows machine
- the exact signed artifact passes the packaged-artifact smoke suite

### R-02 — Complete distribution legal review

LICENSE, notices, corresponding-source instructions, and a CycloneDX SBOM are
packaged. A qualified reviewer must approve the final distribution, dependency
notices, source-offer process, and release wording.

## Architecture and measured scale

### R-03 — Establish the supported load envelope

Current conservative defaults are 10 rooms, 10 direct viewers per room, and two
simultaneous fallback pipelines. Runtime metrics expose memory, event-loop delay,
resource counts, and relay throughput, but production limits still need measured
evidence.

Measure concurrent rooms, direct viewers, WHEP sessions, fallback pipelines,
total relay bitrate, worker CPU, event-loop delay, memory, and handle counts under
1080p, 1440p, and 4K traffic. Use the results to set and document supported limits.
Add room-affine mediasoup worker/router pooling only if measurements justify it.

### R-05 — Continue lifecycle-controller extraction

The first `RoomMediaPipeline` extraction now owns fallback startup generation,
capacity release, DirectTransport consumers, FFmpeg, startup/recovery timers, and
reverse-order idempotent cleanup. FFmpeg audio ingress no longer allocates UDP ports:
Node receives Opus RTP through a DirectTransport, wraps it in Ogg, and writes it to
an inherited FFmpeg pipe. This removed the former probe-to-child-bind window.

Large modules still combine several other state machines. Continue extracting
controllers with explicit ownership, state transitions, and one idempotent `close()`:

- `HostSession`: capture, browser transports/producers, recorder, heartbeat, OBS state
- extend `RoomMediaPipeline` ownership to the WHIP producers and ingest transport
- `ViewerSession`: consumer/track mappings, playback generation, retry and leave cleanup
- `SessionRegistry`: atomic WHIP/WHEP/socket reservations and room mappings
- `TunnelSupervisor`: process health, public URL, restart backoff, and termination

### R-06 — Move relay work off the signaling event loop if required

RTP depacketization, fallback parsing, buffering, and viewer fanout currently share
the Node event loop with signaling. Use R-03 measurements to decide whether to move
parsing/fanout to worker threads or a dedicated relay process. Define an acceptable
signaling-latency and event-loop-delay threshold before changing the architecture.

## Testing backlog

The current release gate passes ESLint, the Vite production build, OSS preflight,
both production dependency audits, and 97 Node tests. Windows CI also builds and
launches an unsigned packaged executable and polls `/readyz`. The following
critical-path coverage remains.

### T-01 — Server HTTP and Socket.IO integration suite

Run real HTTP and Socket.IO clients against an ephemeral server with injectable
mediasoup and FFmpeg adapters. Cover create/join/retry/leave/disconnect, delayed or
lost acknowledgements, room replacement, origins and forwarded headers, combined
Socket.IO/WHEP caps, shutdown with active rooms, stale-room destruction, payload
limits, and rate limits.

### T-02 — Browser lifecycle suite

Use Playwright with deterministic fake media devices. Cover host route unmount,
capture-track end, concurrent Stop/unmount, pagehide/reload, viewer leave/rejoin,
producer replacement, stale-track removal, fallback overflow recovery, and fMP4
generation cleanup.

### T-03 — Concurrent WHIP/WHEP admission suite

Send parallel requests while holding transport creation promises open. Verify
capacity reservations, rejection cleanup, replacement invalidation, late callbacks
after room destruction, zeroed resource mappings, and disconnect timers that cannot
close replacement sessions.

### T-04 — Fallback fault-injection suite

Inject a failure after each startup allocation: video transport/consumer, audio
transport/consumer, Ogg pipe setup, frame-rate sampling, FFmpeg
spawn, and first initialization segment. Each case must leave zero children,
transports, consumers, timers, listeners, and buffered bytes. Concurrent prewarm and
viewer starts must produce exactly one generation.

### T-05 — Real media-topology suite

Separately verify LAN direct WebRTC, public direct WebRTC with announced addresses,
public H.264 fallback through a tunnel, disabled AV1 when direct media is unavailable,
TURN/server-candidate reachability, and ICE restart after network changes.

### T-06 — Validate OBS transactions over a wire-level server

A deterministic fake OBS transport now covers delayed requests, protocol rejection,
disconnect cleanup, reordered responses, per-request deadlines, pending-promise
rejection, and the overall transaction timeout. Auto-configuration snapshots stream
service, video, profile, output, and stream-state mutations, restores them in reverse
order after a later failure, continues after an individual restore is rejected, and
reports incomplete rollback. The connection layer closes and settles exactly once
on each covered path.

Still required: run the same scenarios through a wire-level fake OBS WebSocket server
and a supported OBS Studio version, including a disconnect during rollback, to catch
protocol or version-specific behavior that an in-process transport double cannot.

### T-07 — Long-running memory and churn suite

For 30–60 minutes, repeatedly create/destroy rooms, reconnect OBS, start/stop
fallback, and replace playback generations. Define and enforce stable bounds for
heap after garbage collection, handles, child processes, transports, consumers,
listeners, object URLs, and log growth.

### T-08 — Exact signed Windows artifact suite

Extend the tag workflow to test the signed artifact itself: verify licenses, SBOM,
and Authenticode; launch on an ephemeral port; poll readiness; create a room; fetch
static assets; connect Socket.IO; terminate gracefully; and confirm no cloudflared
child remains. Do not rebuild between signing and testing.

## Recommended completion gates

- Blocker regression suites are required for merge.
- Source line and branch coverage thresholds exclude generated/vendor output and
  use higher thresholds for state machines and registries.
- Linux integration and exact signed Windows artifact checks both pass.
- Dependency and cloudflared updates run through the media interoperability suite.
- The churn and load envelopes pass before a production release.
