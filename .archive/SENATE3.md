# OBS WHIP Integration - Canonical Spec

This document is the self-contained source of truth for OBS WHIP support in this project.
It is written to stand on its own without requiring any other planning document.

---

## Goals

1. Let the host use OBS instead of browser capture.
2. Keep the existing viewer model based on room codes and mediasoup consumers.
3. Add OBS support without rewriting the room system.
4. Keep browser-host mode intact as the default fallback.

---

## V1 Scope

V1 supports this ingest path only:

- OBS and the Node server run on the same machine
- OBS sends WHIP to `http://localhost:<port>/whip/broadcast/:roomCode`
- viewers may still be local or remote
- viewer playback is direct WebRTC only for OBS rooms

V1 explicitly does not include:

- host self-preview in OBS mode
- relay fallback for OBS rooms (planned for V2 via FFmpeg remux — see Relay Strategy section)
- simulcast from OBS
- non-local WHIP ingest

That deliberate scope reduction is part of the design. It removes certificate friction and avoids solving multiple transport problems at once.

---

## Why OBS

Browser `getDisplayMedia` is good enough for lightweight screen sharing, but not for the broadcast use case this project is moving toward:

- it cannot reliably capture one arbitrary desktop application's audio in a clean way
- browser WebRTC throttles bitrate and quality aggressively
- it does not give the host proper scene composition or encoder control

OBS gives scene control, application-audio capture, and hardware-accelerated encoding (AV1 on modern GPUs, H.264 as fallback) while still feeding the same mediasoup-based viewer pipeline.

---

## Architecture Summary

```
OBS --(localhost HTTP + UDP)--> Nextra mediasoup server --(viewer HTTP/WebSocket/WebRTC)--> viewers
```

Important clarifications:

- The localhost requirement applies to the OBS-to-server ingest leg only.
- Viewer behavior is not "unchanged" in the abstract. Viewers still consume mediasoup producers, but OBS rooms need extra capability signaling because relay is disabled and simulcast is absent.
- Cloudflare tunnels remain viewer-facing only. They do not make OBS ingest possible and they do not provide a relay path for OBS rooms.

---

## Canonical Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Room creation | The browser host creates the room first via Socket.IO. OBS attaches to the existing room with `POST /whip/broadcast/:roomCode`. |
| 2 | Host identity | `room.hostSocketId` always refers to the browser host control socket, never to OBS. |
| 3 | WHIP identity | OBS uses additive room fields such as `room.whipSessionId` and `room.whipResourceId`. It is not registered as a normal socket host. |
| 4 | WHIP URL | V1 uses `http://localhost:<port>/whip/broadcast/:roomCode`. No bearer token is required in V1 because ingest is same-machine only. |
| 5 | SDP parsing | Use `sdp-transform`. |
| 6 | Teardown | Support both clean `DELETE` and crashy DTLS failure. |
| 7 | OBS reconnect | A new `POST` during the WHIP grace window replaces the old WHIP session in the same room. |
| 8 | Relay in OBS rooms | Disabled in V1. OBS rooms are direct-WebRTC-only for viewers. |
| 9 | Live preview | Skipped in V1. OBS already provides preview. |
| 10 | Browser mode | Existing browser-host capture path remains supported and unchanged in principle. |
| 11 | Codecs | AV1 is the primary OBS codec. H.264 (Baseline + Main + High) is accepted as fallback for hosts without AV1 hardware encoding. VP8 remains for browser mode. |
| 12 | Remote media control | Disable or hide remote media control in OBS rooms. |

---

## Room Model

The room object remains browser-host-centric, with OBS state added alongside it.

Existing browser-host fields that keep their current meaning:

- `hostSocketId`
- `hostToken`
- `hostTransport`
- `producer`
- `audioProducer`

New additive fields for OBS:

```js
room.ingestMode        // 'browser' | 'obs'
room.relaySupported    // true for browser mode, false for OBS mode
room.whipSessionId     // synthetic session identifier for OBS ingest
room.whipResourceId    // WHIP resource id for DELETE
room.whipTransport     // mediasoup WebRtcTransport used by OBS
room.whipGraceTimer    // timeout handle for DTLS-failure grace
room.whipHeartbeat     // interval handle that calls touchRoom()
room.whipConnected     // boolean: OBS currently connected and producing
room.whipReconnecting  // boolean: OBS session is in grace window after failure
```

