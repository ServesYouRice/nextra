# Logical & Implementation-Quality Issues

Findings on application logic, async correctness, resource/memory management, state handling, and business-logic edge cases. Each item lists severity, location, impact, fix, and whether it blocks launch.

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## L-1 🔴 Fallback-relay start is racy → duplicate FFmpeg pipelines & leaked interval

- **Severity:** Critical
- **Blocker:** Yes (for OBS/WHIP rooms)
- **Location:** `lib/socket.js:662-1048` (`startFallbackRelay`), guard at `:665`, `room.fallbackWorker` assigned at `:1015`; callers `lib/whipRoutes.js:380-383` (WHIP prewarm) and `lib/socket.js:1744-1746` (`fallback-consume-start`).

**Problem.** `startFallbackRelay` guards re-entry with `if (room.fallbackWorker) return;` at the very top, but it only sets `room.fallbackWorker = relay` *after* a long `await` chain (create DirectTransport, consume, create PlainTransport, free UDP ports, optionally sample 3 s of RTP for frame-rate detection, `await relay.start()`). During that window `room.fallbackWorker` is still `null`, so a second concurrent caller passes the guard and starts a **second** FFmpeg pipeline, second DirectTransport/consumer/PlainTransport, and second `_fallbackKfInterval`.

Two callers legitimately fire close together: the WHIP `dtlsstatechange:'connected'` handler prewarms the relay (`whipRoutes.js:380`), and a viewer's `fallback-consume-start` can arrive in the same window (`socket.js:1744`, gated only by `!room.fallbackWorker`). Because `startFallbackRelay` overwrites `room._fallbackKfInterval`, `room._fallbackVideoConsumer`, etc. at `:1035-1041`, the first pipeline's handles are **orphaned** — `stopFallbackRelay` can never clear them.

**Why it matters.** Two FFmpeg processes per room double CPU/GPU and NVENC session pressure, produce interleaved/duplicated init segments and fragments to viewers (visible corruption / generation thrash), and leak a `setInterval` + transports + consumers for the life of the room. On a busy host this compounds per room.

**Fix.** Make the function re-entrancy-safe by claiming the slot synchronously before the first `await`, e.g. set a `room.fallbackStarting = true` (or assign a placeholder to `room.fallbackWorker`) at the top and check it in the guard; clear it in the `catch`. Alternatively wrap start in a per-room promise stored on the room so concurrent callers await the same start.

**Related risk.** `stopFallbackRelay` (`:1050`) and `closeWhipSession` (`whipRoutes.js:80`) both assume a single set of handles; the orphaned set defeats their cleanup and can keep a UDP port and a mediasoup consumer alive until process exit.

---

## L-2 🟠 No top-level `unhandledRejection` / `uncaughtException` handler on the server (non-packaged path)

- **Severity:** High
- **Blocker:** Yes for long-running/public deployments
- **Location:** `server.js` (whole file — only the async IIFE has a `.catch` at `:1246`); packaged path installs `uncaughtExceptionMonitor` in `lib/startupRuntime.js:224` but that is **monitor-only** and Windows-only, and is not loaded by `npm start`.

**Problem.** The server spawns many fire-and-forget promises (`.catch(() => {})` in places, but also awaited chains inside event handlers). A rejection that escapes — e.g. inside a mediasoup event callback, a `transport.produce` in the WHIP `dtlsstatechange` handler at `whipRoutes.js:305` (its `catch` only logs, good, but other paths exist) — will, on Node ≥ 20 with default settings, terminate the process on `unhandledRejection`. There is no `process.on('unhandledRejection')` or `process.on('uncaughtException')` in the normal server path.

**Why it matters.** A single unexpected rejection kills the whole host process, dropping every room and viewer. The mediasoup worker-death auto-restart (`server.js:1049`) does **not** cover main-process crashes.

**Fix.** Add `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` at the top of `server.js` that log and, for uncaught exceptions, perform `cleanupGlobalResources()` and a controlled restart/exit. Consider running under a supervisor (systemd/pm2/Windows service) as defense in depth (see `production-readiness.md`).

---

## L-3 🟠 All public-tunnel viewers collapse to one synthetic IP → shared rate-limit bucket

- **Severity:** High
- **Blocker:** Yes if public tunnel is the primary sharing method
- **Location:** `server.js:219-230` (`getClientIpFromHeaders` returns the literal `'public-share-proxy'`); consumed by connection rate limiter `server.js:1157-1174` and join/create limiters `lib/socket.js:1114,1216` via `getSocketHandshakeIp`.

