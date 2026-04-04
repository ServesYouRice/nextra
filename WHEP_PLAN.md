# WHEP / Streaming Roadmap

## Goal

Document the path from the current two shipped streaming lanes to the next two milestones:

- Tier 1: browser-hosted WebRTC
- Tier 2: OBS + WHIP ingest + FFmpeg-backed H.264 compatibility relay
- Tier 2.5: direct WebRTC for the current OBS lane over normal ICE/STUN
- Tier 3: AV1 + WHEP + STUN / BYOK TURN

WHEP is not the next thing to ship. The next thing to ship is STUN-first hardening for the current OBS lane so Tier 3 is built on a proven direct-consume path.

WHEP must work with both current ingest modes:

- Browser-host rooms: `room.producer` / `room.audioProducer`
- OBS-host rooms: `room.whipProducer` / `room.whipAudioProducer`

WHEP is additive. It must not replace:

- `src/WatchView.jsx`
- the existing Socket.IO mediasoup viewer path
- the OBS fallback relay path

---

## Current Reality In This Repo

### Ingest sources are split

The room model already has two separate producer families:

- browser ingest: `producer`, `audioProducer`
- OBS ingest: `whipProducer`, `whipAudioProducer`

Any WHEP route must resolve the active source explicitly from `room.ingestMode`.

The same is true for the existing Socket.IO viewer path if Tier 2.5 is supposed to work for OBS rooms over STUN.

### Viewer state is Socket.IO-centric today

The current direct viewer path is built around:

- `room.viewers`
- `room.viewerTransports`
- `socketToRoom`
- metrics emitted from `lib/socket.js`

WHEP viewers are not Socket.IO clients, so they cannot be jammed into the same identity model.

### mediasoup consume currently expects RTP capabilities

The Socket.IO path gets `rtpCapabilities` directly from the browser and then calls:

```js
router.canConsume({ producerId, rtpCapabilities })
```

For WHEP, the server must derive equivalent receive capabilities from the incoming SDP offer before it can create consumers safely.

### STUN plumbing already exists, but OBS direct consume is not wired through it

`config.getIceServers()` already returns public STUN servers plus optional TURN credentials when configured.

The missing work for Tier 2.5 is not "invent STUN" so much as:

- make OBS rooms use the existing mediasoup viewer path
- stop resolving producers through browser-only room fields
- change the viewer fallback policy so OBS is not relay-only by default
- add enough ICE metrics to prove whether direct playback is actually succeeding

### OBS direct playback is currently blocked by product policy and producer lookup

Today the current viewer lane is still browser-source-centric:

- `lib/socket.js` `get-producers` exposes `room.producer` / `room.audioProducer`
- `lib/socket.js` `consume` only accepts those same producer ids
- `src/WatchView.jsx` auto-enters relay mode for OBS rooms

That means Tier 2.5 must land before Tier 3 WHEP work becomes the right next bet.

---

## Tier Map

| Tier | Ingest | Viewer egress | Codec focus | Connectivity model | Status |
|---|---|---|---|---|---|
| 1 | Browser capture | existing Socket.IO mediasoup viewer path | VP8 / current browser codec set | existing ICE path | current |
| 2 | OBS via WHIP | FFmpeg-backed relay / fallback lane | H.264 | works today; direct OBS viewer flow is incomplete | current |
| 2.5 | OBS via WHIP | existing Socket.IO mediasoup viewer path, now OBS-aware | H.264 | STUN-first, direct WebRTC where UDP works | next |
| 3 | Browser or OBS source, standards-based egress | WHEP plus existing Socket.IO path as compatibility lane | AV1 primary, H.264 fallback | STUN plus productized BYOK TURN | later |

---

## Why STUN Before WHEP

- WHEP standardizes the viewer signaling surface, but it does not solve NAT traversal by itself.
- The current OBS lane still needs active-producer resolution and direct-consume plumbing in the existing Socket.IO viewer flow.
- Shipping STUN-first on the current H.264 lane isolates one variable at a time: connectivity first, then protocol and codec changes.
- It gives us ICE success/failure data before adding AV1 decode constraints and a second viewer API.
- It turns the existing TURN env support into a real BYOK TURN story later instead of an undocumented escape hatch.

---

## Tier 2.5: STUN Hardening For The Current OBS Lane

### Scope

Ship the smallest useful OBS direct-playback slice before WHEP:

- keep OBS ingest on the current WHIP endpoint
- keep the current H.264-focused OBS lane
- keep the FFmpeg relay as the compatibility fallback
- make OBS rooms consumable through the existing Socket.IO mediasoup viewer path
- use `config.getIceServers()` as the direct playback ICE source
- keep relay-first behavior only for tunnel origins with no TURN

### Core implementation changes

#### 1. Add a shared active-producer resolver

Create one helper and reuse it everywhere direct viewers need media source lookup:

```js
function getActiveRoomProducers(room) {
  if (room.ingestMode === 'obs') {
    return {
      videoProducer: room.whipProducer,
      audioProducer: room.whipAudioProducer,
    };
  }

  return {
    videoProducer: room.producer,
    audioProducer: room.audioProducer,
  };
}
```

Tier 2.5 must use this in the existing Socket.IO viewer path before Tier 3 WHEP uses it in HTTP routes.

#### 2. Make the current Socket.IO viewer flow OBS-aware

Update `lib/socket.js` so these operations resolve active producers instead of browser-only producers:

- `join-room` should report `hasProducer` / `hasAudioProducer` from the active source
- `get-producers` should return the active source ids
- `consume` should validate against the active source ids
- any room metrics emitted to the host should distinguish:
  - direct WebRTC viewers
  - relay viewers
  - future WHEP viewers

This is the real Tier 2.5 transport bridge.

#### 3. Change viewer policy in `src/WatchView.jsx`

Current behavior makes OBS effectively relay-first because the view auto-enters fallback mode.

Tier 2.5 should change that to:

- direct WebRTC first for local/LAN/public UDP-capable viewers
- relay first only when `isTunnelOrigin && !hasTurnServer`
- keep the manual `Switch to Relay Mode` / `Try WebRTC` controls
- surface a clearer error when ICE fails and the viewer is not on a relay-capable path

#### 4. Add ICE and fallback diagnostics

Before Tier 3, we need to know whether STUN is actually working in the field.

Track at least:

- direct OBS watch attempts
- direct OBS watch successes
- direct OBS ICE failures / timeouts
- relay fallback activations after a failed direct attempt
- whether a TURN server was configured for the attempt

This can start as server-side counters plus minimal host metrics.

#### 5. Keep the codec blast radius small

Tier 2.5 should stay on the current OBS H.264 lane.

Do not mix this milestone with:

- AV1 router changes
- AV1 host UI defaults
- WHEP answer generation
- TURN productization / credential UX

### Tier 2.5 files to change

| File | Action | Reason |
|---|---|---|
| `lib/rooms.js` | Modify | add shared active-producer helper and expose active-source state cleanly |
| `lib/socket.js` | Modify | current direct viewer flow must consume active OBS producers |
| `src/WatchView.jsx` | Modify | remove unconditional OBS relay-first behavior |
| `README.md` | Modify | document that OBS direct WebRTC is now STUN-first, relay second |
| `tests/*` | Modify | cover OBS direct consume and fallback policy |

### Tier 2.5 exit criteria

Do not start Tier 3 until all of these are true:

- an OBS room can be watched over direct WebRTC without relay on a normal UDP-capable network
- tunnel viewers still land on relay when no TURN is configured
- browser-host rooms behave exactly as before
- host metrics can distinguish direct-vs-relay outcomes for OBS viewers
- the active-producer helper is already shared by the Socket.IO viewer path

### Tier 2.5 non-goals

- no WHEP routes yet
- no AV1 requirement yet
- no mandatory TURN deployment yet
- no attempt to replace the Socket.IO viewer path

---

## Tier 3 Gate

Tier 3 starts only after Tier 2.5 proves that the current OBS lane can already do direct WebRTC over ICE/STUN.

Tier 3 will then add:

- standards-based WHEP egress
- AV1 as the primary codec direction
- a productized BYOK TURN story on top of the existing `TURN_URL`, `TURN_SECRET`, `TURN_USERNAME`, and `TURN_CREDENTIAL` plumbing

The rest of this document describes Tier 3, not the immediate next milestone.

---

## Tier 3 Product Slice

### Phase 1

Ship the smallest useful version first:

- `POST /whep/watch/:roomCode`
- `DELETE /whep/watch/:sessionId`
- HTTPS only on the main app
- full ICE only
- `PATCH` returns `405 Method Not Allowed`
- no viewer auth yet
- host metrics expose `whepViewerCount` separately from Socket.IO viewer count

This phase is enough for:

- browser test clients
- standards-based receivers that send a full SDP offer up front

---

## Route Contract

### `POST /whep/watch/:roomCode`

Request:

- `Content-Type: application/sdp`
- body: viewer SDP offer

Response:

- `201 Created`
- `Content-Type: application/sdp`
- `Location: /whep/watch/:sessionId`
- body: WHEP SDP answer

### `DELETE /whep/watch/:sessionId`

Response:

- `200 OK` when the session existed and was closed
- `404` if the session does not exist

### `PATCH /whep/watch/:sessionId`

Phase 1 behavior:

- return `405 Method Not Allowed`

---

## Data Model Changes

Extend the room shape in `lib/rooms.js` with WHEP-specific state:

```js
whepSessions: new Map(), // sessionId -> session object
whepViewerCount: 0,
```

Session object shape:

```js
{
  id,
  roomCode,
  transport,
  consumers,       // array of mediasoup consumers
  createdAt,
  closed: false,
}
```

Important:

- Do not store WHEP sessions in `room.viewerTransports`
- Do not add synthetic WHEP ids into `room.viewers`
- Do not reuse `socketToRoom` for WHEP

Instead:

- keep WHEP session tracking separate
- expose explicit metrics for `whepViewerCount`
- optionally compute `totalViewerCount` in room stats later

---

## Core Helpers

### 1. Resolve active producers

Add a shared helper, either in `lib/rooms.js` or `lib/whepRoutes.js`:

```js
function getActiveRoomProducers(room) {
  if (room.ingestMode === 'obs') {
    return {
      videoProducer: room.whipProducer,
      audioProducer: room.whipAudioProducer,
    };
  }

  return {
    videoProducer: room.producer,
    audioProducer: room.audioProducer,
  };
}
```

This is mandatory. WHEP cannot rely on a fake generic `room.producer`.

Tier 2.5 should introduce this helper first in the Socket.IO viewer path so Tier 3 can reuse it instead of inventing a parallel lookup rule.

### 2. Convert SDP offer to receive capabilities

Create a helper that derives mediasoup-style receive capabilities from the SDP offer:

```js
function offerToRtpCapabilities(parsedOffer) {
  // Build { codecs, headerExtensions } from the offered m= sections.
}
```

This is the missing bridge between raw SDP and:

```js
router.canConsume({ producerId, rtpCapabilities })
```

Without this, the route cannot safely decide whether the viewer can receive AV1 vs H.264.

### 3. Build consumer-side SDP answers

Do not reuse the existing WHIP answer helper directly.

The current `createAnswer()` in `lib/whip.js` is ingest-oriented and wrong for WHEP because it:

- mirrors offer-selected codecs instead of consumer-selected codecs
- emits producer-style media direction assumptions
- does not build from consumer RTP parameters

Create a dedicated consumer-side answer builder, preferably in a new file:

- `lib/whep.js`

Suggested API:

```js
function createViewerAnswer(parsedOffer, consumers, transportParams) {
  // Build one m= section per created consumer.
}
```

The answer builder must use:

- transport ICE params from mediasoup transport
- transport DTLS fingerprint
- consumer codec info from `consumer.rtpParameters.codecs`
- consumer SSRC from `consumer.rtpParameters.encodings`
- `a=sendonly` for media sections
- offer mids when present

It should also preserve:

- `a=rtcp-mux`
- `a=rtcp-rsize`
- codec `fmtp`
- codec `rtcp-fb`

---

## Implementation Steps

### Step 1: Create `lib/whep.js`

Responsibilities:

- translate parsed SDP offer into mediasoup receive capabilities
- build consumer-side SDP answers

Keep reusing from `lib/whip.js` only where it actually fits:

- `parseOffer`
- `parseDtlsParameters`

Do not reuse codec selection logic from WHIP ingest.

### Step 2: Create `lib/whepRoutes.js`

This router owns:

- session creation
- session deletion
- session cleanup on transport failure

Suggested route flow:

```text
POST /whep/watch/:roomCode
1. Check config.WHEP_ENABLED
2. Find room
3. Resolve active room producers from ingestMode
4. Require an active video producer
5. Parse SDP offer
6. Derive receive capabilities from offer
7. Create mediasoup WebRtcTransport
8. Connect transport with offer DTLS params
9. For each active producer:
   - check router.canConsume(...)
   - create consumer paused:true
10. Build SDP answer from created consumers
11. Store session in room.whepSessions
12. Set room.whepViewerCount
13. Resume created consumers
14. Return 201 + answer + Location
```

DELETE flow:

```text
DELETE /whep/watch/:sessionId
1. Find session
2. Close all consumers
3. Close transport
4. Remove from room.whepSessions
5. Recompute room.whepViewerCount
6. Return 200
```

### Step 3: Add cleanup helpers

Add a local helper in `lib/whepRoutes.js`:

```js
function closeWhepSession(room, sessionId) {
  // idempotent cleanup
}
```

Use it from:

- `DELETE`
- transport state failure handlers
- room destruction

### Step 4: Extend `lib/rooms.js`

Update:

- `createRoom()`
- `destroyRoom()`
- `getRoomStats()`

`destroyRoom()` must explicitly close all WHEP sessions:

```js
for (const [, session] of room.whepSessions) {
  session.consumers.forEach(...)
  session.transport.close()
}
```

`getRoomStats()` should expose:

- `whepViewerCount`
- optional `totalViewerCount`

Do not overwrite the meaning of existing Socket.IO viewer fields silently.

### Step 5: Surface metrics cleanly

Current host metrics are driven through `lib/socket.js`, so this file cannot stay entirely untouched if the host UI should see WHEP sessions.

Minimal change:

- include `whepViewerCount` in the emitted room metrics payload

Optional:

- include `totalViewerCount = room.viewers.size + room.whepViewerCount`

### Step 6: Mount routes in `server.js`

Phase 1 recommendation:

- mount on the main HTTPS app only

```js
if (config.WHEP_ENABLED) {
  const whepRouter = createWhepRouter(result.router);
  app.use('/whep', whepRouter);
}
```

Do not automatically mirror WHEP onto the WHIP HTTP companion server in the first slice unless there is a real client need. Unlike OBS WHIP ingest, browser WHEP viewers do not need the HTTP workaround.

### Step 7: Config

Add to `config.js`:

```js
WHEP_ENABLED: parseBoolEnv(process.env.WHEP_ENABLED, true),
```

Optional later:

- `WHEP_ALLOW_HTTP`
- viewer auth flags

---

## Error Handling

Use explicit status codes:

- `404` room not found
- `409` room exists but no active video producer
- `415` unsupported viewer offer / no compatible codecs
- `400` malformed SDP or missing DTLS fingerprint
- `405` PATCH not implemented
- `500` internal server error

If audio cannot be consumed, still allow a video-only WHEP session.

If video cannot be consumed, fail the request.

---

## ICE / Transport Lifecycle

Phase 1:

- rely on full ICE in the initial SDP exchange
- attach transport state handlers
- clean up sessions on `failed` or `closed`

Phase 2:

- implement `PATCH` for trickle ICE
- add grace handling if needed

---

## Tier 3 Files To Change

| File | Action | Reason |
|---|---|---|
| `lib/whep.js` | Create | Offer-to-capabilities conversion and viewer SDP answer builder |
| `lib/whepRoutes.js` | Create | WHEP session lifecycle |
| `lib/rooms.js` | Modify | room state, cleanup, stats |
| `lib/socket.js` | Modify | host metrics payload must include WHEP stats |
| `server.js` | Modify | mount WHEP router |
| `config.js` | Modify | `WHEP_ENABLED` |
| `README.md` | Modify | document WHEP endpoint and limits |

Files intentionally unchanged in Phase 1:

- `src/WatchView.jsx`
- `src/HostView.jsx`
- OBS fallback worker logic

---

## Tier 3 Test Plan

### Unit tests

Add tests for:

- `offerToRtpCapabilities()` with AV1 + H.264 offers
- `createViewerAnswer()` for:
  - video-only rooms
  - video + audio rooms
  - H.264 rooms
  - AV1 rooms

### Integration tests

Add route tests for:

- room not found
- room exists but has no active producer
- browser-ingest room produces a WHEP answer
- OBS-ingest room produces a WHEP answer
- DELETE closes the stored session

### Browser smoke test

If `PATCH` is not implemented yet, wait for full ICE gathering before POST:

```js
const pc = new RTCPeerConnection();
pc.addTransceiver('video', { direction: 'recvonly' });
pc.addTransceiver('audio', { direction: 'recvonly' });

await pc.setLocalDescription(await pc.createOffer());
await new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') resolve();
  });
});

const res = await fetch('/whep/watch/ROOMCODE', {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
});

const answer = await res.text();
await pc.setRemoteDescription({ type: 'answer', sdp: answer });
```

---

## Tier 3 Non-Goals For Phase 1

- replacing Socket.IO viewers
- auto-switching `WatchView` to WHEP
- per-viewer transcoding
- viewer auth
- `PATCH` trickle ICE
- WHEP-specific UI work

---

## Recommended First Tier 3 Commit

Make the first implementation slice as small as possible:

1. `lib/whep.js`
2. `lib/whepRoutes.js`
3. `config.js`
4. `server.js`
5. `lib/rooms.js`
6. route/unit tests

Do not pull host UI changes into the first WHEP commit unless they are only metrics fields already needed for debugging.

---

## Antigravity's Review

### Overall Assessment

This is a strong, well-structured plan. The tiered approach (2.5 before 3) is the right call — it isolates variables and builds on proven plumbing instead of introducing WHEP and AV1 simultaneously. The plan clearly understands the codebase's current architecture and avoids the common trap of over-abstracting too early.

That said, after reviewing every file referenced in the plan against the actual code, there are significant findings to flag.

---

### 🔴 Critical Issues

#### 1. `get-producers` and `consume` are browser-only — the plan underestimates the blast radius

The plan correctly identifies this problem but the actual code is worse than described. In `lib/socket.js` the `get-producers` handler:

```js
const producers = [];
if (room.producer) {
    producers.push({ producerId: room.producer.id, kind: 'video' });
}
if (room.audioProducer) {
    producers.push({ producerId: room.audioProducer.id, kind: 'audio' });
}
```

And the `consume` handler validates against browser-only producer IDs:

```js
const roomProducerIds = new Set(
    [room.producer?.id, room.audioProducer?.id].filter(Boolean)
);
if (!roomProducerIds.has(producerId)) {
    // DENIED — OBS producers will never pass this check
}
```

This means `get-producers` returns an empty array for OBS rooms, and `consume` rejects OBS producer IDs. These are two separate bugs that both need the `getActiveRoomProducers()` helper. The plan mentions this but doesn't highlight that the `consume` validation is also broken — it isn't just `get-producers`.

> Tier 2.5 cannot ship if only `get-producers` is fixed. The `consume` handler's `roomProducerIds` set must also resolve from the active source. These are two separate code paths and both must be updated atomically.

#### 2. `join-room` reports wrong `hasProducer` for OBS rooms

In `lib/socket.js` the `join-room` callback:

```js
safeCallback(callback, {
    success: true,
    hasProducer: !!room.producer,          // always false for OBS rooms
    hasAudioProducer: !!room.audioProducer, // always false for OBS rooms
    ...
});
```

The viewer's `handleJoin` uses `response.hasProducer` to set state. For OBS rooms, this is always `false`, which is why the viewer never attempts WebRTC. The plan mentions this in Tier 2.5 step 2 but doesn't call it out as a P0 bug.

#### 3. `getRoomStats()` reports wrong producer state for OBS rooms

In `lib/rooms.js`:

```js
hasProducer: !!room.producer,
hasAudioProducer: !!room.audioProducer,
```

This feeds host metrics. For OBS rooms, the host dashboard always shows "no producer" even when WHIP is connected. This is a third consumer of the same pattern that needs `getActiveRoomProducers()`.

---

### 🟡 Significant Concerns

#### 4. The auto-enter-fallback code in WatchView blocks Tier 2.5

In `src/WatchView.jsx`:

```js
useEffect(() => {
    if (joined && ingestMode === 'obs' && !fallbackMode && !fmp4PlayerRef.current) {
        enterFallbackMode();
    }
}, [joined, ingestMode, fallbackMode, enterFallbackMode]);
```

This unconditionally forces fallback for every OBS viewer, regardless of network capability. The plan identifies this ("Current behavior makes OBS effectively relay-first") but doesn't flag the interaction: even if you fix the server to serve OBS producers via `get-producers`, the client will never ask because it auto-enters fallback before attempting WebRTC.

Tier 2.5 should change this to:

```js
if (joined && ingestMode === 'obs' && !fallbackMode && !fmp4PlayerRef.current) {
    if (preferRelayFirst) {
        enterFallbackMode();
    }
    // Otherwise: let the user click "Watch" which attempts WebRTC first
}
```

#### 5. `destroyRoom()` doesn't clean up WHEP sessions (future Tier 3 gap)

The plan notes that `destroyRoom()` must close WHEP sessions, but the current `destroyRoom` already doesn't iterate `room.viewerTransports` properly for cleanup — it only closes consumers and recvTransport. When WHEP lands, there will be three separate cleanup paths:

1. Socket.IO viewer transports
2. WHIP producer transport
3. WHEP session transports

Consider a `closeAllWhepSessions(room)` helper that `destroyRoom()` calls, and make the pattern match the existing WHIP cleanup pattern (`closeWhipSession`). The helper should live in `lib/whepRoutes.js` alongside the route lifecycle, not in `rooms.js`.

#### 6. The plan's Tier 3 POST flow has a subtle DTLS ordering note

The route flow shows:

```
8. Connect transport with offer DTLS params
9. For each active producer: create consumer paused:true
10. Build SDP answer from created consumers
```

`transport.connect()` in mediasoup provides the remote DTLS fingerprints so mediasoup knows what to expect, but the actual DTLS handshake happens asynchronously when ICE completes. Step 8 works as a "configure" step, not a "wait for connection" step. This is fine because mediasoup's `connect()` is non-blocking for WebRtcTransport, but it's worth documenting this assumption explicitly since the WHIP route uses a deferred `dtlsstatechange` pattern instead.

#### 7. Session leak risk: no idle timeout for WHEP sessions

The plan has DELETE for explicit cleanup and transport failure handlers, but no idle timeout. If a viewer's browser crashes (tab kill, OS crash), no DELETE is sent and transport ICE may not fail for 30+ seconds or longer with TURN. The session holds consumers and a transport.

Add a `WHEP_SESSION_IDLE_TIMEOUT_MS` (e.g. 120s) and check for inactive transports during the room cleanup sweep. This is a Phase 2 concern but worth noting in the plan.

#### 8. Missing AV1 in `MEDIA_CODECS`

The plan describes Tier 3 as "AV1 primary, H.264 fallback" but the current `config.js` `MEDIA_CODECS` array only has VP8, H.264 (three profiles), and Opus. AV1 is not in the router's codecs.

For Tier 3 to work with AV1 ingest or egress, `video/AV1` must be added to `MEDIA_CODECS`. This is intentionally deferred ("Do not mix this milestone with AV1 router changes"), but the plan should explicitly note that Tier 3 requires a config change and that adding AV1 to the router may affect all existing sessions (the router's codec matching becomes broader).

---

### 🟢 Suggestions & Improvements

#### 9. `getActiveRoomProducers()` should be in `rooms.js`, not optional

The plan says "either in `lib/rooms.js` or `lib/whepRoutes.js`". Put it in `rooms.js`. It's used by:

- `get-producers` (socket.js)
- `consume` (socket.js)
- `join-room` (socket.js)
- `getRoomStats()` (rooms.js)
- WHEP route (whepRoutes.js)

All roads lead to `rooms.js`. Making it a helper there also means it's co-located with `ingestMode` and the producer fields it reads.

#### 10. The `offerToRtpCapabilities()` helper is the hardest piece — scope it carefully

The plan describes this as a "bridge between raw SDP and `router.canConsume()`" but the implementation is non-trivial. mediasoup's `rtpCapabilities` shape has specific rules around `preferredPayloadType`, header extensions, and RTCP feedback intersection.

For Phase 1, consider using a simpler approach: derive capabilities from the router's capabilities filtered by what the viewer's SDP says it supports. This avoids building the full capabilities from scratch and is what mediasoup-client does internally.

#### 11. Rate-limit WHEP POST

WHIP uses Bearer token auth. WHEP has no auth in Phase 1. A malicious actor could hammer `POST /whep/watch/:roomCode` to exhaust mediasoup transports or create hundreds of phantom sessions.

At minimum, apply `MAX_VIEWERS_PER_ROOM` to `whepViewerCount + viewers.size` and add a basic per-IP rate limit like `join-room` has.

#### 12. CORS on WHEP routes

The plan doesn't mention CORS for WHEP. Unlike WHIP (where OBS doesn't need CORS), WHEP viewers will likely be browser-based. The route needs `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: Location` just like the WHIP routes have. Consider reusing the `setCorsHeaders` pattern from `lib/whipRoutes.js`.

#### 13. Consider `ETag` / `If-Match` for future PATCH

The WHEP spec requires `ETag` headers on the 201 response and `If-Match` on PATCH for trickle ICE. Even though PATCH returns 405 in Phase 1, returning an `ETag` now is cheap and prevents a breaking change later when PATCH is implemented.

#### 14. The `WHEP_ENABLED` default should be `false`, not `true`

For a new feature that's Phase 1, defaulting to enabled is risky. Users who upgrade will suddenly have a new unauthenticated endpoint exposed. Default to `false` and let users opt in. This matches good rollout practice.

#### 15. Body parser limit for WHEP SDP

The WHIP route uses `express.raw({ type: 'application/sdp', limit: '10kb' })`. Viewer SDP offers can be larger than WHIP offers because they may include many codec candidates and ICE candidates (especially for full ICE). Consider `limit: '64kb'` for WHEP.

---

### Edge Cases To Handle

