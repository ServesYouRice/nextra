# Correctness and Security Findings

## CS-01 — OBS producer replacement retains stale tracks

Severity: High

WatchView consumes new producers around src/WatchView.jsx:685-699, while onProducerClosed around :705-707 only logs. It does not close and remove the matching consumer and MediaStreamTrack.

After OBS reconnects, the stream can contain both an ended video track and the replacement. Browser track selection can leave the video element frozen on the ended track.

Fix:

- Maintain consumerId to consumer/track mappings.
- Remove and stop the exact track on producer-closed.
- Replace existing same-kind tracks atomically.
- Deduplicate producer IDs and ignore stale generations.

## CS-02 — WebM fallback drops arbitrary bytes from a continuous stream

Severity: High

The legacy relay queue is bounded at 240 chunks and 24 MiB in src/WatchView.jsx:7-8. When it exceeds a limit, the code drops oldest chunks around :423-433.

WebM delivered as a continuous stream cannot safely lose arbitrary encoded fragments. The server acknowledges this constraint in lib/socket.js:522-525. Append failures are logged and processing continues, and this playback path has no normal old-range SourceBuffer eviction.

Fix:

- Treat queue overflow or parsing/append failure as a broken generation.
- Unsubscribe and request a fresh initialization generation.
- Evict old buffered time ranges before quota pressure.
- Add a maximum buffered-duration target and observable recovery state.

## CS-03 — fMP4 playback generations leak listeners and object URLs

Severity: High

src/lib/fmp4RelayPlayer.js:418-435 resets the MediaSource on a new initialization segment. Generation listeners and URL cleanup are added around :523-552, but cleanupMediaSource around :555-582 does not execute all per-generation cleanup callbacks. They persist until final stop around :624.

An in-flight get-init callback also lacks a robust stopped/generation check and can recreate a MediaSource after shutdown.

Fix:

- Split lifetime cleanup from generation cleanup.
- Capture and clean the exact MediaSource and object URL for each generation.
- Cancel or ignore every stale async callback with a generation ID or AbortController.
- Test hundreds of reconnect generations for stable listener and heap counts.

## CS-04 — WHIP/WHEP admission and replacement are non-atomic

Severity: High

Global and room capacity checks in lib/whepRoutes.js occur before awaited setup and registration. Concurrent requests can both pass. Socket viewer admission does not consistently include WHEP sessions in the same room cap.

WHIP has similar replacement risks:

- Transport creation starts before the session is installed.
- Outer error handling does not guarantee every partially created resource is closed.
- Concurrent authenticated POSTs can both create transports and producers.
- Late DTLS/producer events can mutate a replaced or destroyed room.
- resourceToRoom mappings can outlive normal room destruction.

Fix:

- Reserve capacity atomically before awaits.
- Release reservations in finally.
- Attach a room/session generation token to every callback.
- Centralize replacement and shutdown in a session registry.
- Use one combined viewer-capacity calculation for Socket.IO and WHEP.

## CS-05 — Browser send transports and producers lack explicit ownership

Severity: High

The send transport created around src/HostView.jsx:1034 is not retained by the host cleanup owner. The audio producer around :1077-1082 is likewise not stored consistently. Current cleanup primarily stops MediaStream tracks.

Server disconnect eventually removes remote resources, but local PeerConnections and producer objects should not depend on delayed socket teardown or garbage collection.

Fix:

- Store transport, video producer, and audio producer in HostSession.
- Close producers before the transport.
- Make every failure and unmount path call the same close operation.

## CS-06 — Retrying join-room is not idempotent

Severity: High

src/lib/mediasoupClient.js:5-11 marks join-room as retryable. If the first request succeeds but its acknowledgement arrives after the client timeout, the retry reaches lib/socket.js:1209-1212 and can return Already in a room.

WatchView also sets joined state around src/WatchView.jsx:817-820 before device loading completes around :841-846. An import or device-load failure can strand server membership while the client reports a failed join.

Fix:

- Add an operation ID and make join-room idempotent, or remove automatic retry.
- Do not commit joined UI state until required initialization succeeds.
- On any post-join client failure, send leave-room and reset all membership state.

## CS-07 — TURN credentials are returned by unauthenticated configuration

Severity: High when TURN is configured

server.js:643-663 returns iceServers from the public /api/config endpoint. config.js:109-126 can generate credentials with a 24-hour TTL.