**Problem.** When a request arrives through the cloudflared tunnel and forwarded headers are not trusted (the default — `TRUST_X_FORWARDED_HEADERS=false`), every tunnel viewer is bucketed under the same identifier `'public-share-proxy'`. The per-IP connection limiter (`MAX_CONNECTIONS_PER_IP=60`/min, `server.js:786`), join limiter (`JOIN_RATE_LIMIT_MAX=20`/min), and create-room limiter all key on that single string.

**Why it matters.** Two coupled failures: (1) **Denial of service to legitimate viewers** — 60 total connections/min across *all* internet viewers is easily exceeded by a modestly popular stream; once tripped, `rawSocket.close()` (`server.js:1172`) drops *everyone* coming through the tunnel. (2) **Abuse controls are defeated** — one malicious client and one honest client share a bucket, so per-IP limiting provides no real isolation over the tunnel.

**Fix.** When behind the built-in cloudflared tunnel, trust `cf-connecting-ip` for rate-limiting purposes (cloudflared sets it) even while keeping it untrusted for share-URL derivation; or raise/relax the connection cap specifically for the known tunnel origin; or bucket by a hash of `cf-connecting-ip` when the request matches the known tunnel host. Document the trade-off. See also `security-issues.md` S-4.

---

## L-4 🟠 `socketRequest` retries `join-room`; a slow-but-successful first attempt makes the retry fail

- **Severity:** High
- **Blocker:** No (degrades reliability on flaky networks)
- **Location:** `src/lib/mediasoupClient.js:5-11` (`RETRYABLE_EVENTS` includes `join-room`, `create-room`, `reclaim-host`, `leave-room`), retry loop `:130-146`; server rejects a second join with "Already in a room" at `lib/socket.js:1209-1213`.

**Problem.** `join-room` is marked retryable with `maxAttempts: 2`. If the first emit reaches the server and the server registers the viewer, but the ack is slow (or the socket blips) so the client times out, the retry sends a second `join-room`. The server now finds the socket already in a room and returns `Already in a room. Leave first.`, which surfaces to the user as a hard join failure even though they *did* join.

**Why it matters.** On exactly the flaky/high-latency networks where retries are supposed to help, the retry converts a transient timeout into a permanent, confusing error. Same class of hazard applies to `create-room` (a timed-out-but-successful create is replaced/destroyed via the "Host already had room… Replacing it" path at `socket.js:1132`, which is more forgiving but still churns).

**Fix.** Make `join-room` idempotent server-side: if the socket is already in the requested room, return the normal success payload instead of an error. Or drop `join-room` from `RETRYABLE_EVENTS` and let the caller re-drive join explicitly. Prefer the idempotent-server fix — it also helps the reconnect path.

---

## L-5 🟠 fMP4 relay player leaks video-element listeners & object URLs across generations

- **Severity:** High
- **Blocker:** No (memory growth over long OBS sessions)
- **Location:** `src/lib/fmp4RelayPlayer.js:475-553` (`setupMediaSource` pushes cleanup fns into `cleanupFns`), `:555-582` (`cleanupMediaSource` does **not** run `cleanupFns`), generation change path `:418-421`, `resetAndRequestInit` `:110-129`.

**Problem.** Each `setupMediaSource` call registers `updateend`/`error` on the SourceBuffer and `loadeddata`/`playing`/`waiting`/`stalled` on the **video element**, and creates an object URL — all recorded via `cleanupFns.push(...)`. But `cleanupFns` is only drained in `stop()` (`:624`). On every FFmpeg generation change (`handleMediaInit` at `:418` calls `cleanupMediaSource` then a later `setupMediaSource`) and on every `resetAndRequestInit` recovery (`:110`), `cleanupMediaSource` tears down the MediaSource/SourceBuffer but leaves the old `cleanupFns` in place — the video-element listeners are never removed and the old object URL is never revoked.

**Why it matters.** OBS relays restart/regenerate frequently (init-segment recovery, restart budget, keyframe gaps). Over a multi-hour stream a viewer accumulates dozens–hundreds of stale `waiting`/`stalled`/`playing` listeners on one `<video>` plus leaked blob URLs. The stale listeners still fire (`scheduleBufferingState`, `setState`) and can drive spurious buffering-state churn, and memory grows.

**Fix.** Run the per-generation cleanup fns inside `cleanupMediaSource` (drain and clear `cleanupFns`, or scope them to a per-generation array that `cleanupMediaSource` flushes). Ensure `URL.revokeObjectURL` runs on every teardown, not only `stop()`.