| Edge Case | Risk | Recommendation |
|---|---|---|
| Viewer sends offer with no `recvonly` transceiver | Server creates 0 consumers | Return 400 with clear error |
| OBS reconnects mid-WHEP session | Producers change, WHEP consumers are orphaned | Fire `producerclose` on WHEP consumers; let viewer re-POST |
| Room destroyed while WHEP viewer is connecting | Transport connect races with cleanup | Check `room.whepSessions` before completing connection |
| Viewer sends offer with only audio, no video | Plan says "fail if no video" | Good — but make the 409 message clear |
| Simultaneous WHEP POSTs for same room | Multiple sessions from same viewer IP | Not harmful but count them in `MAX_VIEWERS_PER_ROOM` |
| WHEP viewer with only H.264 support tries to watch AV1 room | `canConsume` returns false | Return 415 with codec mismatch explanation |
| Host switches from browser to OBS ingest mid-room | `ingestMode` changes, active producers change | WHEP sessions created before the switch will have dead consumers |
| SDP offer has bundled mids but consumer only needs one | Answer must respect BUNDLE group | Ensure answer's BUNDLE group matches which mids have consumers |

---

### Opinions

#### The tier structure is exactly right

Shipping STUN-hardened OBS direct playback (Tier 2.5) before WHEP (Tier 3) is the correct engineering call. WHEP on top of unproven ICE plumbing would be debugging two things at once. The exit criteria for Tier 2.5 are concrete and testable.

#### The "do not reuse WHIP answer builder" advice is critical

The plan correctly identifies that `createAnswer()` in `lib/whip.js` is ingest-oriented. The SDP direction semantics (`sendrecv` for WHIP vs `sendonly` for WHEP), codec source (offer-selected vs consumer-selected), and SSRC handling are all different. A shared module would be a footgun.

#### `PATCH` 405 in Phase 1 is the right call

Full ICE with completed gathering before POST is simpler and avoids the most complex part of the WHEP spec (trickle ICE state machine). The browser smoke test correctly shows the `icegatheringstatechange` wait pattern.

#### Keeping Socket.IO viewers alongside WHEP is wise

The plan is explicit about not replacing the Socket.IO viewer path. This is correct — Socket.IO viewers have features (layer preference, relay mode switching, host metrics) that WHEP viewers won't have in Phase 1.

---

### Summary Of Recommended Changes To The Plan

1. **Tier 2.5:** Explicitly list all three code paths that need `getActiveRoomProducers()`: `get-producers`, `consume`, and `join-room`
2. **Tier 2.5:** Fix `getRoomStats()` to use the same helper
3. **Tier 2.5:** Call out the `WatchView.jsx` auto-fallback as a blocking issue, not just a "change viewer policy"
4. **Tier 3:** Add CORS handling to WHEP route requirements
5. **Tier 3:** Add rate-limiting / `MAX_VIEWERS_PER_ROOM` enforcement for WHEP
6. **Tier 3:** Default `WHEP_ENABLED` to `false`
7. **Tier 3:** Add session idle timeout discussion
8. **Tier 3:** Note that `MEDIA_CODECS` must include AV1 for Tier 3 to work
9. **Tier 3:** Consider returning `ETag` in Phase 1 for forward compatibility
10. **Tier 3:** Set SDP body parser limit to 64kb for viewer offers

Signed,
**Antigravity** 🪐

---

## Opus's Review

### Overall

Antigravity caught the big structural bugs. This review focuses on what both the plan and the first review missed or understated — things that will bite during implementation, not things that are wrong on paper.

---

### 🔴 Critical Issues

#### 1. WHIP producers are created asynchronously inside `dtlsstatechange` — WHEP and Tier 2.5 have a race window

The plan treats OBS producers as available once `whipConnected` is true. But look at `lib/whipRoutes.js:175-206`: producers are created *inside* the `dtlsstatechange` callback, *after* the 201 response has already been sent to OBS. There is a real window where:

- `room.whipSessionId` is set
- `room.whipConnected` is still `false`
- `room.whipProducer` is still `null`

If a viewer joins during this window (which is common — host creates room, copies link, viewer clicks immediately), `getActiveRoomProducers()` will return `{ videoProducer: null, audioProducer: null }` even though OBS has connected. The `join-room` response will say `hasProducer: false` and the viewer will see "waiting for host."

Neither the plan nor Antigravity's review addresses this timing. The `getActiveRoomProducers()` helper is necessary but not sufficient — there also needs to be a `whip-producer-ready` event emitted to already-joined viewers once producers materialize inside the DTLS callback. Without this, early-joining viewers in OBS rooms are stuck until they manually refresh.

This is the same pattern browser ingest already handles: `new-producer` is emitted when the host starts producing. For WHIP, no such event exists. The `dtlsstatechange` handler sets `room.whipConnected = true` but never notifies the Socket.IO room.

**Fix:** After `room.whipConnected = true` in the DTLS callback, emit `new-producer` to the room for each created WHIP producer, using the same shape the client already handles. This unblocks waiting viewers without any client changes.

#### 2. `new-producer` handler on the client ignores producers when not in mediasoup playback mode

Even if fix #1 above emits `new-producer` for WHIP producers, look at `WatchView.jsx:646`:

```js
if (!watching || playbackMode !== 'mediasoup') return;
```

For OBS rooms, the auto-fallback effect (line 788) fires *before* any `new-producer` arrives. The viewer is already in fallback mode. The `new-producer` event is silently dropped. This means:

- Tier 2.5's "direct WebRTC first" policy change isn't just about removing the auto-fallback `useEffect`
- It also requires that the viewer be in a state where it *can* act on `new-producer` when it arrives late (which it always will for WHIP rooms)

The plan says "remove unconditional OBS relay-first behavior" but doesn't trace through what happens to the viewer state machine when producers arrive asynchronously post-join. This is the actual hard part of Tier 2.5 client work.

#### 3. Single mediasoup Router is a hard ceiling the plan doesn't acknowledge

The entire system runs on one Router (`server.js:707-708`). One Router means one mediasoup Worker means one CPU core. The plan adds WHEP transports and consumers to the same Router.

Each WHEP viewer creates a WebRtcTransport + 1-2 consumers. mediasoup's WebRtcTransport allocates a UDP port from the `RTC_MIN_PORT`-`RTC_MAX_PORT` range. The current range is **100 ports** (`40000-40099`). Each transport uses at least one port.

With `MAX_VIEWERS_PER_ROOM=20` Socket.IO viewers + WHEP viewers, a single room could exhaust the port pool. Two active rooms definitely will. The plan mentions rate-limiting WHEP POSTs against `MAX_VIEWERS_PER_ROOM` but doesn't account for the transport port pool being a *global* resource shared across all rooms and all transport types (host, viewer, WHIP, WHEP).

**Fix:** Either widen the port range in the plan's config notes, or add a global transport count guard in `createWebRtcTransport()` that rejects new transports before the pool is exhausted.

---

### 🟡 Significant Concerns

#### 4. `parseDtlsParameters()` DTLS role logic is inverted for WHEP

The plan says to reuse `parseDtlsParameters()` from `lib/whip.js`. Look at the current implementation (`whip.js:294`):

```js
const role = section.setup === 'active' ? 'server' : 'client';
```

This works for WHIP because OBS sends `a=setup:actpass`, so this falls through to `'client'`, meaning mediasoup takes the `client` DTLS role (initiates the handshake). That's correct for ingest.

For WHEP, a browser viewer's offer will typically contain `a=setup:actpass`. The same function would produce `role: 'client'`. But for WHEP, mediasoup should usually take `'server'` role since the viewer is the one connecting to us. The plan says "reuse `parseDtlsParameters`" but the role semantics are reversed.

This is subtle because it *might* still work (mediasoup is somewhat flexible about DTLS roles), but it will cause intermittent DTLS failures in environments where the role negotiation matters. The dedicated WHEP answer builder should set its own DTLS role logic.

#### 5. `createWebRtcTransport()` doesn't pass ICE servers — WHEP viewers get host candidates only

Look at `lib/mediasoup.js:34`. The transport is created with `listenIps` only. mediasoup's `createWebRtcTransport` does not have a concept of STUN/TURN servers — those are ICE *servers* that the *client* uses, not the SFU.

The plan's Tier 2.5 says "use `config.getIceServers()` as the direct playback ICE source." But `getIceServers()` returns STUN/TURN URLs for the *browser client*. The server's transport only has host candidates from `listenIps`. If `PUBLIC_IP` is not set and the viewer is remote, the WHEP SDP answer will only contain private IP candidates — unreachable.

For Socket.IO viewers this works because the ICE servers are sent to the browser client via `server-config`, and mediasoup-client uses them during its own ICE gathering. For WHEP, the viewer receives the SDP answer containing *server-side* ICE candidates only. The viewer's own ICE stack will try STUN, but it needs to reach the server's candidates.