Any client that can reach the service can scrape those credentials without proving room membership. Static TURN credentials are exposed indefinitely; generated credentials can be used for their full TTL.

Fix:

- Public configuration should expose only capability booleans and non-secret URLs.
- Issue credentials only after successful room join or transport authorization.
- Use short TTLs measured in minutes.
- Apply per-user, per-room, and global issuance limits.

## CS-08 — Cloudflare credential minting uses an unprotected side-effecting GET

Severity: High

server.js:666-690 exposes GET /api/cloudflare-turn-credentials. The handler calls the provider for any client classified as local and has no endpoint-specific cache or rate limit.

LAN clients, local malware, or cross-site requests that reach the private service may consume provider quota even if browser policy prevents reading the response.

Fix:

- Change it to POST.
- Require a host-session capability or CSRF-protected same-origin operation.
- Add per-IP and global rate limits.
- Cache credentials until near expiration.

## CS-09 — Remote OS media control defaults to enabled

Severity: High

HostView initializes allowMediaControl to true at src/HostView.jsx:377. The server stores that opt-in and accepts media-control actions around lib/socket.js:1773-1847. The setting is placed under Advanced settings, so many hosts will not realize it is enabled.

Possession of the room code is sufficient to request fixed OS media-key actions.

Fix:

- Default to false.
- Require explicit host consent for each room.
- Display a persistent active indicator.
- Add a server-wide disable flag.
- Rate-limit actions and log consent-safe audit events.

## CS-10 — Forwarded-header trust includes arbitrary private-network peers

Severity: High

lib/network.js:12-22 treats RFC1918 and ULA addresses as local. server.js:210-229 then implicitly trusts forwarded headers from a private peer when the request claims a known public share origin.

The bundled cloudflared process connects from loopback, so trusting the entire LAN is unnecessary. A LAN peer can supply CF-Connecting-IP or X-Forwarded-For and influence rate-limit identity and logs.

Fix:

- Limit implicit bundled-tunnel trust to loopback.
- Require explicit proxy CIDRs for other deployments.
- Parse only the expected proxy hop.
- Test spoofed forwarded headers from loopback, LAN, and public addresses.

## CS-11 — Secure-only TURN is reported as absent

Severity: Medium

server.js:245-249 checks only URLs beginning with turn:. config.js uses broader matching that includes turns:. A secure-only TURN configuration is therefore reported as no TURN, which can force fallback and show misleading diagnostics.

Use one shared ICE URL classification helper everywhere.

## CS-12 — End-to-end encryption claims exceed the implementation

Severity: Medium, product trust

src/App.jsx:130-131 and the footer describe the service as end-to-end encrypted. Mediasoup terminates WebRTC transport security, and fallback media is processed or relayed by the host server. The implementation provides encryption in transit, not cryptographic E2EE against the server.

Correct the copy immediately. If true E2EE is desired, design it separately using compatible encoded transforms and key distribution.

## CS-13 — Environment configuration lacks bounds and cross-field validation

Severity: Medium

config.js:23-31 parses integers and floats without enforcing safe ranges. Examples of invalid accepted input include:

- zero or negative cleanup intervals
- zero or negative room/viewer limits
- ports outside 1 to 65535
- RTC minimum above maximum
- derived port plus one beyond the configured range
- negative timeouts and bitrates

Define a schema, validate once at startup, and fail with actionable messages.

## CS-14 — SPA catch-all hides protocol and API mistakes

Severity: Medium

The final GET catch-all around server.js:760 serves index.html for unknown API, WHEP, WHIP-like, and asset paths.

Clients and monitors may receive HTML with status 200 instead of a useful 404 or protocol response. Add explicit API/protocol 404 handlers before the SPA fallback.

## CS-15 — Metrics tokens can leak through URLs

Severity: Medium

The metrics endpoint accepts an authentication token in the query string around server.js:594-609. Query values are commonly stored in browser history, reverse-proxy access logs, monitoring systems, and copied URLs.

Accept the token only through an Authorization header. If remote metrics are enabled, require a token rather than silently exposing a sanitized subset.

## CS-16 — First-interface LAN discovery can advertise the wrong network

Severity: Medium

config.js:13-20 selects the first non-internal IPv4 address. Windows interface ordering often places Docker, VPN, Hyper-V, or other virtual adapters first.

The result can be an unusable share URL and incorrect announced ICE address. Prefer the default-route interface, filter APIPA and common virtual adapters, and expose a diagnostic/override.