Invariants:

1. `room.hostSocketId` is always the browser control socket.
2. `room.hostTransport` is only for browser-host capture mode.
3. `room.whipTransport` is only for OBS mode.
4. `room.producer` and `room.audioProducer` still represent the active room media producers, regardless of whether they came from browser mode or OBS mode.
5. `room.relaySupported` is authoritative server state, not a HostView-only flag.

`destroyRoom()` must close and clear all of the following if present:

- `room.hostTransport`
- `room.whipTransport`
- `room.producer`
- `room.audioProducer`
- `room.whipGraceTimer`
- `room.whipHeartbeat`

---

## Browser Host Ownership Rules

These rules close the biggest lifecycle ambiguity in OBS mode.

1. The browser host owns room creation and the viewer-facing room code.
2. OBS owns only the active ingest session.
3. If the browser host tab disconnects while OBS is still streaming, the room stays alive and the OBS stream continues.
4. If the browser host tab disconnects while OBS is not streaming, normal room teardown rules still apply.
5. If OBS stops cleanly and the browser host is still connected, the room remains alive in a "Waiting for OBS..." state.
6. If OBS stops and the browser host is gone, the room should be destroyed because there is no active stream and no control owner present.

This means OBS mode needs host reclaim that survives browser refresh, not just socket reconnect.

---

## Host Reclaim Requirements In OBS Mode

Current browser hosting stores `hostToken` only in memory. That is not enough for OBS mode.

For OBS rooms, the host UI must persist enough data locally to reclaim control after refresh or tab crash:

- `roomCode`
- `hostToken`
- `ingestMode`

`sessionStorage` is sufficient for V1.

Required behavior:

1. When the host creates an OBS room, persist the reclaim payload immediately.
2. On page load or socket reconnect, if persisted OBS-room reclaim data exists, attempt `reclaim-host`.
3. If reclaim succeeds, restore the OBS control UI state.
4. Clear the persisted reclaim payload when the room is truly destroyed or the host explicitly leaves the OBS room.

Without this, OBS can keep streaming while the host UI permanently loses control.

---

## WHIP HTTP Contract

### POST `/whip/broadcast/:roomCode`

Purpose:
- Start or replace the active OBS ingest session for a room.

Validation rules:

1. `WHIP_ENABLED` must be true.
2. Request must come from localhost in V1.
3. Room must exist.
4. Room must be an OBS room or a room waiting for OBS.
5. If a browser-host session is actively producing into the same room, reject with `409`.
6. SDP body must exist and fit within the parser limit.

Success behavior:

1. Parse SDP with `sdp-transform`.
2. Create a mediasoup `WebRtcTransport` using the existing transport factory.
3. Connect the transport with the DTLS parameters extracted from the SDP offer.
4. Produce video and audio into the room.
5. Store WHIP session state on the room.
6. Start the WHIP heartbeat interval.
7. Clear any previous WHIP grace timer.
8. Mark:
   - `room.ingestMode = 'obs'`
   - `room.relaySupported = false`
   - `room.whipConnected = true`
   - `room.whipReconnecting = false`
9. Emit:
   - `new-producer` to viewers
   - `host-reconnected` to viewers if this POST is replacing a failed OBS session during grace
   - `whip-producer-ready` to the browser host socket
10. Return `201 Created` with:
   - `Content-Type: application/sdp`
   - `Location: /whip/broadcast/:resourceId`
   - body = SDP answer

### DELETE `/whip/broadcast/:resourceId`

Purpose:
- End the active OBS ingest session cleanly.

Success behavior:

1. Find the active WHIP session by resource ID.
2. Close the WHIP transport and producers.
3. Clear WHIP heartbeat and grace timer.
4. Clear WHIP session fields from the room.
5. Mark:
   - `room.whipConnected = false`
   - `room.whipReconnecting = false`
   - `room.ingestMode = 'obs'` if the room remains waiting for OBS
6. Emit:
   - `host-disconnected` to viewers with `recoverable: false`
   - `whip-session-ended` to the browser host socket
7. Do not destroy the room if the browser host is still connected.
8. Destroy the room if the browser host is absent and there is no longer an active OBS session.

### OPTIONS