**The plan must note:** WHEP requires `PUBLIC_IP` to be set (or auto-detected) so that `announcedIp` in transport `listenIps` contains a reachable address. Without it, WHEP will only work on LAN. This is not a code bug to fix — it's a deployment requirement the plan should document as a Tier 3 prerequisite.

#### 6. No `producerclose` propagation to WHEP consumers

When OBS disconnects and the WHIP grace timer expires, `closeWhipSession()` calls `room.whipProducer.close()`. mediasoup will fire `producerclose` on all consumers consuming from that producer.

For Socket.IO viewers, `producerclose` emits `producer-closed` to the socket (`socket.js:1181-1186`), and the client handles it.

For WHEP viewers, there is no signaling channel. The consumer fires `producerclose`, but nobody tells the WHEP viewer. The viewer's WebRTC connection will stall (no media, no error, no ICE failure). It will sit there silently until the browser times out or the user refreshes.

The plan mentions "OBS reconnects mid-WHEP session" in the edge cases table and says "let viewer re-POST." But there's no mechanism to tell the viewer to re-POST. The WHEP spec doesn't have server-initiated signaling.

**Fix:** When `producerclose` fires on a WHEP consumer, close the WHEP transport immediately. This causes an ICE disconnection that the viewer can detect. Add this to the WHEP session setup in `whepRoutes.js`.

#### 7. The `emitHostMetrics` chain is broken for OBS rooms and the plan doesn't fix it

`emitHostMetrics()` at `socket.js:307-313` passes `summary.hasProducer` and `summary.hasAudioProducer`, which come from `getRoomStats()`, which checks `room.producer` — the browser producer. For OBS rooms, the host dashboard always sees `hasProducer: false` even when WHIP is live and streaming.