---

## L-6 🟡 WHEP `iceDisconnectTimer` not cleared on session close → timer leak / late close

- **Severity:** Medium
- **Blocker:** No
- **Location:** `lib/whepRoutes.js:314-339` (`iceDisconnectTimer` is a closure local set on `icestatechange:'disconnected'`), `closeWhepSession` `:77-100` (clears only `session.connectTimer`, not `iceDisconnectTimer`).

**Problem.** When ICE goes `disconnected`, a 30 s timer is armed to close the session. If the session is closed for another reason first (DTLS failed, producer closed, room destroyed, explicit DELETE), `closeWhepSession` does not clear `iceDisconnectTimer` — it isn't reachable from the session object. The timer later fires and calls `closeWhepSession` again (idempotent, so harmless) but holds a timer and closured references for up to 30 s past teardown.

**Why it matters.** Minor: a bounded timer + retained transport/consumer references per churned WHEP session. Not a crash, but avoidable leak under WHEP churn.

**Fix.** Store `iceDisconnectTimer` on the `session` object and clear it in `closeWhepSession` alongside `connectTimer`.

---

## L-7 🟡 Stale cached `indexHtmlTemplate` — an updated build isn't served until restart

- **Severity:** Medium
- **Blocker:** No
- **Location:** `server.js:734-745` (`getIndexHtml` caches `indexHtmlTemplate` on first read and never invalidates), served at `:760-766`.

**Problem.** The SPA HTML is read from `dist/index.html` once and cached in-process. If a deploy replaces `dist/` while the server runs (rolling update, `npm run build` in place), clients keep getting the old HTML — which references old hashed asset filenames — until the process restarts. Combined with the immutable long-cache on `/assets/*` (`:754-757`), a mismatched old HTML + purged old assets can 404 the entry chunk. (The client has `installChunkLoadRecovery` in `main.jsx:6` which reloads on chunk errors, mitigating but not eliminating a reload loop if HTML stays stale.)

**Fix.** Either drop the cache (read per request — cost is negligible), or `fs.watch` the file and invalidate, or explicitly document "restart the server after a rebuild."

---

## L-8 🟡 Catch-all SPA route swallows unknown `/api/*` and `/whep/*` paths as HTML

- **Severity:** Medium
- **Blocker:** No
- **Location:** `server.js:760` (`app.get('/{*splat}', ...)`) mounted after the specific `/api/*` routes and static middleware; WHIP/WHEP routers mounted at `:1111,1117`.

**Problem.** The final catch-all returns `index.html` (200) for any unmatched GET. A typo'd or removed API path (`/api/metricz`) returns the SPA HTML with status 200 instead of a 404 JSON. Clients that `fetch('/api/...').then(r => r.json())` get an HTML body and a confusing parse error rather than a clean 404. WHEP/WHIP use non-GET verbs so are less affected, but any GET probe to a non-existent egress path yields HTML.

**Fix.** Add an `app.use('/api', ...)` (and `/whep`, `/whip`) 404 JSON fallback before the SPA catch-all, or scope the catch-all to exclude those prefixes.

---

## L-9 🟡 `create-recv-transport` can silently leak the previous transport's consumers on rapid re-calls

- **Severity:** Medium
- **Blocker:** No
- **Location:** `lib/socket.js:1392-1428`.

**Problem.** On `create-recv-transport` the handler closes the *previous* `viewerData` transport/consumers, then `await createWebRtcTransport`, then overwrites `room.viewerTransports.set(socket.id, {...})`. If two `create-recv-transport` calls interleave (viewer double-clicks Watch, or reconnect races the manual retry), the second call's `await` can resolve after the first has already stored its transport, and the first transport's consumers are replaced in the map without being closed. The client-side `activePlaybackAttemptRef` guards playback, but the *server* map only keeps the last write.

**Why it matters.** Bounded leak of a transport + consumers per racing re-entry until the room is destroyed. Contributes to `mediasoupConsumerCount` drift in metrics.

**Fix.** Capture-and-close by transport id rather than "the current viewerData"; or serialize per-socket transport creation with a small lock/flag like L-1.

---