Provide `OPTIONS` support for the WHIP endpoints required by the chosen route layout.

### Response codes

- `201` success
- `400` malformed SDP or invalid request body
- `403` rejected by localhost-only ingest policy
- `404` room or WHIP resource not found
- `409` room already has an incompatible active ingest session
- `415` SDP parsed correctly but uses unsupported codec/profile configuration

---

## WHIP Transport Failure And Reconnect Rules

Clean stop and crash are different paths.

### Clean stop

If OBS sends `DELETE`, stop immediately. There is no grace period.

### Crash or DTLS failure

If `whipTransport` enters `dtlsstatechange` or ICE terminal failure:

1. Mark `room.whipConnected = false`
2. Mark `room.whipReconnecting = true`
3. Emit `host-disconnected` to viewers with `recoverable: true`
4. Emit `whip-reconnecting` to the browser host socket
5. Start a 30-second grace timer

If a new `POST` arrives during that timer:

1. Close and replace the old WHIP session
2. Clear the grace timer
3. Emit `whip-producer-ready` to the host UI
4. Emit `host-reconnected` and `new-producer` to viewers

If the timer expires:

1. End the WHIP session as if the stream has stopped unexpectedly
2. Emit `host-disconnected` to viewers with `recoverable: false`
3. Emit `whip-session-ended` to the browser host socket
4. Keep or destroy the room using the browser-host ownership rules above

---

## Viewer Behavior In OBS Rooms

Viewer logic is not identical to browser mode. It must adapt to room capabilities.

Required room capability signals:

- `ingestMode`
- `relaySupported`
- `hasProducer`
- `hasAudioProducer`

Required viewer behavior:

1. If `ingestMode === 'obs'`, disable relay fallback attempts entirely.
2. If direct WebRTC fails for an OBS room, show an explicit error such as:
   `This OBS stream requires direct WebRTC and cannot fall back to relay.`
3. If `ingestMode === 'obs'`, hide or disable layer-selection UI because there is no simulcast.
4. Continue using the normal mediasoup consumer path for active producers.

Viewer event contract:

- Reuse `host-disconnected`, `host-reconnected`, and `new-producer` for viewer-facing stream lifecycle.
- Do not invent a separate viewer-only WHIP event model in V1.

Host-control event contract remains separate and WHIP-specific.

---

## Host UI Behavior In OBS Mode

HostView in OBS mode is a control room, not a broadcaster.

Required behavior:

1. `create-room` still runs in the browser.
2. Browser capture is skipped entirely.
3. Show:
   - room code
   - WHIP URL
   - status: `Waiting for OBS...`, `OBS Connected`, `OBS Reconnecting...`, or `Stream Ended`
4. Listen for:
   - `whip-producer-ready`
   - `whip-reconnecting`
   - `whip-session-ended`
5. In OBS mode, `cleanup()` must not emit `host-stopped` just because the control UI is unmounting or refreshing.
6. Remote media control UI must be hidden or disabled in OBS rooms.

The host UI does not consume its own OBS stream in V1.

---

## Config, Codecs, And Transport Rules

### Config

Add:

- `WHIP_ENABLED=true`
- `WHIP_REQUIRE_LOCAL=true`

### HTTP body parser

Use:

```js
express.text({ type: 'application/sdp', limit: '16kb' })
```

Scope it to the WHIP routes only.

### Router codecs

AV1 is the primary OBS codec. H.264 is accepted as fallback.

Minimum router capability target:

- add AV1 codec entry (primary for OBS mode)
- existing H.264 baseline profile support remains
- add H.264 Main profile support
- add H.264 High profile support
- keep H.264 `packetization-mode=1`
- VP8 remains for browser-host mode

When OBS offers AV1, the router matches AV1. When OBS offers H.264 (older GPU or user choice), the router matches H.264. The pipeline is codec-agnostic — PlainTransport, FFmpeg remux, fMP4 muxer, and MSE all handle both identically.

### Transport factory

Reuse the existing `createWebRtcTransport()` factory for WHIP.

Do not create a separate bespoke WHIP transport path in V1 unless real OBS testing proves localhost candidate handling is broken. Start simple and only specialize if observed behavior requires it.

### Plain HTTP listener

V1 should provide a localhost-only plain HTTP listener for OBS WHIP ingest.

Requirements:

- bind to localhost only
- do not expose plain HTTP ingest on LAN
- keep the viewer-facing app behavior unchanged

---

## Shared Producer Cleanup

WHIP must not bolt on separate producer lifecycle logic that diverges from browser mode.

Extract shared producer cleanup/close handling so both browser-host and WHIP producers:

- clear `room.producer` / `room.audioProducer`
- emit viewer-facing producer state updates
- update room metrics
- avoid orphaned producer references

This is required to avoid leaks and mismatched room state.

---

## Metrics

Host metrics and room summaries must expose ingest-mode state directly.

Minimum added fields:

- `ingestMode`
- `relaySupported`
- `whipConnected`
- `whipReconnecting`

These must come from the server. The host UI should not infer OBS state indirectly from missing producers or side effects.

---

## Implementation Order

1. Update config, body parsing, and router codec support (AV1 primary + H.264 fallback).
2. Extend room state and room destruction to include WHIP fields and cleanup.
3. Extract shared producer lifecycle helpers.
4. Implement `lib/whip.js` for SDP parsing and answer generation.
5. Implement `lib/whipRoutes.js` for POST, DELETE, OPTIONS, and WHIP session lifecycle.
6. Mount localhost-only HTTP WHIP ingress in `server.js`.
7. Update Socket.IO room metrics and host reclaim behavior for OBS mode.
8. Update `HostView.jsx` for OBS-mode control flow and host-token persistence.
9. Update `WatchView.jsx` for `relaySupported`, `ingestMode`, and no-simulcast UI behavior.
10. Update user-facing OBS setup documentation.
11. Add automated tests and run a manual OBS checklist.

---

## Test Requirements

Automated tests should cover:

- malformed SDP rejection
- unsupported H.264 profile rejection
- room-not-found and conflict responses
- WHIP room field cleanup on DELETE
- `destroyRoom()` cleanup of WHIP timers and transport
- viewer capability flags for OBS rooms

Manual verification checklist:

1. Browser host creates OBS room and sees a valid localhost WHIP URL.
2. OBS connects and viewers receive the stream.
3. OBS stop sends DELETE and ends the stream without destroying the room if browser host is present.
4. OBS crash triggers reconnect grace and successful re-POST recovery.
5. Tunnel viewer gets an explicit "relay unavailable" style error for OBS rooms.
6. Browser refresh during active OBS stream can reclaim the room using persisted `hostToken`.
7. Browser close during active OBS stream does not kill the stream immediately.
8. Layer controls are hidden or disabled in OBS rooms.
9. Remote media control is hidden or disabled in OBS rooms.

---

## Relay Strategy For OBS Rooms

### The problem

In browser mode, the host's MediaRecorder generates WebM chunks that get relayed over Socket.IO to tunnel viewers. In OBS mode, media flows as RTP into mediasoup — no MediaRecorder runs, so there are no chunks to relay. Tunnel-only viewers (no UDP connectivity) get nothing.

### Chosen solution: server-side FFmpeg remux

```
OBS → mediasoup (RTP) → PlainTransport → FFmpeg → fMP4/CMAF → Socket.IO relay → tunnel viewers
```

1. mediasoup opens a `PlainTransport` that forwards raw RTP to a local UDP port.
2. FFmpeg listens on that port, receives the raw AV1/H.264 + Opus RTP.
3. FFmpeg **remuxes** (repackages, not re-encodes) into fMP4 chunks. This is nearly free CPU-wise.
4. Chunks feed into the existing relay path (`media-init` + `media-chunk` over Socket.IO).
5. Tunnel viewers use the same SourceBuffer/MSE playback they already have.

Why this is the best option:
- **No quality loss** — remuxing preserves the original OBS bitstream. No decode/re-encode cycle.
- **No browser throttling** — MediaRecorder is subject to Chrome's bitrate whims. FFmpeg passes through original quality.
- **Runs headless** — doesn't depend on the browser tab staying open or focused.
- **Adaptive bitrate later** — FFmpeg can produce multiple quality tiers (transcode to 720p for slow viewers) if needed in the future.
- **Reuses existing relay infrastructure** — tunnel viewers don't need any changes beyond what V1 already delivers.