Antigravity flagged this (`getRoomStats()` reports wrong producer state, item #3), but the plan's "Tier 2.5 files to change" table doesn't list `lib/socket.js` `emitHostMetrics` as needing a fix. Since `emitHostMetrics` directly relays `getRoomStats()` fields, fixing `getRoomStats()` with `getActiveRoomProducers()` would propagate, but this dependency chain should be explicitly called out since `emitHostMetrics` also adds its own `whipConnected` field by reading from the full room object — a pattern inconsistency that could mask the fix if someone only patches `getRoomStats()`.

#### 8. `consume` handler creates consumers on `viewerData.recvTransport` — but WHEP viewers need their own transport

The plan's Tier 3 step 9 says "create consumer" but doesn't note that the existing `consume` handler (`socket.js:1165`) uses `viewerData.recvTransport` from `room.viewerTransports`. WHEP viewers don't have entries in `viewerTransports` (the plan correctly says not to put them there).

This means `whepRoutes.js` must call `transport.consume()` directly on the WHEP-specific transport, not go through any shared path. This is probably obvious, but the plan's "reuse the active-producer helper everywhere" language could be misread as reusing the consume *flow*. The helper resolves *which* producers to consume. The consume *mechanism* is completely separate for WHEP.

#### 9. `handleJoin` response sets `hasProducer` but viewer doesn't re-check after WHIP connection

In `WatchView.jsx`, the `handleJoin` response at socket.js:887 sets `hasProducer: !!room.producer`. For OBS rooms this is always `false` (Antigravity's finding #2). But even after Tier 2.5 fixes `join-room` to use `getActiveRoomProducers()`, there's still a problem: if the viewer joins *before* OBS connects (which is a valid and common flow — host creates room, shares code, OBS connects later), `hasProducer` will legitimately be `false`.

The viewer has no mechanism to transition from "no producer" to "producer available" for OBS rooms. For browser rooms, the `new-producer` event handles this. For OBS rooms after Tier 2.5, the same `new-producer` event from fix #1 above would be needed.

**This means fix #1 is not just a race condition fix — it's a fundamental missing feature for the OBS flow.** The plan should elevate "emit `new-producer` when WHIP producers are created" to a core Tier 2.5 requirement, not treat it as an edge case.

---

### 🟢 Suggestions & Improvements

#### 10. WHEP answer must use `a=recvonly`, not `a=sendonly`

The plan says the answer builder should use `a=sendonly` for media sections. This is wrong from the viewer's perspective. The WHEP spec (draft-ietf-wish-whep) requires the answer to have `a=sendonly` because from the *server's* perspective it is sending. But mediasoup's consumer direction is already `recv` from the consumer's point of view.

Actually — re-reading the plan, it says "sendonly for media sections" which is correct for the SDP answer (server sends, viewer receives). The viewer's offer will have `a=recvonly`. The answer mirrors with `a=sendonly`. This is correct. Leaving this note here because it's a common implementation mistake to confuse the two during testing.

#### 11. The `BUNDLE` group in the WHEP answer needs careful handling

The WHIP answer builder (`whip.js:324`) builds `a=group:BUNDLE ${mids.join(' ')}`. For WHEP, if the viewer offers 2 m-lines but only video can be consumed (audio producer missing), the answer must only include the video mid in the BUNDLE group. If the answer includes a mid with port 0 (rejected) in the BUNDLE group, some WebRTC stacks will reject the entire answer.

The plan's edge case table mentions "video-only rooms" but doesn't flag BUNDLE group consistency. The answer builder must only BUNDLE mids that have active consumers.

#### 12. `createWebRtcTransport` `initialAvailableOutgoingBitrate` is set for host→SFU, not SFU→viewer

The comment in `mediasoup.js:43` says "Skip the conservative BWE ramp-up on the host→SFU localhost transport." But the same `createWebRtcTransport()` is used for *all* transports — host, viewer, WHIP, and (future) WHEP. Setting `initialAvailableOutgoingBitrate: 8_000_000` on a WHEP viewer transport means the server will immediately try to push 8 Mbps to a remote viewer, potentially causing congestion before BWE converges.

For WHEP transports, either use the mediasoup default (600kbps) or a moderate value. The plan should note that WHEP transport creation may need different parameters than the current shared `createWebRtcTransport()`.

#### 13. No `a=extmap` handling in the plan's SDP answer builder

The plan says the answer must preserve `a=rtcp-mux`, `a=rtcp-rsize`, codec `fmtp`, and `rtcp-fb`. It doesn't mention `a=extmap` (RTP header extensions). mediasoup consumers have `rtpParameters.headerExtensions` that must be reflected in the SDP answer. Without them, features like abs-send-time (used for BWE) and mid (used for BUNDLE demuxing) won't work.

This is an implementation detail but it's the kind of thing that causes "it works in Chrome but fails in Firefox" bugs. The answer builder spec should explicitly list header extensions.

#### 14. Room stale cleanup will kill WHEP-only rooms

`startRoomCleanup()` in `rooms.js:241` destroys rooms when `now - room.lastHeartbeat > ROOM_STALE_TIMEOUT_MS`. Heartbeats are sent by the *host* via Socket.IO (`touchRoom`). If the host's Socket.IO connection drops but OBS is still streaming (e.g., host closes the browser tab but OBS keeps going), the room will be reaped after `ROOM_STALE_TIMEOUT_MS` (10 minutes default) even though WHEP viewers are actively watching.

The plan's WHEP session model has no heartbeat mechanism. A room with only WHEP viewers and a WHIP ingest but no Socket.IO host connection will be garbage-collected while media is flowing.

**Fix:** `touchRoom` should also be called when WHEP sessions are created or when WHIP media is flowing. Or the stale check should consider `room.whipConnected` as evidence of liveness.

#### 15. `closeWhipSession()` doesn't emit `producer-closed` to Socket.IO viewers

When `closeWhipSession()` is called (`whipRoutes.js:26-51`), it calls `room.whipProducer.close()`. mediasoup fires `producerclose` on consumers, which triggers the per-consumer handler in `socket.js:1181`:

```js
consumer.on('producerclose', () => {
    socket.emit('producer-closed', { consumerId: consumer.id });
});
```

But this handler was registered when the consumer was created in the `consume` handler — which currently only runs for browser producers. After Tier 2.5, Socket.IO viewers consuming WHIP producers will have these handlers correctly set up. This should work. But verify during testing that the `producerclose` event propagates correctly through the WHIP producer → consumer chain, since the consumer was created against a producer that was itself created inside an async DTLS callback rather than the normal `produce` socket handler.

#### 16. WHEP session IDs must not be guessable

The plan uses `crypto.randomBytes(16).toString('hex')` for WHIP resource IDs. WHEP session IDs should use at least the same entropy. Since WHEP has no auth in Phase 1, the session ID is the only thing preventing a third party from DELETEing someone else's session. 16 bytes (128 bits) is fine, but this should be noted as a security-relevant choice, not just a convenience.

#### 17. Consider `Content-Disposition` on the WHEP 201 response

Some HTTP client libraries and middleware will try to interpret `application/sdp` responses. Adding `Content-Disposition: inline` prevents caching proxies or CDNs from treating the SDP as a downloadable file. Minor, but costs nothing.

#### 18. The plan conflates two separate "STUN" concepts

The plan repeatedly mentions "STUN-first" for Tier 2.5. But there are two unrelated STUN roles:

1. **Client-side STUN**: The browser uses STUN to discover its public IP for ICE candidates. This is configured via `getIceServers()` and already works.
2. **Server-side candidate reachability**: The mediasoup transport's `announcedIp` must be publicly reachable. This isn't STUN — it's just correct `PUBLIC_IP` configuration.

When the plan says "STUN-first, direct WebRTC where UDP works," it should clarify that "STUN" here means "the viewer's ICE stack uses STUN to discover its own address and reach the server's announced IP." The server doesn't use STUN at all. This matters because a deployment where `PUBLIC_IP` isn't set will fail all remote viewers regardless of STUN configuration, and the error messages should point at the right thing.

---

### Summary Of Recommended Changes

1. **Tier 2.5 (critical):** Emit `new-producer` to the Socket.IO room when WHIP producers are created inside the DTLS callback. This is not optional — without it, OBS rooms are broken for viewers who join before or during WHIP connection.
2. **Tier 2.5:** Trace the full WatchView state machine for "producer arrives after join" in OBS mode. The auto-fallback removal interacts with `new-producer` handling.
3. **Tier 3:** Note that `parseDtlsParameters()` role logic needs a WHEP-specific variant.
4. **Tier 3:** Document that `PUBLIC_IP` is required for WHEP to work outside LAN.
5. **Tier 3:** Close WHEP transports on `producerclose` — there's no signaling channel to notify the viewer otherwise.
6. **Tier 3:** Include `a=extmap` header extensions in the answer builder spec.
7. **Tier 3:** Use conservative `initialAvailableOutgoingBitrate` for WHEP transports, not the 8Mbps host-ingest value.
8. **Tier 3:** Handle BUNDLE group correctly when only a subset of offered media can be consumed.
9. **Tier 3:** Widen `RTC_MIN_PORT`-`RTC_MAX_PORT` or add a global transport pool guard. 100 ports is not enough for WHEP at scale.
10. **Tier 2.5/3:** Make `touchRoom` fire on WHIP/WHEP activity so rooms with active media aren't garbage-collected.

Signed,
**Opus**

---

## Gemini's Additional Review

Antigravity covered excellent architectural ground, but looking deeper into state management, spec compliance, and edge cases, there are several more potential pitfalls that could collapse under scale or real-world network conditions.

### 🔴 Critical Issues & Hidden Race Conditions

#### 16. WHEP Unauthenticated Session Hijacking/Termination
The plan specifies `DELETE /whep/watch/:sessionId` closes the session, and Phase 1 has no auth. If `sessionId` is generated sequentially or is otherwise guessable, an attacker can enumerate and `DELETE` active sessions, disconnecting legitimate viewers constantly.
**Fix:** Ensure WHEP `sessionId` uses a cryptographically secure RNG (e.g., `crypto.randomUUID()` or a high-entropy string like `nanoid`).

#### 17. Async Consumer Creation Race Condition
In the suggested route flow (Step 9):
`For each active producer: create consumer paused:true`
Consumer creation in Mediasoup is asynchronous. If a viewer sends a `POST` to connect, and immediately their browser cancels/aborts the request or sends a `DELETE` (e.g., closing the tab instantly), the `DELETE` might process *before or during* the `await router.createConsumer()` step. 
**Fix:** The session object must have an atomic `state` (e.g. `connecting`, `connected`, `closing`). If a `DELETE` arrives or the transport fails while consumers are still being awaited, the subsequent consumers must be immediately destroyed once standard execution resumes to prevent memory leaks in the Mediasoup worker.

#### 18. Missing `a=inactive` / Port 0 mapping for asymmetrical media
OBS WHIP usually sends both audio and video, but a user might configure OBS to send video-only. If a WHEP viewer's standard SDP offer contains both audio and video `m=` lines, but the room only has `videoProducer`, Mediasoup won't create an audio consumer. The WHEP answer **MUST** explicitly reject the viewer's audio `m=` line by setting its port to `0` or `a=inactive` in the generated SDP answer, keeping the `m=` sections in the exact same order. If they are just omitted from the SDP answer, standard WebRTC clients will fail to set remote description due to m-line count mismatch.

### 🟡 Significant Concerns

#### 19. Congestion Control & RTCP Feedback (TWCC)
The plan glosses over `rtpCapabilities` conversion, but specifically, if `transport-cc` (TWCC) and `REMB` are not successfully mapped from the WHEP viewer's SDP into `router.canConsume()`, the WHEP viewer will not send back bandwidth estimations. Without TWCC from WHEP viewers, Mediasoup's BWE (Bandwidth Estimator) cannot respond to poor viewer network conditions natively, leading to frozen frames instead of dynamic bitrate adaptation or layered fallback.
**Fix:** Ensure `offerToRtpCapabilities` strictly preserves `encodings` and `rtcpFeedback` attributes related to bandwidth estimation (`transport-cc`, `ccm fir`, `nack pli`).

#### 20. Event-loop blocking from SDP Parsing (Flash Crowds)
WHEP is designed for HTTP-based scale. While WebRtcTransports live on the fast C++ Mediasoup workers, the `POST /whep/...` route processes SDP parsing in the single-threaded Node.js event loop. If a popular room attracts 100 viewers simultaneously, running synchronous SDP parsing (e.g., using `sdp-transform` on 64kb SDPs) 100 times can block the Node event loop, delaying signaling for Socket.IO clients and WHIP health checks.
**Fix:** Ensure SDP string manipulation is efficient. Do not regex-match the entire 64kb string unnecessarily. Under high WHEP traffic, consider offloading or yielding the event loop.

#### 21. Standard ICE Servers via HTTP Link Headers
If WHEP is meant to be standards-compliant, providing TURN servers purely via SDP might limit some client capabilities. The WHEP specification (IETF Draft) recommends providing ICE servers via HTTP `Link` headers on the `201 Created` response.
**Example:** `Link: <turn:turn.example.com?transport=udp>; rel="ice-server"; cross-origin-credentials="...">`
**Fix:** In Phase 3 (BYOK TURN stage), emit HTTP `Link` headers alongside the 201 Response so WHEP clients that gather their own ICE can use the host's TURN easily.

### 🟢 Optimizations & Future Proofing

#### 22. ICE Restarts in Phase 2
The plan mentions `PATCH` for Trickle ICE later, but neglects **ICE Restarts**. Viewers on mobile devices switching from Wi-Fi to Cellular will experience broken transport. In WHEP, ICE restarts are typically handled by the client doing a `POST` or `PATCH` on the session URL with a new offer. The server must be prepared to update the WebRtcTransport with new remote ICE parameters rather than recreating the consumers entirely. State this in the Phase 2 goals.

#### 23. Viewer Playout Delay / Buffering Default
WebRTC via Socket.IO in custom players usually strips playout delay for real-time latency. When moving to standard WHEP with native `<video autoplay>` tags, browsers try to add small playback buffers to smooth out jitter, adding 200-500ms latency artificially. 
**Optimization:** Even though WHEP is the backend transport, document that frontend WHEP clients should be configured with `video.preservesPitch = false` or the WebRTC `playoutDelayHint` to enforce the same real-time feel as the existing P2PVideo infrastructure.

#### 24. Codec Fingerprint Matching / Payload Matcher
When generating `offerToRtpCapabilities`, the payload type numbers (PT) for H.264 profiles or AV1 may differ between what Mediasoup internally assigned and what the browser WHEP client offered. Do not just string-match codecs; parse the `fmtp` lines (profile-level-id for H.264, profile/tier for AV1) to ensure the client is actually capable of receiving the specific encoder profile OBS is pushing.

Signed,
**Gemini** ✧

---

## Codex Review

The overall sequencing is right: Tier 2.5 before Tier 3 is the correct call. The remaining risks are mostly in places where the plan still sounds cleaner than the current repo really is.

### 1. The plan still overstates how "HTTP-scale" WHEP will be in this architecture

The proposed WHEP shape looks standards-based from the outside, but the implementation is still deeply in-process and stateful:

- `lib/rooms.js` stores all room state in memory
- the plan adds `room.whepSessions = new Map()`
- `DELETE /whep/watch/:sessionId` implies either a global session lookup map or a full room scan

That is fine for a single-node build, but it is not horizontally safe. Once you put this behind multiple Node instances or a load balancer, `POST` and `DELETE` must hit the same process or the session disappears from the server's point of view.

Recommendation:

- explicitly mark Tier 3 Phase 1 as `single-node only` unless you also require sticky sessions
- if multi-node is even a medium-term goal, call out shared session state as a future prerequisite instead of letting WHEP look stateless when it is not

Signed,
Codex

### 2. "PATCH = 405" and "full ICE only" means the answer must not advertise trickle ICE

The plan is correct to defer `PATCH`, but that decision has to be reflected in the SDP contract too.

Current WHIP answer generation in `lib/whip.js` emits:

- `a=ice-options:trickle`
- candidates
- `a=end-of-candidates`

For WHEP Phase 1, if `PATCH` is intentionally unsupported, the answer builder should not advertise trickle support at all. Otherwise some clients will infer that PATCH/trickle is available and behave accordingly.

Recommendation:

- in the WHEP answer builder, send a complete ICE answer with `a=end-of-candidates`
- do not emit `a=ice-options:trickle` until `PATCH` is actually implemented

Signed,
Codex

### 3. "Browser test clients" is realistic. "Standards-based receivers" is overstated until there is a trusted TLS story

The plan says Phase 1 is enough for:

- browser test clients
- standards-based receivers

That second claim is too optimistic for the current repo.

Today:

- the main app runs on HTTPS
- WHIP gets a separate HTTP server because OBS rejects the self-signed HTTPS path
- the repo currently depends on local/self-signed certificate behavior for development and packaged runs

That works for your own browser app because the user can trust the page and continue. It is much weaker for third-party WHEP clients, headless receivers, and stricter browser/runtime stacks.

Recommendation:

- explicitly say Tier 3 interoperability outside LAN/dev requires a trusted certificate and stable public origin
- otherwise WHEP Phase 1 should be described as `app-integrated and dev-friendly`, not broadly interoperable

Signed,
Codex

### 4. WHEP viewer counting will lie unless server aggregates and the host UI change together

The plan correctly says `whepViewerCount` should be tracked separately, but the current product surfaces are more coupled than the document implies.

Current code:

- `server.js:495-506` totals only `viewerCount` and `relayViewerCount`
- `lib/socket.js:307-332` emits host metrics based on those same room stats
- `src/HostView.jsx:208`, `src/HostView.jsx:337`, and `src/HostView.jsx:1115-1128` still treat `viewerCount` as the primary viewer number shown to the host

So even if Tier 3 adds `whepViewerCount`, the host can still end up seeing "0 viewers" while WHEP sessions are active. That kind of mismatch is the sort of thing that makes a rollout look broken even when transport works.

Recommendation:

- define canonical fields up front:
  - `directViewerCount`
  - `relayViewerCount`
  - `whepViewerCount`
  - `totalViewerCount`
- update `/api/metrics`, `room-metrics`, and the host UI in the same milestone
- do not leave viewer accounting as a follow-up cleanup

Signed,
Codex

### 5. AV1 is not just a Tier 3 egress change in this repo

The plan talks about "AV1 + WHEP" as if the big work is on the viewer side. In this repo, that is not true.

Right now AV1 is blocked across multiple layers:

- `lib/whip.js` rejects AV1-only ingest
- `lib/whipRoutes.js` validates OBS ingest as H.264-only
- `src/lib/obsWebSocket.js` auto-configures H.264-only output for the stable lane
- `lib/ffmpegRelay.js` is H.264-only
- the existing tests enforce the stable H.264 build assumptions

So "Tier 3 = AV1 primary" needs a transition plan, not just a WHEP transport plan.

Recommendation:

- add an explicit dual-codec sub-phase:
  - H.264 ingest remains supported
  - WHEP negotiates H.264 and AV1 where possible
  - AV1 becomes room- or profile-selectable before it becomes the default direction
- otherwise Tier 3 risks turning into a flag-day refactor across ingest, viewer, relay, docs, and tests

Signed,
Codex

### 6. The WHEP answer-builder spec is still missing RTX / FID details

The earlier reviews correctly called out header extensions and BUNDLE handling, but one more SDP detail is missing: RTX.

If the consumer RTP parameters include RTX, the WHEP answer needs to represent that correctly:

- include the RTX payload type in the `m=` section
- emit `a=rtpmap` for RTX
- emit `a=fmtp:<rtx-pt> apt=<media-pt>`
- include the RTX SSRC when present
- include `a=ssrc-group:FID`

If this is skipped, packet-loss recovery gets worse and interop becomes fragile. This is exactly the kind of thing that works in one browser and then burns time later.

Recommendation:

- expand the answer-builder requirements so they explicitly cover primary codec plus RTX/FID when present

Signed,
Codex

### 7. No-viewer-auth plus browser-facing WHEP is a bigger hotlinking risk than the current app flow

The current app already treats the room code as the viewer secret. WHEP makes that easier to abuse because it exposes a raw browser-consumable HTTP watch surface instead of requiring the full in-app Socket.IO viewer flow.

That does not mean Phase 1 must ship with auth. It does mean the plan should be honest about the threat model:

- 6-character room codes are not high-entropy secrets
- permissive CORS plus unauthenticated WHEP makes third-party embedding easier
- WHEP will be more attractive to scrape than the current app-specific watch path

Recommendation:

- if viewer auth is deferred, state clearly that Phase 1 is intended for trusted/private sharing
- consider a lightweight signed viewer token as the first hardening step, before a full account/auth system

Signed,
Codex

### Final Codex Take

The plan is directionally good, but it is still understating six things that can come back to hurt the rollout:

1. WHEP is not stateless in this architecture.
2. Full ICE plus `405 PATCH` needs a non-trickle SDP contract.
3. Trusted TLS is a real prerequisite for serious interoperability.
4. Viewer accounting must be fixed end-to-end, not just in room state.
5. AV1 needs a dual-codec migration plan, not just WHEP routes.
6. The answer builder still needs explicit RTX/FID requirements.

If those are folded into the plan now, the odds of one-shotting the implementation go up materially.

Signed,
Codex

---

## Codex Consolidation: Implementation-Ready Plan

This section is the implementation lock-in. It incorporates the main points raised by Antigravity, Opus, Gemini, and the earlier Codex review, and turns them into one plan that can actually be executed without guessing.

If anything above conflicts with this section, this section wins.

### 1. Final Scope Split

#### Tier 2.5 is mandatory before any WHEP work ships

Tier 2.5 is not optional cleanup. It is the proof that OBS ingest can already support direct WebRTC viewers correctly inside the existing product.

Tier 2.5 must land first because it validates:

- active producer resolution for OBS rooms
- direct viewer playback for OBS over the existing mediasoup viewer path
- late-producer arrival handling for OBS viewers
- direct-vs-relay metrics
- the real ICE behavior of the current H.264 lane

Only after that is stable should Tier 3 WHEP begin.

Signed,
Codex

#### Tier 3 Phase 1 is intentionally small

Tier 3 Phase 1 will be:

- `POST /whep/watch/:roomCode`
- `DELETE /whep/watch/:sessionId`
- HTTPS only
- full ICE only
- no PATCH yet
- no ICE restarts yet
- no relay replacement
- no AV1 default switch yet

This is enough to validate the WHEP egress architecture without mixing in every later concern at once.

Signed,
Codex

### 2. Locked Decisions

These are no longer open questions.

#### 2.1 Producer resolution

Use one shared helper in `lib/rooms.js`:

```js
function getActiveRoomProducers(room) {
  if (room.ingestMode === 'obs') {
    return {
      videoProducer: room.whipProducer,
      audioProducer: room.whipAudioProducer,
    };
  }

  return {
    videoProducer: room.producer,
    audioProducer: room.audioProducer,
  };
}
```

This helper must be used by:

- `join-room`
- `get-producers`
- `consume`
- `getRoomStats`
- future WHEP route creation

Signed,
Codex

#### 2.2 OBS viewers must receive `new-producer` when WHIP producers appear

This is a Tier 2.5 requirement, not a nice-to-have.

When WHIP producers are created inside `lib/whipRoutes.js` after DTLS connects, the server must emit the same `new-producer` event shape already used by browser-host rooms.

Without this:

- viewers who joined before OBS fully connected stay stuck
- late producer arrival is broken for OBS
- Tier 2.5 direct playback looks flaky even if the transport logic is correct

Signed,
Codex

#### 2.3 `WatchView.jsx` must stop auto-forcing OBS into relay mode

The current unconditional OBS relay effect must be removed for Tier 2.5.

Final viewer policy:

- direct WebRTC first by default
- relay first only when `isTunnelOrigin && !hasTurnServer`
- keep manual controls to switch modes
- if direct WebRTC fails, fall back to relay

Also:

- `new-producer` must be handled even when the viewer is joined but not yet watching
- late producer arrival must trigger the UI out of the "waiting" state

Signed,
Codex

#### 2.4 WHEP Phase 1 is single-node only

Because room and session state are in memory, WHEP Phase 1 is explicitly:

- single process
- or sticky-session only behind a proxy

Do not describe it as horizontally scalable yet.

Signed,
Codex

#### 2.5 `WHEP_ENABLED` defaults to `false`

This is the correct rollout posture for a new unauthenticated browser-facing endpoint.

Signed,
Codex

#### 2.6 Remote WHEP requires both trusted TLS and reachable public ICE candidates

For WHEP outside LAN, the deployment must have:

- a trusted HTTPS origin
- `PUBLIC_IP` configured or correctly auto-detected for mediasoup `announcedIp`

STUN alone is not enough. The server must advertise reachable candidates.

Signed,
Codex

### 3. WHEP HTTP Contract

#### 3.1 POST

`POST /whep/watch/:roomCode`

Request:

- `Content-Type: application/sdp`
- full SDP offer
- body parser limit: `64kb`

Response:

- `201 Created`
- `Content-Type: application/sdp`
- `Location: /whep/watch/:sessionId`
- `Access-Control-Expose-Headers: Location`
- body: full SDP answer

Signed,
Codex

#### 3.2 DELETE

`DELETE /whep/watch/:sessionId`

Response:

- `200 OK` if session existed and was closed
- `404 Not Found` if session does not exist

WHEP session IDs must use strong random entropy.

Signed,
Codex

#### 3.3 PATCH

Phase 1 supports no PATCH behavior at all.

Final Phase 1 behavior:

- return `501 Not Implemented` for all PATCH requests

Reason:

- the endpoint does not yet implement trickle ICE
- the endpoint does not yet implement ICE restarts
- advertising partial PATCH semantics now just creates ambiguity

Later, when PATCH is implemented:

- use `204 No Content` for successful trickle ICE candidate updates
- use `ETag` and `If-Match` rules per WHEP for PATCH flows

Signed,
Codex

### 4. SDP / mediasoup Rules

#### 4.1 Do not build receive capabilities from scratch if a filtered-router approach is simpler

The plan currently frames `offerToRtpCapabilities()` as a full translation step. That is risky.

Implementation rule:

- derive viewer receive capabilities by filtering router capabilities against the offered SDP support
- do not invent a large hand-rolled mediasoup capability generator if a narrower compatibility filter is enough

The purpose is:

- safe `router.canConsume(...)`
- correct codec/profile intersection
- minimal SDP-to-mediasoup translation surface

Signed,
Codex

#### 4.2 WHEP answer builder must be consumer-driven

Create a dedicated `lib/whep.js` and build the answer from created consumers, not from the offered codecs directly.

The answer builder must:

- keep original m-line order
- use original mids when present
- use `a=sendonly` on accepted media sections
- reject unsupported media sections with port `0`
- emit BUNDLE only for active accepted mids
- include `a=rtcp-mux`
- include `a=rtcp-rsize`
- include codec `fmtp`
- include codec `rtcp-fb`
- include RTP header extensions (`a=extmap`)
- include RTX when present
- include `a=ssrc-group:FID` when RTX is present
- include `a=end-of-candidates`

Phase 1 answer must not emit:

- `a=ice-options:trickle`

Signed,
Codex

#### 4.3 DTLS parsing for WHEP is separate from WHIP

Do not blindly reuse WHIP DTLS role logic.

Implementation rule:

- WHEP gets its own DTLS parameter extraction logic
- the WHEP answer builder sets its own role/`setup` semantics

Signed,
Codex

#### 4.4 WHEP consumes directly on its own transport

WHEP must not reuse the Socket.IO `consume` handler path.

WHEP route logic creates:

- its own `WebRtcTransport`
- its own consumers
- its own cleanup handlers

The shared helper is only for resolving which active producers to consume.

Signed,
Codex

### 5. Transport and Lifecycle Rules

#### 5.1 Parameterize `createWebRtcTransport()` by purpose

The current shared transport factory uses:

- one port pool
- one outgoing bitrate default

That is too blunt once WHEP is added.

Implementation rule:

```js
createWebRtcTransport(router, { purpose: 'host' | 'viewer' | 'whip' | 'whep' })
```

Use this to:

- keep host/broadcast transports allowed to start richer
- give WHEP/viewer transports a more conservative `initialAvailableOutgoingBitrate`
- add future guards by purpose

Signed,
Codex

#### 5.2 Add a global transport-capacity guard

The current mediasoup port range is too small to pretend capacity is unlimited.

Implementation rule:

- widen the configured RTC port range in deployment guidance
- and add a server-side guard that refuses new transports before the worker/pool is exhausted

This is required for both Tier 2.5 and Tier 3.

Signed,
Codex

#### 5.3 WHEP sessions need explicit state

Session object shape must include:

```js
{
  id,
  roomCode,
  state, // connecting | connected | closing | closed
  transport,
  consumers,
  createdAt,
  closed: false,
}
```

This is required to handle:

- aborted POSTs
- concurrent DELETE during setup
- transport failure during async consumer creation

Signed,
Codex

#### 5.4 Close WHEP transport on `producerclose`

Because WHEP has no server-initiated signaling, the transport must be closed when the consumed producer disappears.

This forces the viewer to observe a real connection failure instead of silent frozen playback.

Signed,
Codex

#### 5.5 Room liveness must include WHIP/WHEP activity

Do not let rooms be reaped only by host Socket.IO heartbeat once WHEP exists.

Liveness sources must include at least:

- host heartbeat
- active WHIP connection
- WHEP session creation / activity

Signed,
Codex

### 6. Metrics and Product Surfaces

Use canonical metrics names from the start:

- `directViewerCount`
- `relayViewerCount`
- `whepViewerCount`
- `totalViewerCount`
- `mediasoupConsumerCount`

These must be surfaced together in:

- `getRoomStats()`
- host `room-metrics`
- `/api/metrics`
- host UI

Do not overload the existing `viewerCount` field with shifting meaning.

For Phase 1:

- `directViewerCount` = Socket.IO mediasoup viewers
- `relayViewerCount` = relay viewers
- `whepViewerCount` = WHEP sessions
- `totalViewerCount` = sum of all three

Signed,
Codex

### 7. AV1 Positioning

Tier 3 should not be written as "flip AV1 on."

Implementation-ready AV1 stance:

- H.264 remains supported throughout Tier 3
- WHEP must negotiate H.264 where AV1 is unavailable
- AV1 becomes additive first, default later

That means the roadmap is really:

1. Tier 2.5: OBS direct playback on H.264
2. Tier 3 Phase 1: WHEP egress on the existing stable codec story
3. Tier 3 Phase 2+: AV1 expansion and codec-default decisions

This avoids turning WHEP transport work into an ingest/relay/codec flag day.

Signed,
Codex

### 8. Security Position

Phase 1 WHEP remains unauthenticated, but the plan must describe it honestly:

- intended for trusted/private sharing
- off by default
- room code remains the viewer secret
- browser-facing WHEP is easier to embed/scrape than the current app viewer flow

First hardening step after Phase 1:

- signed viewer token

Not required to start implementation, but it should be the next security milestone if WHEP is enabled outside private use.

Signed,
Codex

### 9. Final File/Task Map

#### Tier 2.5

1. `lib/rooms.js`
   Add `getActiveRoomProducers()`
   Update `getRoomStats()`
   Add canonical viewer counters scaffolding
   Update stale-room liveness logic

2. `lib/socket.js`
   Use active producer helper in `join-room`, `get-producers`, `consume`
   Emit `new-producer` when WHIP producers materialize
   Fix host metrics payload to use canonical counts

3. `lib/whipRoutes.js`
   Emit late producer availability to viewers
   Keep WHIP producer lifecycle compatible with Tier 2.5 direct viewers

4. `src/WatchView.jsx`
   Remove unconditional OBS relay auto-entry
   Handle late `new-producer`
   Preserve relay-first only for tunnel-without-TURN

5. `README.md` and tests
   Document OBS direct-first behavior
   Cover direct OBS consume, late producer arrival, and fallback policy

Signed,
Codex

#### Tier 3 Phase 1

1. `lib/whep.js`
   Offer filtering
   WHEP-specific DTLS parsing
   Consumer-driven SDP answer builder

2. `lib/whepRoutes.js`
   `POST`
   `DELETE`
   rate limits
   capacity checks
   session state machine
   transport/consumer cleanup

3. `lib/mediasoup.js`
   transport purpose parameter
   conservative WHEP/viewer outgoing bitrate
   capacity guard

4. `lib/rooms.js`
   `whepSessions`
   `whepViewerCount`
   canonical totals

5. `server.js`
   mount WHEP on HTTPS only
   `WHEP_ENABLED` gate

6. host metrics surfaces
   `/api/metrics`
   host UI

7. tests
   route tests
   SDP answer shape tests
   cleanup/race tests
   metrics tests

Signed,
Codex

### 10. Exit Criteria

Do not call the plan implementation-ready unless all of these are true.

#### Tier 2.5 done

- OBS rooms can be watched over direct WebRTC on normal UDP-capable networks
- viewers who joined before WHIP producer creation recover without refresh
- relay-first only happens for tunnel origins without TURN
- host metrics distinguish direct vs relay correctly

#### Tier 3 Phase 1 done

- WHEP POST/DELETE work on HTTPS
- WHEP session cleanup is idempotent
- WHEP sessions close on producer loss
- WHEP counts appear in metrics and host UI
- answer builder works for video-only and audio+video offers
- answer builder preserves extmaps and RTX/FID when present
- remote WHEP works only when deployment prerequisites are met, and the plan says so explicitly

Signed,
Codex