## L-10 🟢 `getSocketBufferedBytes` reads a Socket.IO internal (`socket.conn.writeBuffer`) that can change shape

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/socket.js:501-512`, used by the relay backpressure caps at `:526,554`.

**Problem.** The slow-consumer protection depends on the private engine.io `writeBuffer` array shape. A Socket.IO/engine.io upgrade could change this field, silently disabling the backpressure cap (it defensively returns 0 if the array is missing, which *disables* protection rather than failing loud).

**Fix.** Add a unit test asserting the field exists on the installed version and/or track buffered bytes at the application layer (count bytes emitted vs. drained). At minimum, log once if the field is absent so a silent regression is visible.

---

## L-11 🟢 Circular `require` inside `destroyRoom`

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/rooms.js:241` (`const { closeAllWhepSessions } = require('./whepRoutes');` inside the function) and `lib/whip Routes`/`whepRoutes` requiring back into `rooms`/`socket`.

**Problem.** `rooms.js` requires `whepRoutes` lazily inside `destroyRoom` to dodge a load-time cycle (`socket.js` ↔ `whipRoutes.js` ↔ `rooms.js`). It works but signals tangled module boundaries; `startFallbackRelay`/`stopFallbackRelay` are likewise reached from `whipRoutes` via `require('./socket')`. Lazy requires hide the cycle from static analysis and make refactors risky.

**Fix.** Extract a small `mediaLifecycle`/`relayController` module that both `socket.js` and `whipRoutes.js` depend on, breaking the cycle so requires can move to file top. (Architectural — see `nice-to-haves.md`.)

---

## L-12 🟢 `emitToRelayViewers` mutates relay-audience membership while iterating a snapshot; WebM init reset can race

- **Severity:** Low
- **Blocker:** No
- **Location:** `lib/socket.js:514-540` (kicks slow viewers via `setViewerRelayMode(..., false)` mid-loop; iterates `[...room.relayViewers]` snapshot so the mutation is safe), and `setViewerRelayMode:486-489` clears `room.mediaInit`/`room.initChunk` when the set empties.

**Problem.** The iteration uses a copied array so concurrent modification is safe (good). But when the *last* relay viewer is kicked for slowness, `setViewerRelayMode` nulls `room.mediaInit`/`initChunk`; a viewer that reconnects immediately then gets `get-media-init` → `No media init available` until the host's recorder emits the next init. This is the intended "restart recorder on rejoin" design, but the window can produce a brief spurious error toast on the viewer.

**Fix.** Low priority; consider retaining the last init segment for a short grace period, or have the client treat "fallback-starting"/"no init yet" as a soft retry rather than an error (WatchView largely does — verify the WebM path parity with the fMP4 path).

---

## L-13 🟢 Host `frameRate`/quality changes restart the WebM relay recorder, re-initializing all relay viewers

- **Severity:** Low
- **Blocker:** No
- **Location:** `src/HostView.jsx:925-937` (effect restarts recorder on `qualityProfile`/`frameRate`/`relayFlushIntervalMs`/`effectiveRelayBitsPerSecond` change).

**Problem.** Any of these changes stops and restarts the `MediaRecorder`, emitting a fresh WebM init segment; every relay viewer must discard queued chunks and re-bootstrap (`WatchView.onMediaInit` at `:449` flushes stale chunks). Expected, but a host toggling 30↔60 fps mid-stream glitches all relay viewers. WebRTC viewers are handled more gracefully via `applyProducerBitrateProfile`.

**Fix.** Acceptable as-is; document that changing quality mid-stream briefly interrupts relay-mode viewers. If undesirable, debounce and/or only restart on codec-affecting changes.

---

## Production Blockers

These must be fixed (or explicitly accepted with a documented mitigation) before a public launch:

| # | Blocker | Severity | Why it blocks |
|---|---|---|---|
| **L-1** | Fallback-relay start race → duplicate FFmpeg pipelines + leaked interval/transports | 🔴 Critical | Corrupts OBS relay playback and leaks resources per room under normal timing. |
| **L-2** | No `unhandledRejection`/`uncaughtException` guard on server path | 🟠 High | One stray rejection takes down all rooms; not covered by worker auto-restart. |
| **L-3** | Shared `'public-share-proxy'` rate-limit bucket for all tunnel viewers | 🟠 High | Popular streams self-DoS through the tunnel; per-IP abuse control is defeated. (Cross-ref S-4.) |
| **S-1** | `/api/config` leaks HMAC TURN credentials to anonymous callers | 🔴 Critical | See `security-issues.md` — operator TURN bandwidth theft. |
| **L-5** | fMP4 player listener/object-URL leak across generations | 🟠 High | Memory + spurious state churn over long OBS sessions. |

Recommended launch posture if L-3/S-4 cannot be fixed immediately: keep the public tunnel **off by default** and document LAN/manual-reverse-proxy operation, which sidesteps the shared-bucket issue.