Implementation details:
- Spawn FFmpeg as a child process when the first relay viewer joins an OBS room (lazy start, not on every OBS connect).
- Pipe FFmpeg stdout chunks into the relay forwarding path.
- Kill FFmpeg when the last relay viewer leaves or the WHIP session ends.
- FFmpeg must be available on PATH. Document this as a host requirement for OBS mode relay.

### Alternative options considered

**Option B: Host self-consumption + MediaRecorder**
The host browser consumes its own OBS producers (becomes a viewer of its own stream), then runs MediaRecorder on that consumed stream to generate relay chunks.
- Pro: reuses existing relay code, no FFmpeg dependency.
- Con: double encode (decode RTP in browser → re-encode via MediaRecorder) loses quality. Browser still throttles MediaRecorder bitrate. Depends on browser tab remaining open and focused.
- Verdict: **maybe as a fallback** if FFmpeg is not installed on the host machine.

**Option C: TURN server relay**
A TURN server relays WebRTC UDP traffic over TCP for tunnel viewers.
- Pro: full-quality WebRTC, no transcoding.
- Con: requires external TURN infrastructure the project doesn't have. Cloudflare tunnels proxy HTTP/WebSocket only, not arbitrary UDP/TCP relay.
- Verdict: **maybe for a hosted deployment** where TURN infrastructure exists, not for the self-hosted model.

**Option D: WebTransport / WebCodecs (Bleeding Edge)**
Raw RTP from mediasoup is parsed in Node to extract H.264 NAL units. These raw frames are sent over a WebSocket or WebTransport (HTTP/3) directly to viewers, bypassing WebM chunking entirely. Viewers decode the frames instantly using the HTML5 `VideoDecoder` API and paint to a `<canvas>`.
- Pro: True sub-100ms latency without UDP. Bypasses browser MSE buffering completely. Passes straight through Cloudflare Tunnels (WebSocket/HTTP3).
- Con: Requires significant frontend rewrite for a custom `<canvas>`-based video player and complex server-side NAL unit extraction.
- Verdict: **Highly viable for a "cutting-edge" rewrite** if minimizing latency over tunnels is the absolute highest priority.

**Option E: TURN-over-TLS (Port 443)**
Instead of relying on Cloudflare Tunnels for media, deploy a Coturn server configured to wrap WebRTC TURN traffic inside standard TLS (HTTPS) on port 443.
- Pro: Preserves the pure WebRTC pipeline (adaptive bitrate, congestion control, sub-second latency) while bypassing nearly all corporate firewalls and strict NATs. Zero custom UI code needed.
- Con: Requires configuring and managing Coturn certificates and an extra open port, complicating the "zero-config" self-hosted narrative.
- Verdict: **The industry standard for firewall bypass**, but shifts the complexity from code to infrastructure.

**Option F: Low-Latency HLS (LL-HLS)**
Similar to Option A, but FFmpeg outputs an LL-HLS manifest and lightweight segment stream over HTTP instead of WebM chunks over Socket.io.
- Pro: Infinite CDN scalability. Cloudflare caches it perfectly. Natively supported by Apple devices and readily playable via `hls.js`. Rock-solid stability on bad networks.
- Con: Adds 2-5 seconds of latency by design. Requires serving static files or an HTTP stream rather than WebSocket events.
- Verdict: **Best if the goal is broadcast scale and reliability**, rather than real-time interaction.

### Relay implementation order

This is a post-V1 addition. V1 ships without OBS relay. The relay work slots in after Step 6 (mount routes) and before Step 9 (WatchView updates):

1. Add `PlainTransport` creation in `lib/whipRoutes.js` alongside the existing WHIP transport.
2. Add FFmpeg child process management in a new `lib/ffmpegRelay.js`.
3. Pipe FFmpeg output into the existing `media-init` / `media-chunk` relay path in `lib/socket.js`.
4. Lazy-start FFmpeg on first relay viewer join, kill on last relay viewer leave.
5. Update `relaySupported` to `true` for OBS rooms when FFmpeg is available.
6. Update WatchView to allow relay fallback for OBS rooms when `relaySupported` is `true`.
7. If FFmpeg is not on PATH, fall back to Option B (self-consumption) or keep `relaySupported: false`.

---

## Codec Strategy

### AV1 (primary)

