# Testing Gaps

## Current state

The audited repository passed:

- 80 Node tests
- ESLint
- the Vite production build
- the OSS preflight

Those checks are useful, but the tests are concentrated in parsers and isolated helpers. A Node coverage probe reported 54.08% aggregate line coverage while the most important runtime modules were much lower:

| Module | Approximate line coverage |
|---|---:|
| lib/socket.js | 10.86% |
| lib/whepRoutes.js | 13.43% |
| lib/whipRoutes.js | 18.03% |
| lib/mediasoup.js | 15.33% |
| React views | effectively untested |
| src/lib/fmp4RelayPlayer.js | effectively untested |
| src/lib/obsWebSocket.js | effectively untested |

There is no configured source coverage threshold, and the aggregate includes files that make the number look healthier than critical-path coverage.

## T-01 — No server HTTP and Socket.IO integration suite

Severity: High

Missing coverage includes:

- create-room, join-room, retry, leave, disconnect, and room replacement
- delayed or lost acknowledgements
- origin and forwarded-header behavior
- combined Socket.IO and WHEP viewer caps
- server shutdown with active rooms
- stale-room destruction
- payload-size and rate-limit enforcement

Use real HTTP and Socket.IO clients against an ephemeral server with injectable mediasoup/FFmpeg adapters.

## T-02 — No browser lifecycle tests

Severity: High

The host privacy blocker would be caught by a browser test that starts a fake capture stream and navigates away.

Required browser cases:

- route unmount closes every host resource
- capture track ended closes the session
- Stop and unmount racing remain idempotent
- viewer leave/rejoin
- producer close/recreate
- stale track removal
- fallback overflow recovery
- fMP4 generation cleanup
- pagehide and full reload

Use Playwright with browser media permissions and deterministic fake media devices where possible.

## T-03 — No concurrent WHIP/WHEP admission tests

Severity: High

Send parallel POSTs while holding transport creation promises open. Verify:

- only reserved capacity is admitted
- rejected requests leak no transports
- replacement invalidates older callbacks
- destroyed rooms cannot be resurrected by late events
- resource mappings return to zero
- disconnect timers cannot close a replacement session

## T-04 — No fallback state-machine and fault-injection suite

Severity: High

Inject failures after every startup allocation:

1. video DirectTransport
2. video consumer
3. audio DirectTransport/consumer
4. PlainTransport
5. UDP allocation
6. frame-rate sampling
7. FFmpeg spawn
8. first initialization segment

After each failure, assert zero children, transports, consumers, timers, listeners, and buffered bytes. Also start the pipeline concurrently from WHIP prewarm and two viewers and prove exactly one generation exists.

## T-05 — No real media-plane topology test

Severity: High

Page loading and Socket.IO connection do not prove mediasoup media reachability.

Maintain separate automated checks for:

- LAN direct WebRTC
- public direct WebRTC with announced address
- public H.264 fallback over tunnel
- AV1 behavior when direct media is unavailable
- browser TURN and server candidate reachability
- ICE restart after network changes

## T-06 — No OBS WebSocket transaction tests

Severity: Medium

Use a fake OBS WebSocket server that can delay, reject, disconnect, and reorder responses. Verify per-request deadlines, pending-promise rejection, overall timeout, rollback, and clean disconnect.

## T-07 — No long-run memory and churn test

Severity: High

Repeatedly create and destroy rooms, reconnect OBS, start/stop fallback, and replace playback generations. Track:

- heap after garbage collection
- active handles
- child processes
- mediasoup transports and consumers
- event listener counts
- object URL generations
- log growth

A 30- to 60-minute churn test should remain within a defined stable envelope.

## T-08 — No Windows packaged artifact smoke test

Severity: High

From a clean Windows runner:

- build and package
- verify licenses and SBOM are present
- verify Authenticode
- launch on an ephemeral port
- poll readiness
- create a room
- verify static assets and Socket.IO
- terminate gracefully
- confirm no child cloudflared process remains

Test the exact signed artifact, not a separately rebuilt copy.

## T-09 — No load envelope

Severity: Medium

Establish supported values for:

- concurrent rooms
- direct viewers per room
- WHEP sessions
- simultaneous FFmpeg relays
- total relay bitrate
- event-loop delay
- worker CPU
- memory and file descriptor/handle counts

Use the results to set safe defaults rather than exposing theoretical values such as 100 rooms by default.

## Recommended quality gates

- All blocker regression tests required for merge.
- Source-only line and branch coverage thresholds.
- Higher thresholds for state machines and resource registries.
- Root and every nested package audited.
- Linux server integration plus Windows package smoke test.
- Dependency and cloudflared updates run through the same media interoperability suite.
- Long-run churn test required before production releases.