~50% better quality per bit than H.264. OBS supports hardware AV1 encoding on RTX 40+, RX 7000+, Intel Arc. mediasoup supports AV1. All modern browsers on Chrome, Edge, and Firefox decode it.

AV1 is the recommended and primary OBS codec. The host UI should default to AV1 and display a disclaimer: AV1 requires a recent GPU (NVIDIA RTX 4000+, AMD RX 7000+, Intel Arc) and viewers on Safari may not be able to watch.

### H.264 (accepted fallback)

H.264 Baseline + Main + High profiles are accepted for hosts whose GPUs lack hardware AV1 encoding. The pipeline handles H.264 identically to AV1 — only the MIME type string changes. No separate code path needed.

The host UI should show H.264 as a fallback option with a note that AV1 delivers significantly better quality at the same bitrate.

### VP8 (browser mode only)

VP8 remains in the router for browser-host mode. Unchanged.

### Not pursued

- **H.265/HEVC** — better than H.264 but browser WebRTC support is too spotty (Safari only, Chrome partial). Skip.
- **VP9** — limited GPU encode support in OBS, and Safari doesn't decode it. Not worth it for the OBS path.

---

## Tradeoffs Accepted In V1

1. No simulcast: OBS rooms provide one stream quality only.
2. No relay in V1: tunnel viewers cannot watch OBS rooms until the FFmpeg relay is implemented (post-V1).
3. OBS required: host setup is more powerful but less zero-config than browser mode.
4. Localhost-only ingest: simplest secure setup wins over broader ingest flexibility in V1.
5. FFmpeg required for OBS relay (post-V1): adds a host dependency but avoids quality loss from double encoding.

---

*Spec by Codex, relay strategy and codec notes by Claude*

---

## Codex Addendum: Best Remote Viewer Path For OBS

If OBS rooms must support remote or tunnel-only viewers, the best overall architecture is still server-side fallback generation. The part I would tighten is the output format and the boundary between "fastest to ship" and "best long-term base."

### Recommended direction

Keep OBS -> WHIP -> mediasoup as the ingest path. Add a server-side egress path from the active OBS producers through a `PlainTransport` into a dedicated local media worker such as FFmpeg or GStreamer. That worker should generate the remote-viewer fallback stream independently of the browser host tab.

Canonical target:

- prefer fragmented MP4 / CMAF for the fallback path
- keep H.264 video as copy-through when possible
- transcode audio only if the fallback container/player requires AAC
- let `WatchView` try direct WebRTC first and switch to the fallback only for viewers who cannot sustain the normal mediasoup path

Why I prefer this over the browser-style relay path:

- it keeps OBS as the real source of truth instead of making the browser re-consume its own stream
- it removes browser throttling and tab-liveness as fallback dependencies
- it gives a cleaner long-term format for H.264-origin streams than trying to preserve the browser's WebM relay shape forever
- it leaves room for later packaging into ABR tiers without redesigning the ingest side

### Transitional shortcut if speed matters more than cleanliness

If the immediate goal is "make remote viewers work with minimum new UI and playback code," the server-side FFmpeg relay described above can still be used as an intermediate implementation. In that version:

- mediasoup egresses RTP through `PlainTransport`
- FFmpeg produces chunks for the existing relay path
- OBS rooms advertise `relaySupported: true` only when that worker is healthy
- viewers reuse the current relay fallback behavior

I would treat that as a shipping shortcut, not the final media architecture. If the project has time and machine budget, build the fallback pipeline so the server owns it cleanly rather than stretching the browser-era relay format further than necessary.

### Rules I would lock before implementation

- direct WebRTC remains the preferred path; fallback is capability-driven, not the default
- fallback lifecycle is tied to the OBS session, not to the browser tab
- room metrics must expose fallback health and whether fallback is currently available
- OBS rooms must never silently fall into a relay path that hides transport failure; the UI should show whether the viewer is on direct WebRTC or fallback
- fallback startup and teardown must be reference-counted by actual remote-viewer demand

### What I would not choose

- browser self-consumption plus `MediaRecorder` as the primary OBS relay path
- "just use TURN" as the answer for self-hosted tunnel viewers
- pure direct-WebRTC-only OBS rooms if remote viewing is a product requirement

*Codex addendum: if remote OBS viewers matter, use server-side fallback generation as the durable answer; treat WebM relay reuse as the shortcut, not the destination.*
